import { createHash } from 'node:crypto';
import { parseFrontmatter, parseHeadings } from './parser.js';
/** 首个 `## ` 之前的导言段落使用的伪标题 */
export const PREAMBLE_HEADING = '(导言)';
/**
 * 按二级标题切分 Markdown 正文（复用 parseHeadings，代码围栏内的 # 不算标题）。
 * 每个小节的范围是从标题下一行到下一个 level <= 2 的标题之前；
 * 首个二级标题之前的正文（剔除一级标题行后非空时）作为导言小节返回。
 */
export function splitLevel2Sections(markdown) {
    const { body } = parseFrontmatter(markdown);
    const lines = body.split(/\r?\n/);
    const headings = parseHeadings(body);
    const result = [];
    const boundaries = headings.filter((h) => h.level <= 2);
    const firstH2 = boundaries.find((h) => h.level === 2);
    // 导言：首个 ## 之前、剔除 # 一级标题行后的正文
    const preambleEnd = firstH2 ? firstH2.line - 1 : lines.length;
    const h1Lines = new Set(headings.filter((h) => h.level === 1 && h.line - 1 < preambleEnd).map((h) => h.line - 1));
    const preamble = lines
        .slice(0, preambleEnd)
        .filter((_l, idx) => !h1Lines.has(idx))
        .join('\n');
    if (normalizeSectionContent(preamble)) {
        result.push({ heading: PREAMBLE_HEADING, content: preamble });
    }
    for (let i = 0; i < boundaries.length; i++) {
        const h = boundaries[i];
        if (h.level !== 2)
            continue;
        const next = boundaries[i + 1];
        const end = next ? next.line - 1 : lines.length;
        result.push({ heading: h.text, content: lines.slice(h.line, end).join('\n') });
    }
    return result;
}
/** 归一化小节正文：去行尾空白、合并连续空行、去首尾空白 */
export function normalizeSectionContent(content) {
    return content
        .split(/\r?\n/)
        .map((l) => l.replace(/\s+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
export function sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** 计算单篇词条的二级小节指纹列表（纯函数） */
export function computeDocSections(doc) {
    const relPath = doc.relPath.replace(/\\/g, '/');
    const seen = new Map();
    const entries = [];
    for (const sec of splitLevel2Sections(doc.rawContent)) {
        const count = (seen.get(sec.heading) ?? 0) + 1;
        seen.set(sec.heading, count);
        const heading = count > 1 ? `${sec.heading} (${count})` : sec.heading;
        const content = normalizeSectionContent(sec.content);
        entries.push({
            key: `${relPath}#${heading}`,
            relPath,
            heading,
            hash: sha256(content),
            content,
        });
    }
    return entries;
}
/**
 * 检查二级标题结构问题：重复的 `##` 标题、正文为空的 `##` 小节。
 * 返回人类可读的问题描述列表（无问题时为空数组）。
 */
export function findHeadingIssues(markdown) {
    const sections = splitLevel2Sections(markdown).filter((s) => s.heading !== PREAMBLE_HEADING);
    const issues = [];
    const counts = new Map();
    for (const s of sections) {
        const k = s.heading.trim().toLowerCase();
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const dups = sections
        .map((s) => s.heading)
        .filter((h, idx, arr) => (counts.get(h.trim().toLowerCase()) ?? 0) > 1 && arr.findIndex((x) => x.trim().toLowerCase() === h.trim().toLowerCase()) === idx);
    if (dups.length > 0) {
        issues.push(`重复的二级标题: ${dups.map((h) => `## ${h}`).join('、')}（建议合并为一节）`);
    }
    const empties = sections.filter((s) => !normalizeSectionContent(s.content)).map((s) => s.heading);
    if (empties.length > 0) {
        issues.push(`正文为空的二级标题: ${empties.map((h) => `## ${h}`).join('、')}（建议补全或删除）`);
    }
    return issues;
}
