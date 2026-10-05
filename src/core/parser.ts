import { basename, extname } from 'node:path';
import type { HeadingItem, SectionSlice, WikiDoc, WikiFrontmatter, WikiLink } from '../types.js';

/**
 * 极简健壮的 YAML Frontmatter 解析器（零第三方包依赖，纯原生）
 */
export function parseFrontmatter(raw: string): { frontmatter: WikiFrontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const yamlBlock = match[1] ?? '';
  const body = match[2] ?? '';
  const frontmatter: WikiFrontmatter = {};

  const lines = yamlBlock.split(/\r?\n/);
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // 列表项检测 "- value"
    const listMatch = /^[ \t]*-[ \t]+(.*)$/.exec(line);
    if (listMatch && currentKey) {
      if (!currentList) {
        currentList = [];
        frontmatter[currentKey] = currentList;
      }
      currentList.push(stripQuotes(listMatch[1]!.trim()));
      continue;
    }

    // 键值对检测 "key: value"
    const kvMatch = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (kvMatch) {
      currentKey = kvMatch[1]!.trim();
      currentList = null;
      const valStr = kvMatch[2]!.trim();

      if (valStr.startsWith('[') && valStr.endsWith(']')) {
        // 简单内联数组 [a, b, c]
        const items = valStr
          .slice(1, -1)
          .split(',')
          .map((s) => stripQuotes(s.trim()))
          .filter(Boolean);
        frontmatter[currentKey] = items;
      } else if (valStr.length > 0) {
        frontmatter[currentKey] = parseScalar(valStr);
      }
    }
  }

  return { frontmatter, body };
}

function stripQuotes(str: string): string {
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }
  return str;
}

function parseScalar(str: string): unknown {
  const unquoted = stripQuotes(str);
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  if (unquoted === 'null') return null;
  const num = Number(unquoted);
  if (!Number.isNaN(num) && unquoted !== '') return num;
  return unquoted;
}

/**
 * 提取双链 [[Target]] 或 [[Target|Alias]]
 */
export function extractWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  const regex = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const target = m[1]!.trim();
    const alias = m[2]?.trim();
    links.push({
      raw: m[0],
      target,
      ...(alias ? { alias } : {}),
    });
  }
  return links;
}

/**
 * 格式化 mtimeMs 为 YYYY-MM-DD
 */
export function formatMtime(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 解析 Markdown 标题列表（包含层级、文本、行号），跳过代码块和 Frontmatter
 */
export function parseHeadings(markdown: string): HeadingItem[] {
  const headings: HeadingItem[] = [];
  const lines = markdown.split(/\r?\n/);

  let inFrontmatter = false;
  let inCodeFence: string | null = null;
  let codeFenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // 1. 处理 YAML Frontmatter（仅在文档起始有效）
    if (i === 0 && trimmed === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === '---' || trimmed === '...') {
        inFrontmatter = false;
      }
      continue;
    }

    // 2. 处理代码块围栏 (``` 或 ~~~)
    const fenceMatch = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1]![0]!;
      const fenceLen = fenceMatch[1]!.length;
      if (inCodeFence === null) {
        inCodeFence = fenceChar;
        codeFenceLen = fenceLen;
        continue;
      } else if (inCodeFence === fenceChar && fenceLen >= codeFenceLen) {
        // 闭合围栏
        inCodeFence = null;
        codeFenceLen = 0;
        continue;
      }
    }

    if (inCodeFence !== null) {
      // 在代码块内部，忽略任何 # 符号
      continue;
    }

    // 3. 匹配 Markdown 标题行: ^[ ]{0,3}(#{1,6})[ \t]+(.*)$
    const headingMatch = /^[ ]{0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    if (headingMatch && headingMatch[1]) {
      const level = headingMatch[1].length;
      const rawText = headingMatch[2] ?? '';
      const text = rawText.replace(/[ \t]+#+[ \t]*$/, '').trim();
      headings.push({
        level,
        text,
        line: i + 1,
      });
    }
  }

  return headings;
}

/**
 * 提取指定标题到下一个同级或更高级标题之间的正文内容
 */
