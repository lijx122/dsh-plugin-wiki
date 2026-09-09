import type { Context } from '@deepseek-ai/cordis';
import { Config, resolveWikiPath } from './core/config.js';
import { WikiGraph } from './core/graph.js';
import { WikiIndexer } from './core/indexer.js';
import { ProposalStore } from './core/proposal-store.js';
import { WikiScanner } from './core/scanner.js';
import { registerWikiCommands } from './integration/commands.js';
import { registerContextInjector } from './integration/context-injector.js';
import { createWikiTools } from './integration/tools.js';
import type { WikiConfig } from './types.js';

export const name = 'dsh-plugin-wiki';
export const inject = ['tools', 'systemPrompt', 'commands'];
export { Config };

export async function apply(ctx: Context, config: WikiConfig): Promise<void> {
  // 1. 严格使用默认的用户主目录 ~/.dsh/wiki，拒绝代码写死绝对路径
  const wikiRoot = resolveWikiPath(config.path);

  // 2. 初始化核心引擎组件
  const graph = new WikiGraph();
  const indexer = new WikiIndexer(graph);
  const scanner = new WikiScanner(wikiRoot);
  const proposalStore = new ProposalStore(wikiRoot);

  await proposalStore.init();

  // 3. 执行冷启动扫描
  try {
    const docs = await scanner.scan();
    graph.build(docs);
    indexer.build(docs);
  } catch (err: any) {
    ctx.logger('wiki')?.warn(`Wiki 初始化扫描警报: ${err?.message || String(err)}`);
  }

  // 4. 接入 DSH System Prompt 动态上下文注入
  registerContextInjector(ctx, indexer, proposalStore, config.maxContextTokens);

  // 5. 接入 DSH Agent 工具集合
  ctx.inject(['tools'], (toolCtx: any) => {
    const tools = createWikiTools(wikiRoot, scanner, indexer, graph, proposalStore);
    for (const tool of tools) {
      toolCtx.tools.register(tool);
    }
  });

  // 6. 接入 DSH 斜杠命令交互 (/wiki)
  registerWikiCommands(ctx, wikiRoot, scanner, indexer, graph, proposalStore);

  // 7. 文件热监听与增量更新
  if (config.autoWatch) {
    scanner.startWatch((updatedDocs) => {
      graph.build(updatedDocs);
      indexer.build(updatedDocs);
    });
  }

  // 8. 资源回收 (Cordis effect 回调)
  ctx.effect(() => () => {
    scanner.stopWatch();
  });
}
