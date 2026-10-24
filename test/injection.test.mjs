import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';
import { parseWikiDoc } from '../lib/core/parser.js';
import { computeDocSections, findHeadingIssues } from '../lib/core/sections.js';
import { WikiScanner } from '../lib/core/scanner.js';
import { WikiGraph } from '../lib/core/graph.js';
import { WikiIndexer } from '../lib/core/indexer.js';
import { decideInjection } from '../lib/integration/context-injector.js';

const SELF_MD = `---
title: Self
brief: Alice 是一名虚构的测试用户，偏好异步文字沟通。
---
# Self

## 基本情况
Alice 住在一座虚构城市。
`;

const ALPHA_MD = `---
title: Alpha
status: active
updated: "2026-01-02"
brief: Alpha 是一个合成测试项目。
---
# Alpha

## 当前状态
Alpha 处于设计阶段。

## 后续计划
完成原型。
`;

const BETA_MD = `---
title: Beta
status: planned
updated: "2026-01-01"
---
# Beta

Beta 是第二个合成主题。

## 当前状态
Beta 尚未开始。
`;

async function makeWiki() {
  const tmp = await mkdtemp(join(tmpdir(), 'wiki-inject-'));
  await mkdir(join(tmp, 'Topics'), { recursive: true });
  await mkdir(join(tmp, 'Archive'), { recursive: true });
  await writeFile(join(tmp, 'Self.md'), SELF_MD, 'utf8');
  await writeFile(join(tmp, 'Topics', 'Alpha.md'), ALPHA_MD, 'utf8');
  await writeFile(join(tmp, 'Topics', 'Beta.md'), BETA_MD, 'utf8');
  await writeFile(join(tmp, 'Archive', 'Old.md'), '# Old\n\n## 历史\n旧内容。\n', 'utf8');
  return tmp;
}

function makeCtx() {
  const state = { preStep: null, sections: new Map(), tools: new Map(), commands: new Map() };
  const ctx = {
    on(event, handler) {
      if (event === 'agent/pre-step') state.preStep = handler;
    },
    inject(deps, cb) {
      if (deps.includes('tools')) cb({ tools: { register: (t) => state.tools.set(t.name, t) } });
      if (deps.includes('commands')) cb({ commands: { register: (c) => state.commands.set(c.name, c) } });
      if (deps.includes('systemPrompt')) cb({ systemPrompt: { section: (s) => state.sections.set(s.name, s) } });
    },
    logger() {
      return { warn() {}, info() {} };
    },
    effect() {
      return () => {};
    },
  };
  return { ctx, state };
}

/** 模拟会话日志：把每步最终进入的消息记为 user/message 事件 */
function makeSession() {
  const events = [];
  return {
    events,
    get seq() {
      return events.length;
    },
    eventAt(i) {
      return events[i];
    },
    commit(messages) {
      for (const m of messages) events.push({ type: 'user/message', seq: events.length, data: m });
    },
  };
}

const userMsg = () => ({ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } });
const enter = (messages) => async () => ({ kind: 'enter', messages });

async function step(state, session, messages = [userMsg()]) {
  const decision = await state.preStep({ agent: { session }, messages, turn: 1, step: 1 }, enter(messages));
  if (decision.kind === 'enter') session.commit(decision.messages);
  return decision;
}

