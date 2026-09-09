export function registerContextInjector(ctx, indexer, proposalStore, maxContextTokens = 1500) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
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
                const pendingNotice = pendingCount > 0 ? `\n> 提醒: 当前有 ${pendingCount} 条待确认的知识库变更提案，用户可通过 \`/wiki list\` 查看。` : '';
                return `${summary}${pendingNotice}\n\n[Wiki Context Tool Protocol]\n- 当遇到涉及用户过往项目、技术偏好、私有决策或长期目标时，使用 \`wiki_search\` 或 \`wiki_read\`。\n- 当识别到重大架构变更、技术选型或用户明确声明的长期规则时，必须调用 \`wiki_propose\` 提交提案等待用户审批，禁止盲目自言自语沉淀。`;
            },
        });
    });
}
