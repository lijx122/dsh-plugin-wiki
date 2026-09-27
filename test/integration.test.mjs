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

    // 7.1 测试 autoApprove: true 静默直接落盘
    const autoProposeRes = await proposeTool.execute({
      targetRelPath: 'Project/Alpha.md',
      title: 'Alpha 架构决策',
      type: 'record_decision',
      section: '架构决策',
      content: '- 用户指示直接落盘',
      reason: '用户明确指示',
      confidence: 1.0,
      autoApprove: true,
    });
    assert.equal(autoProposeRes.ok, true);
    assert.equal(autoProposeRes.applied, true);
    assert.ok(autoProposeRes.message.includes('已直接更新并落盘'));

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

test('6. wiki_read 渐进式读取（大纲与章节切片）与 wiki_search 时效与替代元数据', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'wiki-progressive-'));
  try {
    const projDir = join(tmp, 'Project');
    await mkdir(projDir, { recursive: true });

    // 文件 1：包含显式 updated_at、supersedes 以及多级章节与代码块
    const docWithMeta = `---
title: 核心系统架构
type: project
status: active
updated_at: 2026-09-24
supersedes: [老架构方案, v1单体]
---

# 核心系统架构

## 核心决策规则
这是决策规则的第一行说明。
这是决策规则的第二行说明。

\`\`\`python
# 这是代码中的注释，绝对不应被误判为大纲标题
def core_logic():
    return True
\`\`\`

### 规则细项
细项内容在此。

## 二、真实成绩基线
真实成绩基线正文内容。

### 跑分细节
跑分细节说明。
`;
    await writeFile(join(projDir, 'CoreSystem.md'), docWithMeta, 'utf8');

    // 文件 2：无显式日期，用于验证 mtime 回退逻辑
    const docNoDate = `---
title: 自动时效词条
type: project
---
# 自动时效词条
这是一个通过 mtime 计算更新时间的词条。
`;
    await writeFile(join(projDir, 'AutoDate.md'), docNoDate, 'utf8');

    const registeredTools = new Map();
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
      },
      logger() {
        return { warn() {}, info() {} };
      },
      effect() {
        return () => {};
      },
    };

    await apply(mockCtx, {
      path: tmp,
      maxContextTokens: 1500,
      autoWatch: false,
    });

    const readTool = registeredTools.get('wiki_read');
    const searchTool = registeredTools.get('wiki_search');

    // --- A. wiki_read 大纲模式 (headingsOnly: true) ---
    const tocRes = await readTool.execute({
      path: 'Project/CoreSystem.md',
      headingsOnly: true,
    });
    assert.equal(tocRes.found, true);
    assert.equal(tocRes.content, ''); // 确保不吐出全量长正文
    assert.ok(Array.isArray(tocRes.headings));
    // 应该提取 # 核心系统架构(1), ## 核心决策规则(2), ### 规则细项(3), ## 二、真实成绩基线(2), ### 跑分细节(3)
    assert.equal(tocRes.headings.length, 5);
    assert.equal(tocRes.headings[0].text, '核心系统架构');
    assert.equal(tocRes.headings[0].level, 1);
    assert.equal(tocRes.headings[1].text, '核心决策规则');
    assert.equal(tocRes.headings[1].level, 2);
    assert.equal(tocRes.headings[2].text, '规则细项');
    assert.equal(tocRes.headings[2].level, 3);
    assert.equal(tocRes.headings[3].text, '二、真实成绩基线');
    assert.equal(tocRes.headings[3].level, 2);

    // 验证大纲 render 输出
    const tocRendered = readTool.output.render({ path: 'Project/CoreSystem.md', headingsOnly: true }, tocRes);
    assert.ok(tocRendered[0].text.includes('### 词条大纲'));
    assert.ok(tocRendered[0].text.includes('核心决策规则'));

    // --- B. wiki_read 章节定向读取 (section) ---
    // B1. 精确匹配章节
    const sec1Res = await readTool.execute({
      path: 'Project/CoreSystem.md',
      section: '核心决策规则',
    });
    assert.equal(sec1Res.found, true);
    assert.equal(sec1Res.section, '核心决策规则');
    assert.ok(sec1Res.content.includes('这是决策规则的第一行说明'));
    assert.ok(sec1Res.content.includes('# 这是代码中的注释'));
    assert.ok(sec1Res.content.includes('### 规则细项'));
    // 应该在同级标题 "## 二、真实成绩基线" 处截断
    assert.ok(!sec1Res.content.includes('真实成绩基线正文内容'));

    // B2. 模糊/包含匹配章节 ("真实成绩基线" 匹配 "## 二、真实成绩基线")
    const sec2Res = await readTool.execute({
      path: 'Project/CoreSystem.md',
      section: '真实成绩基线',
    });
    assert.equal(sec2Res.found, true);
    assert.equal(sec2Res.section, '二、真实成绩基线');
    assert.ok(sec2Res.content.includes('真实成绩基线正文内容'));
    assert.ok(sec2Res.content.includes('### 跑分细节'));

    // 验证章节 render 输出
    const secRendered = readTool.output.render({ path: 'Project/CoreSystem.md', section: '真实成绩基线' }, sec2Res);
    assert.ok(secRendered[0].text.includes('### 章节内容: 二、真实成绩基线'));

    // B3. 不存在的章节，返回明确提示与全部可用章节大纲
    const notFoundRes = await readTool.execute({
      path: 'Project/CoreSystem.md',
      section: '不存在的幻影章节',
    });
    assert.equal(notFoundRes.found, false);
    assert.ok(notFoundRes.error.includes('未找到章节 "不存在的幻影章节"'));
    assert.ok(notFoundRes.error.includes('核心决策规则'));
    assert.ok(notFoundRes.error.includes('二、真实成绩基线'));

    // --- C. wiki_search 时效与替代元数据 ---
    // C1. 显式 updated_at 与 supersedes
    const searchRes1 = await searchTool.execute({ query: '核心系统架构' });
    assert.equal(searchRes1.count, 1);
    const item1 = searchRes1.results[0];
    assert.equal(item1.updatedAt, '2026-09-24');
    assert.deepEqual(item1.supersedes, ['老架构方案', 'v1单体']);

    // 验证 search render 输出标注
    const searchRendered = searchTool.output.render({ query: '核心系统架构' }, searchRes1);
    assert.ok(searchRendered[0].text.includes('[更新: 2026-09-24]'));
    assert.ok(searchRendered[0].text.includes('[取代: 老架构方案, v1单体]'));

    // C2. 回退 mtime 作为默认 updatedAt
    const searchRes2 = await searchTool.execute({ query: '自动时效词条' });
    assert.equal(searchRes2.count, 1);
    const item2 = searchRes2.results[0];
    assert.match(item2.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
