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
     * 生成紧凑的用户长期记忆与上下文摘要（供 System Prompt 动态注入）
     */
    getBriefSummary(maxChars?: number): string;
}
