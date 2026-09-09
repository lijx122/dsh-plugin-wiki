import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

test('5. 端到端模拟：DSH Plugin 生命周期、Tools 与 Slash Commands 闭环', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'wiki-e2e-'));
  try {
    const projDir = join(tmp, 'Project');
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, 'Alpha.md'),
      `---
title: Alpha
type: project
status: active
---
# Alpha
Alpha 项目说明，依赖 [[Beta]]。
`,
      'utf8'
    );

    // Mock DSH Context
    const registeredTools = new Map();
    const registeredCommands = new Map();
    let injectedContextText = '';

    const mockCtx = {
      inject(deps, callback) {
        if (deps.includes('tools')) {
          callback({
            tools: {
              register(tool) {
                registeredTools.set(tool.name, tool);
              },
            },
          });
        }
        if (deps.includes('commands')) {
          callback({
            commands: {
              register(cmd) {
                registeredCommands.set(cmd.name, cmd);
              },
            },
          });
        }
        if (deps.includes('systemPrompt')) {
          callback({
            systemPrompt: {
              context(spec) {
                injectedContextText = spec.text();
              },
            },
          });
        }
      },
      logger() {
        return { warn() {}, info() {} };
      },
      effect() {
        return () => {};
      },
    };

    // 运行 apply
    await apply(mockCtx, {
      path: tmp,
      maxContextTokens: 1500,
      autoWatch: false,
    });

    // 1. 验证 Tools 注册
    assert.ok(registeredTools.has('wiki_search'));
    assert.ok(registeredTools.has('wiki_read'));
    assert.ok(registeredTools.has('wiki_propose'));
    assert.ok(registeredTools.has('wiki_create'));

    // 2. 验证 Commands 注册
    assert.ok(registeredCommands.has('wiki'));

    // 3. 验证 System Context 注入了 Alpha 项目
    assert.ok(injectedContextText.includes('Alpha'));

    // 4. 执行 wiki_search
    const searchTool = registeredTools.get('wiki_search');
    const searchResult = await searchTool.execute({ query: 'Alpha' });
    assert.equal(searchResult.count, 1);
    assert.equal(searchResult.results[0].title, 'Alpha');

    // 5. 执行 wiki_propose 提交修改建议
    const proposeTool = registeredTools.get('wiki_propose');
    const proposeRes = await proposeTool.execute({
      targetRelPath: 'Project/Alpha.md',
      title: 'Alpha 新增决策',
      type: 'record_decision',
      section: '决策记录',
      content: '- 决定采用单机自宿主部署',
      reason: '对话中用户明确指定',
      confidence: 0.95,
    });
    assert.equal(proposeRes.ok, true);
    assert.ok(proposeRes.proposalId.startsWith('prop-'));

    // 6. 执行 /wiki list 命令
    const wikiCommand = registeredCommands.get('wiki');
    const listRes = await wikiCommand.handler({}, { rawInput: 'list' });
    assert.equal(listRes.kind, 'success');
    assert.ok(listRes.text.includes(proposeRes.proposalId));

    // 7. 执行 /wiki approve 命令
    const approveRes = await wikiCommand.handler({}, { rawInput: `approve ${proposeRes.proposalId}` });
    assert.equal(approveRes.kind, 'success');
    assert.ok(approveRes.text.includes('已批准'));

    // 8. 重新通过 wiki_read 验证文件已成功写入新内容
    const readTool = registeredTools.get('wiki_read');
    const readRes = await readTool.execute({ path: 'Project/Alpha.md' });
    assert.equal(readRes.found, true);
    assert.ok(readRes.content.includes('决定采用单机自宿主部署'));
    assert.ok(readRes.content.includes('## 决策记录'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
