import type { Context } from '@deepseek-ai/cordis';
import type { WikiGraph } from '../core/graph.js';
import type { WikiIndexer } from '../core/indexer.js';
import type { ProposalStore } from '../core/proposal-store.js';
import type { WikiScanner } from '../core/scanner.js';

export function registerWikiCommands(
  ctx: Context,
  wikiRoot: string,
  scanner: WikiScanner,
  indexer: WikiIndexer,
  graph: WikiGraph,
  proposalStore: ProposalStore
): void {
  ctx.inject(['commands'], (commandCtx: any) => {
    commandCtx.commands.register({
      name: 'wiki',
      description: '个人长期 Wiki 上下文与待审提案管理',
      input: {
        hint: 'status | list | diff <id> | approve <id> | reject <id> | reindex',
      },
      handler: async (_session: any, input: { rawInput?: string }) => {
        const raw = (input.rawInput ?? '').trim();
        const parts = raw.split(/\s+/).filter(Boolean);
        const action = (parts[0] || 'status').toLowerCase();
        const arg = parts[1];

        switch (action) {
          case 'status': {
            const docs = scanner.getDocs();
            const pending = proposalStore.listPending();
            const adjacency = graph.exportAdjacency();
            const linkCount = Object.values(adjacency).reduce((acc, links) => acc + links.length, 0);

            return {
              kind: 'success',
              text: [
                '### 📚 Wiki 个人知识库状态',
                `- **根路径**: \`${wikiRoot}\``,
                `- **收录词条**: ${docs.length} 篇 Markdown`,
                `- **知识双链**: ${linkCount} 条内部拓扑关系`,
                `- **待确认提案**: ${pending.length} 条待审核`,
                '',
                '常用指令: `/wiki list` (查提案) | `/wiki approve <id>` (批准写入) | `/wiki reindex` (重构索引)',
              ].join('\n'),
            };
          }

          case 'list': {
            const pending = proposalStore.listPending();
            if (pending.length === 0) {
              return {
                kind: 'success',
                text: '当前没有待处理的 Wiki 提案。',
              };
            }

            const lines = ['### 📋 待确认 Wiki 提案列表:'];
            for (const p of pending) {
              const dt = new Date(p.createdAt).toLocaleString();
              lines.push(
                `- **ID: \`${p.id}\`** [${p.type}] -> \`${p.targetRelPath}\`\n  - 主题: ${p.title}\n  - 依据: ${p.reason} (置信度: ${(p.confidence * 100).toFixed(0)}%)\n  - 时间: ${dt}\n  - 操作: 输入 \`/wiki approve ${p.id}\` 批准 | \`/wiki diff ${p.id}\` 预览`
              );
            }
            return {
              kind: 'success',
              text: lines.join('\n'),
            };
          }

          case 'diff': {
            if (!arg) {
              return { kind: 'error', text: '请提供提案 ID，例如: `/wiki diff prop-1234`' };
            }
            const proposal = proposalStore.getProposal(arg);
            if (!proposal) {
              return { kind: 'error', text: `未找到提案 \`${arg}\`` };
            }

            return {
              kind: 'success',
              text: [
                `### 🔍 提案 \`${proposal.id}\` 变更预览`,
                `- **目标文件**: \`${proposal.targetRelPath}\``,
                `- **修改类型**: ${proposal.type}`,
                `- **目标小节**: ${proposal.section ? `## ${proposal.section}` : '(追加至文末)'}`,
                `- **提议理由**: ${proposal.reason}`,
                '',
                '```markdown',
                proposal.content,
                '```',
                '',
                `批准请输入: \`/wiki approve ${proposal.id}\``,
              ].join('\n'),
            };
          }

          case 'approve': {
            if (!arg) {
              return { kind: 'error', text: '请提供待批准的提案 ID，例如: `/wiki approve prop-1234`' };
            }
            const result = await proposalStore.approve(arg);
            if (!result.ok) {
              return { kind: 'error', text: result.message };
            }

            // 重新扫描使新变更立刻对内存索引生效
            const docs = await scanner.scan();
            graph.build(docs);
            indexer.build(docs);

            return {
              kind: 'success',
              text: `✅ ${result.message}。内存索引与拓扑图谱已即时更新。`,
            };
          }

          case 'reject': {
            if (!arg) {
              return { kind: 'error', text: '请提供要废弃的提案 ID，例如: `/wiki reject prop-1234`' };
            }
            const result = await proposalStore.reject(arg);
            if (!result.ok) {
              return { kind: 'error', text: result.message };
            }
            return { kind: 'success', text: `🗑️ ${result.message}` };
          }

          case 'reindex': {
            const docs = await scanner.scan();
            graph.build(docs);
            indexer.build(docs);
            return {
              kind: 'success',
              text: `🔄 Wiki 全量重索引完成！共处理 ${docs.length} 个词条。`,
            };
          }

          default:
            return {
              kind: 'error',
              text: `未知子命令 "${action}"。可用操作: status, list, diff <id>, approve <id>, reject <id>, reindex`,
            };
        }
      },
    });
  });
}