export function extractSection(
  markdown: string,
  headingTitle: string
): SectionSlice | null {
  const cleanSearch = headingTitle.replace(/^#+\s*/, '').trim().toLowerCase();
  if (!cleanSearch) return null;

  const allHeadings = parseHeadings(markdown);
  if (allHeadings.length === 0) return null;

  // 1. 查找匹配的标题（优先级：完全匹配 -> 前缀匹配 -> 包含匹配 -> 逆向包含）
  let matched = allHeadings.find((h) => h.text.trim().toLowerCase() === cleanSearch);
  if (!matched) {
    matched = allHeadings.find((h) => h.text.trim().toLowerCase().startsWith(cleanSearch));
  }
  if (!matched) {
    matched = allHeadings.find((h) => h.text.trim().toLowerCase().includes(cleanSearch));
  }
  if (!matched) {
    matched = allHeadings.find((h) => cleanSearch.includes(h.text.trim().toLowerCase()));
  }

  if (!matched) return null;

  // 2. 确定正文范围：从该标题所在行的下一行开始，直到下一个同级或更高级标题（level <= matched.level）
  const lines = markdown.split(/\r?\n/);
  const matchedIdx = allHeadings.indexOf(matched);
  let endLineIdx = lines.length;

  for (let j = matchedIdx + 1; j < allHeadings.length; j++) {
    if (allHeadings[j]!.level <= matched.level) {
      endLineIdx = allHeadings[j]!.line - 1;
      break;
    }
  }

  const sectionLines = lines.slice(matched.line, endLineIdx);
  const content = sectionLines.join('\n').trim();

  return {
    found: true,
    title: matched.text,
    level: matched.level,
    content,
  };
}

/**
 * 提取 Markdown 标题列表与摘要
 */
export function extractHeadings(markdown: string): string[] {
  return parseHeadings(markdown).map((h) => h.text);
}

/**
 * 提取文档摘要（优先提取 ## 摘要 内容，其次取第一段正文）
 */
export function extractSummary(markdown: string, maxLength = 240): string {
  // 查找 ## 摘要 节
  const abstractMatch = /##\s*摘要\s*\r?\n([\s\S]*?)(?=\n##|$)/i.exec(markdown);
  if (abstractMatch && abstractMatch[1]) {
    const text = cleanMarkdownFormatting(abstractMatch[1]);
    if (text.length > 0) {
      return text.slice(0, maxLength);
    }
  }

  // 取正文首个有效非标题段落
  const lines = markdown.split(/\r?\n/);
  const paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
    paragraph.push(trimmed);
  }

  const text = cleanMarkdownFormatting(paragraph.join(' '));
  return text.slice(0, maxLength);
}

