import type { WikiDoc, WikiFrontmatter, WikiLink } from '../types.js';
/**
 * 极简健壮的 YAML Frontmatter 解析器（零第三方包依赖，纯原生）
 */
export declare function parseFrontmatter(raw: string): {
    frontmatter: WikiFrontmatter;
    body: string;
};
/**
 * 提取双链 [[Target]] 或 [[Target|Alias]]
 */
export declare function extractWikiLinks(text: string): WikiLink[];
/**
 * 提取 Markdown 标题列表与摘要
 */
export declare function extractHeadings(markdown: string): string[];
/**
 * 提取文档摘要（优先提取 ## 摘要 内容，其次取第一段正文）
 */
export declare function extractSummary(markdown: string, maxLength?: number): string;
/**
 * 解析完整 Markdown 文档为 WikiDoc 结构
 */
export declare function parseWikiDoc(relPath: string, absPath: string, content: string, mtimeMs: number, sizeBytes: number): WikiDoc;
