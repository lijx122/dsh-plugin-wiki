import { basename, extname } from 'node:path';
/**
 * 极简健壮的 YAML Frontmatter 解析器（零第三方包依赖，纯原生）
 */
export function parseFrontmatter(raw) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!match) {
        return { frontmatter: {}, body: raw };
    }
    const yamlBlock = match[1] ?? '';
    const body = match[2] ?? '';
    const frontmatter = {};
    const lines = yamlBlock.split(/\r?\n/);
    let currentKey = null;
    let currentList = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        // 列表项检测 "- value"
        const listMatch = /^[ \t]*-[ \t]+(.*)$/.exec(line);
        if (listMatch && currentKey) {
            if (!currentList) {
                currentList = [];
                frontmatter[currentKey] = currentList;
            }
            currentList.push(stripQuotes(listMatch[1].trim()));
            continue;
        }
        // 键值对检测 "key: value"
        const kvMatch = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
        if (kvMatch) {
            currentKey = kvMatch[1].trim();
            currentList = null;
            const valStr = kvMatch[2].trim();
            if (valStr.startsWith('[') && valStr.endsWith(']')) {
                // 简单内联数组 [a, b, c]
                const items = valStr
                    .slice(1, -1)
                    .split(',')
                    .map((s) => stripQuotes(s.trim()))
                    .filter(Boolean);
                frontmatter[currentKey] = items;
            }
            else if (valStr.length > 0) {
                frontmatter[currentKey] = parseScalar(valStr);
            }
        }
    }
    return { frontmatter, body };
}
function stripQuotes(str) {
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
        return str.slice(1, -1);
    }
    return str;
}
function parseScalar(str) {
    const unquoted = stripQuotes(str);
    if (unquoted === 'true')
        return true;
    if (unquoted === 'false')
        return false;
    if (unquoted === 'null')
        return null;
    const num = Number(unquoted);
    if (!Number.isNaN(num) && unquoted !== '')
        return num;
    return unquoted;
}
/**
 * 提取双链 [[Target]] 或 [[Target|Alias]]
 */
export function extractWikiLinks(text) {
    const links = [];
    const regex = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
        const target = m[1].trim();
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
 * 提取 Markdown 标题列表与摘要
 */
export function extractHeadings(markdown) {
    const headings = [];
    const lines = markdown.split(/\r?\n/);
    for (const line of lines) {
        const m = /^(#{1,6})\s+(.+)$/.exec(line.trim());
        if (m && m[2]) {
            headings.push(m[2].trim());
        }
    }
    return headings;
}
/**
 * 提取文档摘要（优先提取 ## 摘要 内容，其次取第一段正文）
 */
export function extractSummary(markdown, maxLength = 240) {
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
    const paragraph = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            if (paragraph.length > 0)
                break;
            continue;
        }
        if (trimmed.startsWith('#') || trimmed.startsWith('---'))
            continue;
        paragraph.push(trimmed);
    }
    const text = cleanMarkdownFormatting(paragraph.join(' '));
    return text.slice(0, maxLength);
}
function cleanMarkdownFormatting(md) {
    return md
        .replace(/\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g, '$1') // 移除双链语法保留文字
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 移除普通链接语法
        .replace(/[*_`~#]/g, '') // 移除标记符号
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * 解析完整 Markdown 文档为 WikiDoc 结构
 */
export function parseWikiDoc(relPath, absPath, content, mtimeMs, sizeBytes) {
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
        if (dir.includes('project'))
            type = 'project';
        else if (dir.includes('decision'))
            type = 'decision';
        else if (dir.includes('prefer'))
            type = 'preference';
        else if (dir.includes('person') || dir.includes('people'))
            type = 'person';
        else if (dir.includes('asset'))
            type = 'asset';
        else
            type = 'general';
    }
    // 推断 Status
    const status = typeof frontmatter.status === 'string' && frontmatter.status.trim() ? frontmatter.status.trim() : 'active';
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
    };
}
