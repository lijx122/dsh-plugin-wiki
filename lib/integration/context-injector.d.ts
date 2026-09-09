import type { Context } from '@deepseek-ai/cordis';
import type { WikiIndexer } from '../core/indexer.js';
import type { ProposalStore } from '../core/proposal-store.js';
export declare function registerContextInjector(ctx: Context, indexer: WikiIndexer, proposalStore: ProposalStore, maxContextTokens?: number): void;
