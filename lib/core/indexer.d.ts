import type { SearchMatch, WikiDoc } from '../types.js';
import type { WikiGraph } from './graph.js';
import { type SectionEntry } from './sections.js';
export declare class WikiIndexer {
    private graph;
    private indexedDocs;
    private typeMap;
    private sectionSnapshot;
    constructor(graph: WikiGraph);
    build(docs: WikiDoc[]): void;
    /**
     * 多维权重搜索词条
     */
    search(query: string, filterType?: string, limit?: number): SearchMatch[];
    /** 当前有效（未归档）词条：排除 Archive/ 目录与 status: archived */
    getActiveDocs(): WikiDoc[];
    /**
     * 全库二级小节指纹快照（key = `<relPath>#<heading>`），排除归档词条。
     * 结果按 build() 周期缓存，索引重建后自动失效。
     */
    getSectionSnapshot(): Map<string, SectionEntry>;
    /**
     * 生成紧凑的四段式 Agent 记忆档案（供 System Prompt 动态注入）
     * 1. 关于你 (Self.md)
     * 2. 活跃主题 (Topics/ 下条目 + 最近变更)
     * 3. 未整理线索 (待整理/)
     * 4. Agent 记忆总结 (Agent记忆总结.md / 记忆总结.md)
     */
    getBriefSummary(maxChars?: number): string;
}
export declare function isArchivedDoc(doc: WikiDoc): boolean;
