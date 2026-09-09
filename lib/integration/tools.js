import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
export function createWikiTools(wikiRoot, scanner, indexer, graph, proposalStore) {
    const tools = [];
    // 1. wiki_search
    tools.push(defineTool({
        name: 'wiki_search',
        description: '在个人长期 Wiki 库中搜索词条、技术决策、项目状态与用户偏好。返回匹配摘要及双链网络关联。',
        parameters: {
            query: {
                type: 'string',
                description: '搜索关键词、项目名、人名或决策主题',
                required: true,
            },
            type: {
                type: 'string',
                description: '可选过滤类型: project | decision | preference | person | asset | general',
            },
            limit: {
                type: 'integer',
                description: '返回结果数量上限，默认 5',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    count: { type: 'integer' },
                    results: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                relPath: { type: 'string' },
                                title: { type: 'string' },
                                type: { type: 'string' },
                                status: { type: 'string' },
                                excerpt: { type: 'string' },
                                score: { type: 'number' },
                                forwardLinks: { type: 'array', items: { type: 'string' } },
                                backLinks: { type: 'array', items: { type: 'string' } },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                if (!value.results || value.results.length === 0) {
                    return [{ type: 'text', text: `未在 Wiki 中找到与 "${_args.query}" 相关的词条。` }];
                }
                const lines = [`找到 ${value.count} 个匹配词条:`];
                for (const r of value.results) {
                    const links = r.forwardLinks && r.forwardLinks.length > 0 ? ` | 引用: [${r.forwardLinks.join(', ')}]` : '';
                    const cited = r.backLinks && r.backLinks.length > 0 ? ` | 被引: [${r.backLinks.join(', ')}]` : '';
                    lines.push(`- **${r.title}** (\`${r.relPath}\`, ${r.type}/${r.status}) [得分 ${r.score}]:\n  ${r.excerpt}${links}${cited}`);
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        isConcurrencySafe: () => true,
        async execute(args) {
            const limit = typeof args.limit === 'number' ? args.limit : 5;
            const filterType = typeof args.type === 'string' ? args.type : undefined;
            const rawResults = indexer.search(args.query, filterType, limit);
            const results = rawResults.map((r) => ({
                relPath: r.relPath,
                title: r.title,
                type: r.type,
                status: r.status,
                excerpt: r.excerpt,
                score: r.score,
                forwardLinks: r.forwardLinks,
                backLinks: r.backLinks,
            }));
            return {
                count: results.length,
                results,
            };
        },
    }));
    // 2. wiki_read
    tools.push(defineTool({
        name: 'wiki_read',
        description: '读取 Wiki 库中指定相对路径的 Markdown 词条完整内容。',
        parameters: {
            path: {
                type: 'string',
                description: '词条相对路径，例如 "Project/DSH.md" 或从 wiki_search 获取的 relPath',
                required: true,
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    found: { type: 'boolean' },
                    relPath: { type: 'string' },
                    content: { type: 'string' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                if (!value.found) {
                    return [{ type: 'text', text: `错误: ${value.error ?? '无法读取'}` }];
                }
                return [{ type: 'text', text: `### 词条内容 (\`${value.relPath}\`):\n\n${value.content}` }];
            },
        },
        isConcurrencySafe: () => true,
        async execute(args) {
            const cleanRel = args.path.replace(/\\/g, '/').replace(/^\/+/, '');
            const abs = resolve(wikiRoot, cleanRel);
            if (!abs.startsWith(wikiRoot)) {
                return { found: false, relPath: cleanRel, content: '', error: '安全阻断：越界路径' };
            }
            try {
                const content = await readFile(abs, 'utf8');
                return { found: true, relPath: cleanRel, content, error: '' };
            }
            catch (err) {
                return { found: false, relPath: cleanRel, content: '', error: `无法读取文件: ${err?.message || String(err)}` };
            }
        },
    }));
    // 3. wiki_propose
    tools.push(defineTool({
        name: 'wiki_propose',
        description: '当在对话中发现用户的长期目标、重大技术决策、项目变化或明确偏好时，向待确认队列提交修改提案。该操作不会污染现有文件，待用户通过 /wiki approve 审核。',
        parameters: {
            targetRelPath: {
                type: 'string',
                description: '目标文件相对路径，如 "Project/DSH.md" 或 "Decision/技术偏好.md"',
                required: true,
            },
            title: {
                type: 'string',
                description: '提案关联的主题标题',
                required: true,
            },
            type: {
                type: 'string',
                enum: ['record_decision', 'append_section', 'update_frontmatter', 'create'],
                description: '提案类型',
                required: true,
            },
            section: {
                type: 'string',
                description: '拟插入或追加的 Markdown 二级标题，例如 "决策记录" 或 "当前状态"',
            },
            content: {
                type: 'string',
                description: '拟写入的具体 Markdown 内容',
                required: true,
            },
            reason: {
                type: 'string',
                description: '为何提议持久化记录该信息的依据',
                required: true,
            },
            confidence: {
                type: 'number',
                description: '该提议的置信度 (0.0 - 1.0)',
                required: true,
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    proposalId: { type: 'string' },
                    message: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
            const proposal = await proposalStore.createProposal({
                type: args.type,
                targetRelPath: args.targetRelPath,
                title: args.title,
                section: typeof args.section === 'string' ? args.section : undefined,
                content: args.content,
                reason: args.reason,
                confidence: args.confidence,
            });
            return {
                ok: true,
                proposalId: proposal.id,
                message: `已创建待审核提案 [${proposal.id}]，目标: \`${proposal.targetRelPath}\`。等待用户通过 \`/wiki approve ${proposal.id}\` 确认写入。`,
            };
        },
    }));
    // 4. wiki_create
    tools.push(defineTool({
        name: 'wiki_create',
        description: '为新项目或新概念创建草稿词条。若词条已存在则阻断并引导使用 wiki_propose。',
        parameters: {
            type: {
                type: 'string',
                enum: ['project', 'decision', 'preference', 'person', 'asset', 'general'],
                description: '词条类型',
                required: true,
            },
            title: {
                type: 'string',
                description: '词条标题',
                required: true,
            },
            content: {
                type: 'string',
                description: '词条正文 Markdown 内容',
                required: true,
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    relPath: { type: 'string' },
                    message: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
            const typeDir = args.type.charAt(0).toUpperCase() + args.type.slice(1);
            const safeTitle = args.title.replace(/[\\/:*?"<>|]/g, '_').trim();
            const relPath = `${typeDir}/${safeTitle}.md`;
            const existing = scanner.getDoc(relPath);
            if (existing) {
                return {
                    ok: false,
                    relPath,
                    message: `词条 \`${relPath}\` 已存在。如需追加内容，请使用 \`wiki_propose\` 工具提交修改建议。`,
                };
            }
            const proposal = await proposalStore.createProposal({
                type: 'create',
                targetRelPath: relPath,
                title: args.title,
                content: args.content,
                reason: `创建新词条草稿 [${args.type}] ${args.title}`,
                confidence: 0.95,
            });
            return {
                ok: true,
                relPath,
                message: `已提交新建词条提案 [${proposal.id}] (\`${relPath}\`)，请告知用户输入 \`/wiki approve ${proposal.id}\` 确认落盘。`,
            };
        },
    }));
    return tools;
}
