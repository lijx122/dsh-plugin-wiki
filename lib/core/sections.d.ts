import type { WikiDoc } from '../types.js';
/** 一个二级小节（`## `）的内容指纹 */
export interface SectionEntry {
    /** `<relPath>#<heading>`，同一文件内重名小节追加 ` (2)`、` (3)` 区分 */
    key: string;
    relPath: string;
    heading: string;
    /** 归一化正文的 sha256（完整 64 位 hex） */
    hash: string;
    /** 归一化后的小节正文（不含 `## ` 标题行本身） */
    content: string;
}
/** 首个 `## ` 之前的导言段落使用的伪标题 */
export declare const PREAMBLE_HEADING = "(\u5BFC\u8A00)";
interface RawSection {
    heading: string;
    content: string;
}
/**
 * 按二级标题切分 Markdown 正文（复用 parseHeadings，代码围栏内的 # 不算标题）。
 * 每个小节的范围是从标题下一行到下一个 level <= 2 的标题之前；
 * 首个二级标题之前的正文（剔除一级标题行后非空时）作为导言小节返回。
 */
export declare function splitLevel2Sections(markdown: string): RawSection[];
/** 归一化小节正文：去行尾空白、合并连续空行、去首尾空白 */
export declare function normalizeSectionContent(content: string): string;
export declare function sha256(text: string): string;
/** 计算单篇词条的二级小节指纹列表（纯函数） */
export declare function computeDocSections(doc: Pick<WikiDoc, 'relPath' | 'rawContent'>): SectionEntry[];
/**
 * 检查二级标题结构问题：重复的 `##` 标题、正文为空的 `##` 小节。
 * 返回人类可读的问题描述列表（无问题时为空数组）。
 */
export declare function findHeadingIssues(markdown: string): string[];
export {};
