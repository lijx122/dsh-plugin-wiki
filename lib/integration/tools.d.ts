import type { WikiGraph } from '../core/graph.js';
import type { WikiIndexer } from '../core/indexer.js';
import type { ProposalStore } from '../core/proposal-store.js';
import type { WikiScanner } from '../core/scanner.js';
import { SessionLinksIndex } from '../core/session-links.js';
import { SessionScanner } from '../core/session-scanner.js';
export declare function createWikiTools(wikiRoot: string, scanner: WikiScanner, indexer: WikiIndexer, graph: WikiGraph, proposalStore: ProposalStore, options?: {
    requireApproval?: boolean;
} | boolean, sessionScanner?: SessionScanner, sessionLinks?: SessionLinksIndex): import("@deepseek-ai/dsh-tools").ToolDefinition[];
