import type { WikiGraph } from '../core/graph.js';
import type { WikiIndexer } from '../core/indexer.js';
import type { ProposalStore } from '../core/proposal-store.js';
import type { WikiScanner } from '../core/scanner.js';
export declare function createWikiTools(wikiRoot: string, scanner: WikiScanner, indexer: WikiIndexer, graph: WikiGraph, proposalStore: ProposalStore): import("@deepseek-ai/dsh-tools").ToolDefinition[];
