import type { Context } from '@deepseek-ai/cordis';
import type { WikiIndexer } from '../core/indexer.js';
import type { ProposalStore } from '../core/proposal-store.js';
import type { SectionEntry } from '../core/sections.js';
export declare const WIKI_CONTEXT_SOURCE_KIND = "wiki-context";
/** 静态协议文本：通用写入/查阅约定，不含任何个人数据 */
export declare const WIKI_PROTOCOL_TEXT: string;
export interface WikiContextMessage {
    role: 'user';
    content: Array<{
        type: 'text';
        text: string;
    }>;
    source: {
        kind: typeof WIKI_CONTEXT_SOURCE_KIND;
        form: 'snapshot';
        hashes: Record<string, string>;
    };
}
export interface InjectorOptions {
    maxContextTokens?: number;
    requireApproval?: boolean;
}
/** 全量快照 -> 紧凑哈希对象（key -> 前 16 位 hex） */
export declare function compactHashes(snapshot: Map<string, SectionEntry>): Record<string, string>;
/** 基线消息：关于你 + 主题索引 + 读取指引；无有效词条时返回 null */
export declare function buildBaselineText(indexer: WikiIndexer, options?: InjectorOptions, pendingCount?: number): string | null;
/** 增量消息：仅包含与上次注入相比新增/变更/删除的小节；无变化时返回 null */
export declare function buildUpdateText(snapshot: Map<string, SectionEntry>, previous: Record<string, string>): string | null;
/**
 * 从会话日志中倒序查找最近一次注入的 wiki-context 消息；返回其 hashes，未找到返回 undefined。
 * 若该消息已被上下文压缩移出可见范围（不在 session.surface.nodes 中），视为未注入，
 * 以便重新发送基线——否则模型会只收到增量而丢失基线。
 */
export declare function findPreviousHashes(session: any): Record<string, string> | undefined;
/**
 * pre-step 决策：真实用户提问步才可能注入；首注入发基线，后续只发变更小节。
 * 任何异常都原样返回 decision，绝不阻断 agent 循环。
 */
export declare function decideInjection(payload: any, decision: any, indexer: WikiIndexer, proposalStore: ProposalStore | undefined, options?: InjectorOptions): any;
export declare function registerContextInjector(ctx: Context, indexer: WikiIndexer, proposalStore: ProposalStore, options?: InjectorOptions): void;