function cleanMarkdownFormatting(md: string): string {
  return md
    .replace(/\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g, '$1') // 移除双链语法保留文字
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')           // 移除普通链接语法
    .replace(/[*_`~#]/g, '')                           // 移除标记符号
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析完整 Markdown 文档为 WikiDoc 结构
 */
export function parseWikiDoc(
  relPath: string,
  absPath: string,
  content: string,
  mtimeMs: number,
  sizeBytes: number
): WikiDoc {
  const { frontmatter, body } = parseFrontmatter(content);
  const headings = extractHeadings(body);
  const links = extractWikiLinks(content);
  const summary = extractSummary(body);

  // 推断 Title
  let title = typeof frontmatter.title === 'string' && frontmatter.title.trim() ? frontmatter.title.trim() : '';
  if (!title) {
    const firstH1 = headings.find((h) => h.length > 0);
    title = firstH1 || basename(relPath, extname(relPath));
  }

  // 推断 Type
  let type = typeof frontmatter.type === 'string' && frontmatter.type.trim() ? frontmatter.type.trim() : '';
  if (!type) {
    const dir = relPath.split(/[/\\]/)[0]?.toLowerCase() ?? '';
    if (dir.includes('project')) type = 'project';
    else if (dir.includes('decision')) type = 'decision';
    else if (dir.includes('prefer')) type = 'preference';
    else if (dir.includes('person') || dir.includes('people')) type = 'person';
    else if (dir.includes('asset')) type = 'asset';
    else type = 'general';
  }

  // 推断 Status
  const status = typeof frontmatter.status === 'string' && frontmatter.status.trim() ? frontmatter.status.trim() : 'active';

  // 提取 updatedAt 时效性元数据（优先 frontmatter，缺省退回文件修改时间 mtime YYYY-MM-DD）
  let updatedAt: string | undefined = undefined;
  if (frontmatter.updated_at) {
    updatedAt = String(frontmatter.updated_at).trim();
  } else if (frontmatter.updatedAt) {
    updatedAt = String(frontmatter.updatedAt).trim();
  } else if (frontmatter.updated) {
    updatedAt = String(frontmatter.updated).trim();
  }
  if (!updatedAt && mtimeMs > 0) {
    updatedAt = formatMtime(mtimeMs);
  }

  // 提取 supersedes 版本替代关系元数据
  let supersedes: string[] | undefined = undefined;
  const rawSupersedes = frontmatter.supersedes ?? frontmatter.supersede;
  if (Array.isArray(rawSupersedes)) {
    supersedes = rawSupersedes.map((s) => String(s).trim()).filter(Boolean);
  } else if (typeof rawSupersedes === 'string' && rawSupersedes.trim()) {
    supersedes = [rawSupersedes.trim()];
  }

  return {
    relPath: relPath.replace(/\\/g, '/'),
    absPath,
    mtimeMs,
    sizeBytes,
    frontmatter,
    title,
    type,
    status,
    links,
    headings,
    summary,
    rawContent: content,
    ...(updatedAt ? { updatedAt } : {}),
    ...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
  };
}

/**
 * 根据相对路径的一级目录推导词条类型 (type)
 * 如 Topics -> topic、待整理 -> inbox、Agent -> agent，推导不出来用 general
 */
export function inferDocTypeFromPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/');
  if (parts.length <= 1) {
    return 'general';
  }
  const firstDir = parts[0]!.trim();
  const lower = firstDir.toLowerCase();

  if (firstDir === '待整理' || lower === 'inbox') return 'inbox';
  if (lower === 'topics' || lower === 'topic') return 'topic';
  if (lower === 'agent' || lower === 'agents') return 'agent';
  if (lower === 'project' || lower === 'projects') return 'project';
  if (lower === 'decision' || lower === 'decisions') return 'decision';
  if (lower === 'preference' || lower === 'preferences') return 'preference';
  if (lower === 'person' || lower === 'people') return 'person';
  if (lower === 'asset' || lower === 'assets') return 'asset';

  return 'general';
}

/**
 * 就地替换 Markdown 文档中指定小节的正文
 * 若找到对应小节，替换从该标题下一行开始、到下一个同级或更高级标题之前的内容
 */
export function replaceSection(
  markdown: string,
  sectionTitle: string,
  newContent: string
): { replaced: boolean; content: string } {
  const cleanSearch = sectionTitle.replace(/^#+\s*/, '').trim().toLowerCase();
  if (!cleanSearch) return { replaced: false, content: markdown };

  const allHeadings = parseHeadings(markdown);
  if (allHeadings.length === 0) return { replaced: false, content: markdown };

  // 匹配标题（优先级：完全匹配 -> 前缀匹配 -> 包含匹配 -> 逆向包含）
  let matched = allHeadings.find((h) => h.text.trim().toLowerCase() === cleanSearch);
  if (!matched) {
    matched = allHeadings.find((h) => h.text.trim().toLowerCase().startsWith(cleanSearch));
  }
  if (!matched) {
    matched = allHeadings.find((h) => h.text.trim().toLowerCase().includes(cleanSearch));
  }
  if (!matched) {
    matched = allHeadings.find((h) => cleanSearch.includes(h.text.trim().toLowerCase()));
  }

  if (!matched) return { replaced: false, content: markdown };

  const lines = markdown.split(/\r?\n/);
  const matchedIdx = allHeadings.indexOf(matched);
  let endLineIdx = lines.length;

  for (let j = matchedIdx + 1; j < allHeadings.length; j++) {
    if (allHeadings[j]!.level <= matched.level) {
      endLineIdx = allHeadings[j]!.line - 1;
      break;
    }
  }

  // 标题所在行为 lines[matched.line - 1]
  const before = lines.slice(0, matched.line).join('\n');
  const after = lines.slice(endLineIdx).join('\n');

  // 如果 newContent 开头本身已经包含了该标题行，去掉避免重复
  let body = newContent.trim();
  const firstLine = body.split(/\r?\n/)[0] || '';
  const firstLineHeadingMatch = /^#{1,6}\s+(.*)$/.exec(firstLine);
  if (
    firstLineHeadingMatch &&
    firstLineHeadingMatch[1] &&
    firstLineHeadingMatch[1].trim().toLowerCase() === matched.text.trim().toLowerCase()
  ) {
    body = body.slice(firstLine.length).trim();
  }

  let finalContent = before;
  if (body) {
    finalContent += `\n\n${body}`;
  }
  if (after.trim()) {
    finalContent += `\n\n${after.trimStart()}`;
  } else {
    finalContent += '\n';
  }

  return { replaced: true, content: finalContent };
}

