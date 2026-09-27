import type { HeadingItem, SectionSlice, WikiDoc, WikiFrontmatter, WikiLink } from '../types.js';
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
 * 格式化 mtimeMs 为 YYYY-MM-DD
 */
export declare function formatMtime(mtimeMs: number): string;
/**
 * 解析 Markdown 标题列表（包含层级、文本、行号），跳过代码块和 Frontmatter
 */
export declare function parseHeadings(markdown: string): HeadingItem[];
/**
 * 提取指定标题到下一个同级或更高级标题之间的正文内容
 */
export declare function extractSection(markdown: string, headingTitle: string): SectionSlice | null;
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
