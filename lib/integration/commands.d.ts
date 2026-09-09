import type { Context } from '@deepseek-ai/cordis';
import type { WikiGraph } from '../core/graph.js';
import type { WikiIndexer } from '../core/indexer.js';
import type { ProposalStore } from '../core/proposal-store.js';
import type { WikiScanner } from '../core/scanner.js';
export declare function registerWikiCommands(ctx: Context, wikiRoot: string, scanner: WikiScanner, indexer: WikiIndexer, graph: WikiGraph, proposalStore: ProposalStore): void;