test('injection: 首个用户步注入基线；无变化不重复注入；改动一个小节只注入该小节', async () => {
  const tmp = await makeWiki();
  try {
    const { ctx, state } = makeCtx();
    await apply(ctx, { path: tmp, maxContextTokens: 1500, autoWatch: false });

    // 静态协议 section
    const protocol = state.sections.get('wiki:protocol');
    assert.ok(protocol);
    assert.equal(protocol.order, 45);
    assert.ok(protocol.text.includes('## 当前状态'));
    assert.ok(protocol.text.split('\n').length <= 6);

    const session = makeSession();

    // 1. 基线
    const d1 = await step(state, session);
    assert.equal(d1.messages.length, 2);
    const base = d1.messages[1];
    assert.equal(base.role, 'user');
    assert.equal(base.source.kind, 'wiki-context');
    assert.equal(base.source.form, 'snapshot');
    const text = base.content[0].text;
    assert.ok(text.startsWith('<system-reminder>'));
    assert.ok(text.includes('关于你：Alice 是一名虚构的测试用户'));
    assert.ok(text.includes('主题索引：'));
    assert.ok(text.includes('- Alpha [active] (2026-01-02): Alpha 是一个合成测试项目。'));
    assert.ok(text.includes('- Beta [planned] (2026-01-01): Beta 是第二个合成主题。'));
    assert.ok(text.includes('wiki_read'));
    assert.ok(!text.includes('Old'), '归档词条不进入基线');
    // hashes: 紧凑 16 位，排除 Archive/
    const keys = Object.keys(base.source.hashes);
    assert.ok(keys.includes('Topics/Alpha.md#当前状态'));
    assert.ok(keys.includes('Self.md#基本情况'));
    assert.ok(!keys.some((k) => k.startsWith('Archive/')));
    assert.ok(Object.values(base.source.hashes).every((h) => /^[0-9a-f]{16}$/.test(h)));

    // 2. 无变化：原样返回
    const d2 = await step(state, session);
    assert.equal(d2.messages.length, 1);
    assert.equal(d2.messages[0].source.kind, 'user');

    // 3. 编辑 Alpha 的一个小节并重建索引（通过 /wiki reindex，与插件内部路径一致）
    await writeFile(join(tmp, 'Topics', 'Alpha.md'), ALPHA_MD.replace('Alpha 处于设计阶段。', 'Alpha 进入实现阶段。'), 'utf8');
    const reindex = await state.commands.get('wiki').handler({}, { rawInput: 'reindex' });
    assert.equal(reindex.kind, 'success');

    const d3 = await step(state, session);
    assert.equal(d3.messages.length, 2);
    const upd = d3.messages[1].content[0].text;
    assert.ok(upd.includes('Wiki 有更新（以下为变更的小节最新内容）：'));
    assert.ok(upd.includes('### Topics/Alpha.md § 当前状态'));
    assert.ok(upd.includes('Alpha 进入实现阶段。'));
    assert.ok(!upd.includes('后续计划'), '未变更小节不注入');
    assert.ok(!upd.includes('Beta'), '未变更文件不注入');
    assert.equal(d3.messages[1].source.kind, 'wiki-context');

    // 4. 再次无变化
    const d4 = await step(state, session);
    assert.equal(d4.messages.length, 1);

    // 5. 删除一个小节 -> 列为已删除
    await writeFile(join(tmp, 'Topics', 'Alpha.md'), ALPHA_MD.replace('## 后续计划\n完成原型。\n', ''), 'utf8');
    await state.commands.get('wiki').handler({}, { rawInput: 'reindex' });
    const d5 = await step(state, session);
    const upd5 = d5.messages[1].content[0].text;
    assert.ok(upd5.includes('已删除的小节：'));
    assert.ok(upd5.includes('Topics/Alpha.md § 后续计划'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('injection: 非用户步与 reject 决策原样透传；会话访问异常不阻断', async () => {
  const tmp = await makeWiki();
  try {
    const { ctx, state } = makeCtx();
    await apply(ctx, { path: tmp, maxContextTokens: 1500, autoWatch: false });
    const session = makeSession();

    // 非用户步（如工具结果续步）
    const toolMsgs = [{ role: 'user', content: [], source: { kind: 'tool-result' } }];
    const d1 = await state.preStep({ agent: { session }, messages: toolMsgs }, enter(toolMsgs));
    assert.equal(d1.messages.length, 1);
    const d0 = await state.preStep({ agent: { session }, messages: [] }, enter([]));
    assert.deepEqual(d0.messages, []);

    // reject 透传
    const rejected = await state.preStep({ agent: { session }, messages: [userMsg()] }, async () => ({ kind: 'reject' }));
    assert.deepEqual(rejected, { kind: 'reject' });

    // 其他字段保留
    const d2 = await state.preStep(
      { agent: { session }, messages: [userMsg()] },
      async () => ({ kind: 'enter', messages: [userMsg()], startsRequestSeries: true })
    );
    assert.equal(d2.startsRequestSeries, true);
    assert.equal(d2.messages.length, 2);

    // session.eventAt 抛错 -> 原样返回
    const broken = { seq: 3, eventAt() { throw new Error('boom'); } };
    const orig = { kind: 'enter', messages: [userMsg()] };
    const d3 = await state.preStep({ agent: { session: broken }, messages: [userMsg()] }, async () => orig);
    assert.equal(d3, orig);

    // 先前注入的消息被压缩移出可见范围 -> 重新发送基线
    const compacted = makeSession();
    await step(state, compacted);
    assert.equal(compacted.events.filter((e) => e.data?.source?.kind === 'wiki-context').length, 1);
    compacted.surface = { nodes: [] };
    const d4 = await step(state, compacted);
    const injected = d4.messages.find((m) => m.source?.kind === 'wiki-context');
    assert.ok(injected, 'baseline re-sent after compaction');
    assert.match(injected.content[0].text, /主题索引/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('injection: 增量消息超出总篇幅时溢出小节仅列 key', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'wiki-inject-cap-'));
  try {
    await mkdir(join(tmp, 'Topics'), { recursive: true });
    const scanner = new WikiScanner(tmp);
    const graph = new WikiGraph();
    const indexer = new WikiIndexer(graph);
    const write = async (fill) => {
      const body = ['# Big', ...Array.from({ length: 8 }, (_, i) => `## S${i}\n${fill.repeat(700)}`)].join('\n\n');
      await writeFile(join(tmp, 'Topics', 'Big.md'), body, 'utf8');
      const docs = await scanner.scan();
      graph.build(docs);
      indexer.build(docs);
    };
    await write('a');
    const session = makeSession();
    const payload = { agent: { session }, messages: [userMsg()] };
    const d1 = decideInjection(payload, { kind: 'enter', messages: [] }, indexer, undefined, {});
    session.commit(d1.messages);
    await write('b');
    const d2 = decideInjection(payload, { kind: 'enter', messages: [] }, indexer, undefined, {});
    const text = d2.messages[0].content[0].text;
    assert.ok(text.includes('…（截断，完整内容用 wiki_read 读取）'));
    assert.ok(text.includes('内容超出篇幅'));
    assert.ok(text.includes('- Topics/Big.md § S7'));
    assert.ok(text.length < 2400 + 400);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('parser: brief frontmatter 作为 summary；摘要不含 YAML', () => {
  const withBrief = parseWikiDoc('Topics/Alpha.md', '/x', ALPHA_MD, 0, 0);
  assert.equal(withBrief.summary, 'Alpha 是一个合成测试项目。');
  const noBrief = parseWikiDoc('Topics/Beta.md', '/x', BETA_MD, 0, 0);
  assert.equal(noBrief.summary, 'Beta 是第二个合成主题。');
  assert.ok(!noBrief.summary.includes('status'));
  const blank = parseWikiDoc('X.md', '/x', '---\ntitle: X\nbrief: ""\n---\n正文第一段。\n', 0, 0);
  assert.equal(blank.summary, '正文第一段。');
});

test('sections: 按二级标题切分，忽略代码围栏，重名小节区分', () => {
  const md = '---\ntitle: T\n---\n# T\n\n导言一句。\n\n## A\n内容 A\n```\n## 不是标题\n```\n### A1\n子节\n\n## B\n内容 B\n\n## A\n第二个 A\n';
  const entries = computeDocSections({ relPath: 'Topics/T.md', rawContent: md });
  assert.deepEqual(entries.map((e) => e.key), ['Topics/T.md#(导言)', 'Topics/T.md#A', 'Topics/T.md#B', 'Topics/T.md#A (2)']);
  assert.ok(entries[1].content.includes('## 不是标题'));
  assert.ok(entries[1].content.includes('### A1'));
  assert.match(entries[1].hash, /^[0-9a-f]{64}$/);
  const issues = findHeadingIssues('# T\n\n## A\nx\n\n## 空\n\n## A\ny\n');
  assert.equal(issues.length, 2);
});

test('wiki_write: 刷新 updated 日期并报告重复/空二级标题', async () => {
  const tmp = await makeWiki();
  try {
    const { ctx, state } = makeCtx();
    await apply(ctx, { path: tmp, maxContextTokens: 1500, autoWatch: false });
    const writeTool = state.tools.get('wiki_write');
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    // 已有 updated -> 替换
    const r1 = await writeTool.execute({ targetRelPath: 'Topics/Alpha.md', section: '当前状态', content: 'Alpha 已完成原型。' });
    assert.equal(r1.ok, true);
    assert.equal(r1.warning, undefined);
    const alpha = await readFile(join(tmp, 'Topics', 'Alpha.md'), 'utf8');
    assert.ok(alpha.includes(`updated: "${today}"`));
    assert.ok(!alpha.includes('2026-01-02'));
    assert.equal(alpha.match(/^updated:/gm).length, 1);

    // frontmatter 缺 updated -> 插入
    await writeTool.execute({ targetRelPath: 'Self.md', section: '基本情况', content: 'Alice 搬到了另一座虚构城市。' });
    const self = await readFile(join(tmp, 'Self.md'), 'utf8');
    assert.ok(/^---\n[\s\S]*updated: "\d{4}-\d{2}-\d{2}"\n---/.test(self));
    assert.ok(self.includes(`updated: "${today}"`));

    // 无 frontmatter -> 不添加
    await writeFile(join(tmp, 'Plain.md'), '# Plain\n\n## 记录\n一行。\n', 'utf8');
    await writeTool.execute({ targetRelPath: 'Plain.md', section: '记录', content: '新的一行。' });
    const plain = await readFile(join(tmp, 'Plain.md'), 'utf8');
    assert.ok(!plain.includes('updated:'));

    // 重复与空标题 -> warning
    await writeFile(join(tmp, 'Topics', 'Dup.md'), '---\ntitle: Dup\n---\n# Dup\n\n## 当前状态\nx\n\n## 当前状态\ny\n\n## 待补\n', 'utf8');
    const r2 = await writeTool.execute({ targetRelPath: 'Topics/Dup.md', section: '备注', content: 'z' });
    assert.ok(r2.warning);
    assert.ok(r2.warning.includes('重复的二级标题: ## 当前状态'));
    assert.ok(r2.warning.includes('正文为空的二级标题: ## 待补'));
    assert.ok(r2.message.includes('重复的二级标题'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('requireApproval: 基线中显示待确认提案提醒，approve 刷新 updated', async () => {
  const tmp = await makeWiki();
  try {
    const { ctx, state } = makeCtx();
    await apply(ctx, { path: tmp, maxContextTokens: 1500, autoWatch: false, requireApproval: true });
    const res = await state.tools.get('wiki_write').execute({ targetRelPath: 'Topics/Beta.md', section: '当前状态', content: 'Beta 已启动。' });
    assert.equal(res.applied, false);

    const session = makeSession();
    const d1 = await step(state, session);
    assert.ok(d1.messages[1].content[0].text.includes('1 条待确认'));

    const approve = await state.commands.get('wiki').handler({}, { rawInput: `approve ${res.proposalId}` });
    assert.equal(approve.kind, 'success');
    const beta = await readFile(join(tmp, 'Topics', 'Beta.md'), 'utf8');
    assert.ok(beta.includes('Beta 已启动。'));
    assert.ok(!beta.includes('2026-01-01'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
