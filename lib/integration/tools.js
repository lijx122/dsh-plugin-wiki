import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { extractSection, parseHeadings } from '../core/parser.js';
export function createWikiTools(wikiRoot, scanner, indexer, graph, proposalStore, options) {
    const requireApproval = typeof options === 'boolean' ? options : !!options?.requireApproval;
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
                                updatedAt: { type: 'string' },
                                supersedes: { type: 'array', items: { type: 'string' } },
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
                    const updated = r.updatedAt ? ` [更新: ${r.updatedAt}]` : '';
                    const supersedes = r.supersedes && r.supersedes.length > 0 ? ` [取代: ${r.supersedes.join(', ')}]` : '';
                    const links = r.forwardLinks && r.forwardLinks.length > 0 ? ` | 引用: [${r.forwardLinks.join(', ')}]` : '';
                    const cited = r.backLinks && r.backLinks.length > 0 ? ` | 被引: [${r.backLinks.join(', ')}]` : '';
                    lines.push(`- **${r.title}** (\`${r.relPath}\`, ${r.type}/${r.status})${updated}${supersedes} [得分 ${r.score}]:\n  ${r.excerpt}${links}${cited}`);
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        isConcurrencySafe: () => true,
        async execute(args) {
            const limit = typeof args.limit === 'number' ? args.limit : 5;
            const filterType = typeof args.type === 'string' ? args.type : undefined;
            const rawResults = indexer.search(args.query, filterType, limit);
            const results = rawResults.map((r) => {
                const item = {
                    relPath: r.relPath,
                    title: r.title,
                    type: r.type,
                    status: r.status,
                    excerpt: r.excerpt,
                    score: r.score,
                    forwardLinks: r.forwardLinks,
                    backLinks: r.backLinks,
                };
                if (r.updatedAt)
                    item.updatedAt = r.updatedAt;
                if (r.supersedes && r.supersedes.length > 0)
                    item.supersedes = r.supersedes;
                return item;
            });
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
            headingsOnly: {
                type: 'boolean',
                description: '是否仅返回词条的各级标题大纲树(TOC)，用于大纲预览与章节导航',
            },
            section: {
                type: 'string',
                description: '可选定向读取的指定标题章节名称，如 "核心决策规则" 或 "二、真实成绩基线"',
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
                    headings: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                level: { type: 'integer' },
                                text: { type: 'string' },
                                line: { type: 'integer' },
                            },
                        },
                    },
                    section: { type: 'string' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                if (!value.found) {
                    return [{ type: 'text', text: `错误: ${value.error ?? '无法读取'}` }];
                }
                if (_args?.headingsOnly || (value.headings && value.headings.length > 0 && !value.content && !value.section)) {
                    if (!value.headings || value.headings.length === 0) {
                        return [{ type: 'text', text: `### 词条大纲 (\`${value.relPath}\`):\n\n(该文档未包含有效各级标题)` }];
                    }
                    const tree = value.headings
                        .map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${'#'.repeat(h.level)} ${h.text} (L${h.line})`)
                        .join('\n');
                    return [{ type: 'text', text: `### 词条大纲 (\`${value.relPath}\`):\n\n${tree}` }];
                }
                if (value.section) {
                    return [{ type: 'text', text: `### 章节内容: ${value.section} (\`${value.relPath}\`):\n\n${value.content}` }];
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
            let content;
            try {
                content = await readFile(abs, 'utf8');
            }
            catch (err) {
                return { found: false, relPath: cleanRel, content: '', error: `无法读取文件: ${err?.message || String(err)}` };
            }
            // 1. 大纲模式 (headingsOnly: true)
            if (args.headingsOnly === true) {
                const allHeadings = parseHeadings(content);
                // 仅返回各级标题大纲树（# 至 ####）
                const toc = allHeadings.filter((h) => h.level >= 1 && h.level <= 4);
                return {
                    found: true,
                    relPath: cleanRel,
                    content: '',
                    headings: toc,
                    error: '',
                };
            }
            // 2. 定向读取指定章节 (section)
            if (typeof args.section === 'string' && args.section.trim()) {
                const sec = extractSection(content, args.section);
                if (sec && sec.found) {
                    return {
                        found: true,
                        relPath: cleanRel,
                        section: sec.title,
                        content: sec.content,
                        error: '',
                    };
                }
                // 未找到指定章节，返回明确提示及所有可用大纲
                const allHeadings = parseHeadings(content);
                const outline = allHeadings.length > 0
                    ? allHeadings.map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${'#'.repeat(h.level)} ${h.text}`).join('\n')
                    : '(该词条无标题)';
                return {
                    found: false,
                    relPath: cleanRel,
                    content: '',
                    headings: allHeadings,
                    error: `未找到章节 "${args.section}"。可用章节大纲供选择:\n${outline}`,
                };
            }
            // 3. 默认全量读取正文
            return { found: true, relPath: cleanRel, content, error: '' };
        },
    }));
    // 3. wiki_write
    tools.push(defineTool({
        name: 'wiki_write',
        description: '写入或更新 Wiki 词条。默认直接落盘；若开启 requireApproval 则进入待审批提案队列。支持自动备份、二级小节就地替换与新建词条补齐 frontmatter。',
        parameters: {
            targetRelPath: {
                type: 'string',
                description: '目标文件相对路径，如 "Topics/DSH.md"、"待整理/软件想法.md"',
                required: true,
            },
            content: {
                type: 'string',
                description: 'Markdown 正文内容',
                required: true,
            },
            section: {
                type: 'string',
                description: '可选二级标题名；若指定且该节存在则就地替换该节正文，不存在则在文末新增该节',
            },
            title: {
                type: 'string',
                description: '词条标题（可选，仅新建词条且无法自动推导时使用）',
            },
            reason: {
                type: 'string',
                description: '变更原因或依据（可选）',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    applied: { type: 'boolean' },
                    proposalId: { type: 'string' },
                    relPath: { type: 'string' },
                    message: { type: 'string' },
                    warning: { type: 'string' },
                    sizeBytes: { type: 'integer' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
            const cleanRel = args.targetRelPath.replace(/\\/g, '/').replace(/^\/+/, '');
            const normalizedRoot = resolve(wikiRoot);
            const absTarget = resolve(normalizedRoot, cleanRel);
            // 越界校验
            if (!absTarget.startsWith(normalizedRoot)) {
                return {
                    ok: false,
                    applied: false,
                    relPath: cleanRel,
                    message: '安全阻断：目标路径超出 Wiki 根目录',
                };
            }
            const effectiveTitle = args.title && args.title.trim()
                ? args.title.trim()
                : basename(cleanRel, extname(cleanRel));
            // 1. 若 requireApproval 为 true -> 复用提案流程，返回 applied: false
            if (requireApproval) {
                const proposal = await proposalStore.createProposal({
                    type: existsSync(absTarget) ? 'append_section' : 'create',
                    targetRelPath: cleanRel,
                    title: effectiveTitle,
                    section: typeof args.section === 'string' && args.section.trim() ? args.section.trim() : undefined,
                    content: args.content,
                    reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'Agent 认知记忆写入',
                    confidence: 1.0,
                    replaceSection: true,
                });
                return {
                    ok: true,
                    applied: false,
                    proposalId: proposal.id,
                    relPath: cleanRel,
                    message: `已创建待审核提案 [${proposal.id}]，目标: \`${cleanRel}\`。等待用户通过 \`/wiki approve ${proposal.id}\` 确认写入。`,
                };
            }
            // 2. 否则直接落盘
            const writeRes = await proposalStore.writeDirect({
                targetRelPath: cleanRel,
                content: args.content,
                section: typeof args.section === 'string' && args.section.trim() ? args.section.trim() : undefined,
                title: effectiveTitle,
                reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined,
            });
            if (!writeRes.ok) {
                return {
                    ok: false,
                    applied: false,
                    relPath: cleanRel,
                    message: writeRes.message,
                };
            }
            // 重新扫描更新内存索引与拓扑图
            try {
                const docs = await scanner.scan();
                graph.build(docs);
                indexer.build(docs);
            }
            catch {
                // 容错降级
            }
            let message = `已直接更新并落盘到 \`${cleanRel}\`。`;
            if (writeRes.warning) {
                message += `\n⚠️ 提示: ${writeRes.warning}`;
            }
            const out = {
                ok: true,
                applied: true,
                relPath: cleanRel,
                message,
            };
            if (writeRes.warning) {
                out.warning = writeRes.warning;
            }
            if (typeof writeRes.sizeBytes === 'number') {
                out.sizeBytes = writeRes.sizeBytes;
            }
            return out;
        },
    }));
    return tools;
}
