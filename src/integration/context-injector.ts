import type { Context } from '@deepseek-ai/cordis';
import type { WikiIndexer } from '../core/indexer.js';
import type { ProposalStore } from '../core/proposal-store.js';
import type { SectionEntry } from '../core/sections.js';
import type { WikiDoc } from '../types.js';

export const WIKI_CONTEXT_SOURCE_KIND = 'wiki-context';

const HASH_PREFIX_LEN = 16;
const SELF_CAP = 200;
const TOPIC_BRIEF_CAP = 80;
const TOPIC_MAX_LINES = 12;
const UPDATE_SECTION_CAP = 600;
const UPDATE_TOTAL_CAP = 2400;
const TRUNC_MARK = '…（截断，完整内容用 wiki_read 读取）';

/** 静态协议文本：通用写入/查阅约定，不含任何个人数据 */
export const WIKI_PROTOCOL_TEXT = [
  '[Wiki 记忆协议]',
  '- 涉及用户长期背景、项目演化或过往决策时，先用 `wiki_search` 定位，再用 `wiki_read` 按需读取小节。',
  '- 只用 `wiki_write` 记录相对稳定的事实与决策，不记录高频变动的数值。',
  '- 用户最新说法与 Wiki 矛盾时，以最新说法为准，当场就地修正对应小节。',
  '- 主题词条保持 `## 当前状态` 一节作为当前结论的唯一来源，用小节替换（`section` 参数）更新。',
  '- 用平实的陈述句书写，不用修辞。',
].join('\n');

export interface WikiContextMessage {
  role: 'user';
  content: Array<{ type: 'text'; text: string }>;
  source: { kind: typeof WIKI_CONTEXT_SOURCE_KIND; form: 'snapshot'; hashes: Record<string, string> };
}

export interface InjectorOptions {
  maxContextTokens?: number;
  requireApproval?: boolean;
}

function wrap(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isSelfDoc(doc: WikiDoc): boolean {
  const lower = doc.relPath.toLowerCase();
  return lower === 'self.md' || lower.endsWith('/self.md');
}

/** 全量快照 -> 紧凑哈希对象（key -> 前 16 位 hex） */
export function compactHashes(snapshot: Map<string, SectionEntry>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of snapshot) {
    out[key] = entry.hash.slice(0, HASH_PREFIX_LEN);
  }
  return out;
}

function makeMessage(text: string, hashes: Record<string, string>): WikiContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: WIKI_CONTEXT_SOURCE_KIND, form: 'snapshot', hashes },
  };
}

/** 基线消息：关于你 + 主题索引 + 读取指引；无有效词条时返回 null */
export function buildBaselineText(
  indexer: WikiIndexer,
  options: InjectorOptions = {},
  pendingCount = 0
): string | null {
  const docs = indexer.getActiveDocs();
  if (docs.length === 0) return null;

  const lines: string[] = [];
  const selfDoc = docs.find(isSelfDoc);
  if (selfDoc) {
    const text = oneLine(selfDoc.summary || '');
    if (text) lines.push(`关于你：${cap(text, SELF_CAP)}`);
  }

  const topics = docs
    .filter((d) => d.relPath.toLowerCase().startsWith('topics/'))
    .sort((a, b) => {
      const ua = a.updatedAt || '';
      const ub = b.updatedAt || '';
      if (ua !== ub) return ub.localeCompare(ua);
      return a.relPath.localeCompare(b.relPath);
    });
  if (topics.length > 0) {
    lines.push('主题索引：');
    for (const t of topics.slice(0, TOPIC_MAX_LINES)) {
      const updated = t.updatedAt ? ` (${t.updatedAt})` : '';
      const brief = cap(oneLine(t.summary || ''), TOPIC_BRIEF_CAP);
      lines.push(`- ${t.title} [${t.status}]${updated}${brief ? `: ${brief}` : ''}`);
    }
    if (topics.length > TOPIC_MAX_LINES) {
      lines.push(`- …另有 ${topics.length - TOPIC_MAX_LINES} 个主题，用 wiki_search 查找`);
    }
  }

  lines.push('完整内容通过 wiki_read / wiki_search 获取；本会话后续 Wiki 变更会以小节更新的形式另行告知。');

  if (options.requireApproval && pendingCount > 0) {
    lines.push(`当前有 ${pendingCount} 条待确认的 Wiki 变更提案，可通过 /wiki list 查看。`);
  }

  const maxChars = Math.max(400, Math.floor((options.maxContextTokens ?? 1500) * 2.5));
  let text = lines.join('\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n${TRUNC_MARK}`;
  }
  return wrap(text);
}

function describeKey(key: string): string {
  const idx = key.indexOf('.md#');
  if (idx < 0) return key;
  return `${key.slice(0, idx + 3)} § ${key.slice(idx + 4)}`;
}

