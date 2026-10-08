import type { Context } from '@deepseek-ai/cordis';
import type { WikiIndexer } from '../core/indexer.js';
import type { ProposalStore } from '../core/proposal-store.js';

export function registerContextInjector(
  ctx: Context,
  indexer: WikiIndexer,
  proposalStore: ProposalStore,
  maxContextTokens = 1500
): void {
  ctx.inject(['systemPrompt'], (promptCtx: any) => {
    // 粗略以 1 token ≈ 2.5 字符估算安全字符数
    const maxChars = Math.max(800, maxContextTokens * 2.5);

    promptCtx.systemPrompt.context({
      name: 'wiki:personal-context',
      // 在系统提示词阶段较前位置注入（在 Persona 之后，Tools 说明之前）
      order: 45,
      text: () => {
        const summary = indexer.getBriefSummary(maxChars);
        if (!summary) {
          return '';
        }

        const pendingCount = proposalStore.listPending().length;
        const pendingNotice = pendingCount > 0 ? `\n> 提醒: 当前有 ${pendingCount} 条待确认的变更提案，可通过 \`/wiki list\` 查看。` : '';

        return `${summary}${pendingNotice}\n\n[Wiki Context Tool Protocol]\n- 当需要查询用户长期记忆、项目演化与技术背景时，使用 \`wiki_search\` 或 \`wiki_read\`。\n- 遇到用户的个人情况变动、个人倾向与偏好、项目状态变化、设计推翻或跨会话断点时，Agent 自主判断并直接调用 \`wiki_write\` 落盘，不询问、不口播提案编号。\n- 行为规则与流程写进 Skill / AGENTS.md，不写进 Wiki。\n- 允许当时理解有误，后续就地修正覆盖即可。`;
      },
    });
  });
}
