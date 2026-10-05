import type { SearchMatch, WikiDoc } from '../types.js';
import type { WikiGraph } from './graph.js';
export declare class WikiIndexer {
    private graph;
    private indexedDocs;
    private typeMap;
    constructor(graph: WikiGraph);
    build(docs: WikiDoc[]): void;
    /**
     * 多维权重搜索词条
     */
    search(query: string, filterType?: string, limit?: number): SearchMatch[];
    /**
     * 生成紧凑的四段式 Agent 记忆档案（供 System Prompt 动态注入）
     * 1. 关于你 (Self.md)
     * 2. 活跃主题 (Topics/ 下条目 + 最近变更)
     * 3. 未整理线索 (待整理/)
     * 4. 交接记忆 (Agent/记忆.md)
     */
    getBriefSummary(maxChars?: number): string;
}