/** 增量消息：仅包含与上次注入相比新增/变更/删除的小节；无变化时返回 null */
export function buildUpdateText(
  snapshot: Map<string, SectionEntry>,
  previous: Record<string, string>
): string | null {
  const changed: SectionEntry[] = [];
  for (const [key, entry] of snapshot) {
    if (previous[key] !== entry.hash.slice(0, HASH_PREFIX_LEN)) changed.push(entry);
  }
  const removed = Object.keys(previous).filter((k) => !snapshot.has(k));
  if (changed.length === 0 && removed.length === 0) return null;

  const header = 'Wiki 有更新（以下为变更的小节最新内容）：';
  const parts: string[] = [header];
  let used = header.length;
  const overflow: string[] = [];

  for (const entry of changed) {
    let body = entry.content || '（空）';
    if (body.length > UPDATE_SECTION_CAP) {
      body = `${body.slice(0, UPDATE_SECTION_CAP)}${TRUNC_MARK}`;
    }
    const block = `### ${entry.relPath} § ${entry.heading}\n${body}`;
    if (used + block.length + 2 > UPDATE_TOTAL_CAP) {
      overflow.push(entry.key);
      continue;
    }
    parts.push(block);
    used += block.length + 2;
  }

  if (removed.length > 0) {
    const removedLines = ['已删除的小节：', ...removed.map((k) => `- ${describeKey(k)}`)];
    parts.push(removedLines.join('\n'));
  }

  if (overflow.length > 0) {
    parts.push(['以下小节也有变更，内容超出篇幅，用 wiki_read 读取：', ...overflow.map((k) => `- ${describeKey(k)}`)].join('\n'));
  }

  return wrap(parts.join('\n\n'));
}

/**
 * 从会话日志中倒序查找最近一次注入的 wiki-context 消息；返回其 hashes，未找到返回 undefined。
 * 若该消息已被上下文压缩移出可见范围（不在 session.surface.nodes 中），视为未注入，
 * 以便重新发送基线——否则模型会只收到增量而丢失基线。
 */
export function findPreviousHashes(session: any): Record<string, string> | undefined {
  const seq: number = session.seq;
  const nodes = session.surface?.nodes;
  const visible: Set<number> | undefined = nodes ? new Set(nodes as Iterable<number>) : undefined;
  for (let i = seq - 1; i >= 0; i--) {
    const ev = session.eventAt(i);
    if (ev?.type === 'user/message' && ev.data?.source?.kind === WIKI_CONTEXT_SOURCE_KIND) {
      if (visible && !visible.has(ev.seq ?? i)) return undefined;
      const hashes = ev.data.source.hashes;
      return hashes && typeof hashes === 'object' ? (hashes as Record<string, string>) : {};
    }
  }
  return undefined;
}

/**
 * pre-step 决策：真实用户提问步才可能注入；首注入发基线，后续只发变更小节。
 * 任何异常都原样返回 decision，绝不阻断 agent 循环。
 */
export function decideInjection(
  payload: any,
  decision: any,
  indexer: WikiIndexer,
  proposalStore: ProposalStore | undefined,
  options: InjectorOptions = {}
): any {
  if (!decision || decision.kind !== 'enter') return decision;
  try {
    const messages: any[] = Array.isArray(payload?.messages) ? payload.messages : [];
    if (!messages.some((m) => m?.source?.kind === 'user')) return decision;

    const session = payload?.agent?.session;
    if (!session) return decision;

    const previous = findPreviousHashes(session);
    const snapshot = indexer.getSectionSnapshot();

    let text: string | null;
    if (previous === undefined) {
      const pending = options.requireApproval && proposalStore ? proposalStore.listPending().length : 0;
      text = buildBaselineText(indexer, options, pending);
    } else {
      text = buildUpdateText(snapshot, previous);
    }
    if (!text) return decision;

    const msg = makeMessage(text, compactHashes(snapshot));
    const existing = Array.isArray(decision.messages) ? decision.messages : [];
    return { ...decision, messages: [...existing, msg] };
  } catch {
    return decision;
  }
}

export function registerContextInjector(
  ctx: Context,
  indexer: WikiIndexer,
  proposalStore: ProposalStore,
  options: InjectorOptions = {}
): void {
  // 静态协议文本：随系统提示词常驻，内容不随 Wiki 变化，不破坏前缀缓存
  ctx.inject(['systemPrompt'], (promptCtx: any) => {
    promptCtx.systemPrompt.section({ name: 'wiki:protocol', order: 45, text: WIKI_PROTOCOL_TEXT });
  });

  // 动态上下文：每会话一次基线 + 之后仅注入变更小节，作为日志内 user 消息追加到当前步
  (ctx as any).on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
    const decision = await next();
    return decideInjection(payload, decision, indexer, proposalStore, options);
  });
}
