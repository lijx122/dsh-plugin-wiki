import type { SearchMatch, WikiDoc } from '../types.js';
import type { WikiGraph } from './graph.js';

interface IndexedDoc {
  doc: WikiDoc;
  tokens: Set<string>;
}

export class WikiIndexer {
  private indexedDocs: Map<string, IndexedDoc> = new Map();
  private typeMap: Map<string, Set<string>> = new Map();

  constructor(private graph: WikiGraph) {}

  build(docs: WikiDoc[]): void {
    this.indexedDocs.clear();
    this.typeMap.clear();

    for (const doc of docs) {
      const tokens = tokenize(`${doc.title} ${doc.headings.join(' ')} ${doc.summary} ${(doc.frontmatter.tags ?? []).join(' ')}`);
      this.indexedDocs.set(doc.relPath, { doc, tokens });

      const t = doc.type.toLowerCase();
      if (!this.typeMap.has(t)) {
        this.typeMap.set(t, new Set());
      }
      this.typeMap.get(t)!.add(doc.relPath);
    }
  }

  /**
   * 多维权重搜索词条
   */
  search(query: string, filterType?: string, limit = 10): SearchMatch[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const qTokens = Array.from(tokenize(q));
    const results: SearchMatch[] = [];

    const targetDocs: IndexedDoc[] = [];
    if (filterType && this.typeMap.has(filterType.toLowerCase())) {
      const allowed = this.typeMap.get(filterType.toLowerCase())!;
      for (const rel of allowed) {
        const item = this.indexedDocs.get(rel);
        if (item) targetDocs.push(item);
      }
    } else {
      targetDocs.push(...this.indexedDocs.values());
    }

    for (const { doc, tokens } of targetDocs) {
      let score = 0;
      const lowerTitle = doc.title.toLowerCase();
      const lowerRel = doc.relPath.toLowerCase();

      // 1. 标题完全或包含匹配
      if (lowerTitle === q || lowerRel === q) {
        score += 20;
      } else if (lowerTitle.includes(q)) {
        score += 10;
      } else if (lowerRel.includes(q)) {
        score += 6;
      }

      // 2. 标签与别名匹配
      const tags = (doc.frontmatter.tags ?? []).map((t) => String(t).toLowerCase());
      if (tags.some((t) => t === q || t.includes(q))) {
        score += 5;
      }

      // 3. Token 倒排与重合度匹配
      for (const qt of qTokens) {
        if (tokens.has(qt)) {
          score += 2;
        }
      }

      // 4. 正文模糊包含
      if (doc.rawContent.toLowerCase().includes(q)) {
        score += 1;
      }

      if (score > 0) {
        let updatedAt = doc.updatedAt;
        if (!updatedAt && doc.mtimeMs > 0) {
          const d = new Date(doc.mtimeMs);
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          updatedAt = `${year}-${month}-${day}`;
        }

        results.push({
          relPath: doc.relPath,
          title: doc.title,
          type: doc.type,
          status: doc.status,
          excerpt: doc.summary || doc.rawContent.slice(0, 160).replace(/\s+/g, ' '),
          score,
          forwardLinks: this.graph.getForwardLinks(doc.relPath),
          backLinks: this.graph.getBackLinks(doc.relPath),
          updatedAt,
          supersedes: doc.supersedes,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * 生成紧凑的四段式 Agent 记忆档案（供 System Prompt 动态注入）
   * 1. 关于你 (Self.md)
   * 2. 活跃主题 (Topics/ 下条目 + 最近变更)
   * 3. 未整理线索 (待整理/)
   * 4. 交接记忆 (Agent/记忆.md)
   */
  getBriefSummary(maxChars = 2500): string {
    const docs = Array.from(this.indexedDocs.values()).map((i) => i.doc);
    if (docs.length === 0) {
      return '';
    }

    const lines: string[] = [];
    lines.push('### Agent 记忆档案');

    // 1. 关于你：Self.md（若不存在则跳过）
    const selfDoc = docs.find((d) => {
      const lower = d.relPath.toLowerCase();
      return lower === 'self.md' || lower.endsWith('/self.md');
    });
    if (selfDoc) {
      lines.push('**关于你**：');
      const text = extractBodyText(selfDoc.rawContent, selfDoc.summary);
      lines.push(text.slice(0, 200));
    }

    // 2. 活跃主题：Topics/ 下条目列表（标题 + status + 摘要片段），外加最近变更若干条（按 updatedAt 倒序，标注 [更新: YYYY-MM-DD]）
    const topicDocs = docs.filter((d) => d.relPath.toLowerCase().startsWith('topics/'));
    const sortedByRecent = [...docs].sort((a, b) => {
      const ua = a.updatedAt || '';
      const ub = b.updatedAt || '';
      if (ua && ub && ua !== ub) return ub.localeCompare(ua);
      return (b.mtimeMs || 0) - (a.mtimeMs || 0);
    });

    const activeLines: string[] = [];
    const shownPaths = new Set<string>();
    if (topicDocs.length > 0) {
      for (const t of topicDocs.slice(0, 6)) {
        const excerpt = t.summary ? t.summary.slice(0, 60) : t.rawContent.slice(0, 60).replace(/\s+/g, ' ');
        const dateStr = t.updatedAt ? ` [更新: ${t.updatedAt}]` : '';
        activeLines.push(`- **${t.title}** [${t.status}]${dateStr}: ${excerpt}`);
        shownPaths.add(t.relPath);
      }
    }

    // 3. 未整理线索：待整理/ 下条目清单（仅标题 + 摘要片段，控制体积）
    const inboxDocs = docs.filter(isInboxDoc);
    // 4. 交接记忆：Agent/记忆.md 的正文（跨会话交接点、未闭环事项）
    const memoryDoc = docs.find(isMemoryDoc);

    for (const d of inboxDocs.slice(0, 5)) shownPaths.add(d.relPath);
    if (selfDoc) shownPaths.add(selfDoc.relPath);
    if (memoryDoc) shownPaths.add(memoryDoc.relPath);

    // 最近变更若干条：只保留未在前三段出现过的条目，避免重复堆叠（按 updatedAt 倒序）
    const recentCandidates = sortedByRecent
      .filter((d) => !shownPaths.has(d.relPath))
      .slice(0, 4);
    if (recentCandidates.length > 0) {
      if (topicDocs.length > 0) {
        activeLines.push('最近变更：');
      }
      for (const r of recentCandidates) {
        const dateStr = r.updatedAt ? ` [更新: ${r.updatedAt}]` : '';
        const excerpt = r.summary ? r.summary.slice(0, 50) : r.rawContent.slice(0, 50).replace(/\s+/g, ' ');
        activeLines.push(`- **${r.title}**${dateStr}: ${excerpt}`);
      }
    }

    if (activeLines.length > 0) {
      lines.push('**活跃主题**：');
      lines.push(...activeLines);
    }

    if (inboxDocs.length > 0) {
      lines.push('**未整理线索**：');
      for (const item of inboxDocs.slice(0, 5)) {
        const excerpt = item.summary ? item.summary.slice(0, 50) : item.rawContent.slice(0, 50).replace(/\s+/g, ' ');
        lines.push(`- **${item.title}**: ${excerpt}`);
      }
    }

    if (memoryDoc) {
      lines.push('**交接记忆**：');
      const text = extractBodyText(memoryDoc.rawContent, memoryDoc.summary);
      lines.push(text.slice(0, 200));
    }

    const full = lines.join('\n');
    if (full.length > maxChars) {
      return `${full.slice(0, maxChars)}...\n(已截断，请通过 wiki_search 工具查询详细信息)`;
    }
    return full;
  }
}

/**
 * 提取词条正文纯文本：剥离 Frontmatter、首行一级标题与 Markdown 标记
 */
function extractBodyText(rawContent: string, fallback: string): string {
  const body = rawContent
    .replace(/^---[\s\S]*?---\r?\n?/, '')
    .replace(/^\s*#\s+[^\n]*\r?\n/, '')
    .replace(/[*_`~#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return body || fallback;
}

function isInboxDoc(doc: WikiDoc): boolean {
  const normalized = doc.relPath.replace(/\\/g, '/');
  return normalized.startsWith('待整理/') || normalized.toLowerCase().startsWith('inbox/');
}

function isMemoryDoc(doc: WikiDoc): boolean {
  const normalized = doc.relPath.replace(/\\/g, '/');
  return normalized === 'Agent/记忆.md' || normalized.toLowerCase() === 'agent/记忆.md';
}

/**
 * 原生中英文混合分词（支持英文词项与中文 1-gram / 2-gram）
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const cleaned = text.toLowerCase();

  // 1. 英文与数字词项
  const words = cleaned.match(/[a-z0-9_-]+/g);
  if (words) {
    for (const w of words) {
      if (w.length >= 2) tokens.add(w);
    }
  }

  // 2. 中文连续汉字分词
  const hanziBlocks = cleaned.match(/[\u4e00-\u9fa5]+/g);
  if (hanziBlocks) {
    for (const block of hanziBlocks) {
      if (block.length === 1) {
        tokens.add(block);
      } else {
        // 单字与双字滑动窗口
        for (let i = 0; i < block.length; i++) {
          tokens.add(block[i]!);
          if (i + 1 < block.length) {
            tokens.add(block.slice(i, i + 2));
          }
        }
      }
    }
  }

  return tokens;
}
