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
        results.push({
          relPath: doc.relPath,
          title: doc.title,
          type: doc.type,
          status: doc.status,
          excerpt: doc.summary || doc.rawContent.slice(0, 160).replace(/\s+/g, ' '),
          score,
          forwardLinks: this.graph.getForwardLinks(doc.relPath),
          backLinks: this.graph.getBackLinks(doc.relPath),
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * 生成紧凑的用户长期记忆与上下文摘要（供 System Prompt 动态注入）
   */
  getBriefSummary(maxChars = 2500): string {
    const docs = Array.from(this.indexedDocs.values()).map((i) => i.doc);
    if (docs.length === 0) {
      return '';
    }

    const projects = docs.filter((d) => d.type === 'project');
    const preferences = docs.filter((d) => d.type === 'preference');
    const decisions = docs.filter((d) => d.type === 'decision');
    const persons = docs.filter((d) => d.type === 'person');

    const lines: string[] = [];
    lines.push('### 个人长期 Wiki 认知档案');

    if (projects.length > 0) {
      lines.push('**重点项目与技术栈**：');
      for (const p of projects.slice(0, 6)) {
        const links = this.graph.getForwardLinks(p.relPath);
        const linkStr = links.length > 0 ? ` (关联: ${links.map((l) => l.split('/').pop()?.replace('.md', '')).join(', ')})` : '';
        lines.push(`- **${p.title}** [${p.status}]: ${p.summary.slice(0, 70)}${linkStr}`);
      }
    }

    if (preferences.length > 0) {
      lines.push('**核心偏好与决策准则**：');
      for (const pref of preferences.slice(0, 5)) {
        lines.push(`- **${pref.title}**: ${pref.summary.slice(0, 80)}`);
      }
    }

    if (decisions.length > 0) {
      lines.push('**重要技术决策**：');
      for (const d of decisions.slice(0, 4)) {
        lines.push(`- **${d.title}**: ${d.summary.slice(0, 70)}`);
      }
    }

    if (persons.length > 0) {
      lines.push('**关键人际网络与组织**：');
      for (const per of persons.slice(0, 3)) {
        lines.push(`- **${per.title}**: ${per.summary.slice(0, 60)}`);
      }
    }

    const full = lines.join('\n');
    if (full.length > maxChars) {
      return `${full.slice(0, maxChars)}...\n(已截断，请通过 wiki_search 工具查询详细信息)`;
    }
    return full;
  }
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
