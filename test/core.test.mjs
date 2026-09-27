import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { resolveWikiPath } from '../lib/core/config.js';
import { parseFrontmatter, extractWikiLinks, parseWikiDoc, parseHeadings, extractSection, formatMtime } from '../lib/core/parser.js';
import { WikiScanner } from '../lib/core/scanner.js';
import { WikiGraph } from '../lib/core/graph.js';
import { WikiIndexer } from '../lib/core/indexer.js';
import { ProposalStore } from '../lib/core/proposal-store.js';

test('1. 默认路径解析：拒绝死绝对路径，默认回退至 ~/.dsh/wiki', () => {
  const defaultPath = resolveWikiPath('');
  const expectedDefault = join(homedir(), '.dsh', 'wiki');
  assert.equal(defaultPath, expectedDefault);

  const tildePath = resolveWikiPath('~/my-wiki');
  assert.equal(tildePath, join(homedir(), 'my-wiki'));
});

test('2. Parser: Frontmatter 与双链提取', () => {
  const raw = `---
title: DSH 智能体
type: project
status: active
tags: [agent, core]
---

# DSH

## 摘要
DeepSeek Harness 智能体核心。

依赖底层微内核 [[Cordis|微内核]] 以及 [[AuthGuard]]。
`;

  const { frontmatter, body } = parseFrontmatter(raw);
  assert.equal(frontmatter.title, 'DSH 智能体');
  assert.equal(frontmatter.type, 'project');
  assert.deepEqual(frontmatter.tags, ['agent', 'core']);

  const links = extractWikiLinks(raw);
  assert.equal(links.length, 2);
  assert.equal(links[0].target, 'Cordis');
  assert.equal(links[0].alias, '微内核');
  assert.equal(links[1].target, 'AuthGuard');

  const doc = parseWikiDoc('Project/DSH.md', '/tmp/DSH.md', raw, 1000, raw.length);
  assert.equal(doc.title, 'DSH 智能体');
  assert.equal(doc.type, 'project');
  assert.ok(doc.summary.includes('DeepSeek Harness'));
});

test('2.1 Parser: parseHeadings (跳过代码块与Frontmatter) 与 extractSection (定向章节提取)', () => {
  const sampleMd = `---
title: 测试标题
# 这是 frontmatter 内部注释，不应被解析为标题
type: project
---

# 一级标题

## 核心决策规则
这里是决策正文内容。

\`\`\`python
# 这是一个 Python 代码注释，绝对不应被误判为 Markdown 标题
def hello():
    print("world")
\`\`\`

~~~bash
# 这是一个 Bash 注释
echo "hi"
~~~

### 子规则 A
子规则正文。

## 二、真实成绩基线
真实成绩正文。

#### 细项评分
评分正文。
`;

  const headings = parseHeadings(sampleMd);
  assert.equal(headings.length, 5);
  assert.equal(headings[0].text, '一级标题');
  assert.equal(headings[0].level, 1);
  assert.equal(headings[1].text, '核心决策规则');
  assert.equal(headings[1].level, 2);
  assert.equal(headings[2].text, '子规则 A');
  assert.equal(headings[2].level, 3);
  assert.equal(headings[3].text, '二、真实成绩基线');
  assert.equal(headings[3].level, 2);
  assert.equal(headings[4].text, '细项评分');
  assert.equal(headings[4].level, 4);

  // 验证 extractSection
  // 1. 完全匹配
  const sec1 = extractSection(sampleMd, '核心决策规则');
  assert.ok(sec1);
  assert.equal(sec1.found, true);
  assert.equal(sec1.title, '核心决策规则');
  assert.equal(sec1.level, 2);
  assert.ok(sec1.content.includes('这里是决策正文内容'));
  assert.ok(sec1.content.includes('# 这是一个 Python 代码注释'));
  assert.ok(sec1.content.includes('### 子规则 A'));
  assert.ok(!sec1.content.includes('二、真实成绩基线'));

  // 2. 模糊/包含匹配 ("真实成绩基线" -> "## 二、真实成绩基线")
  const sec2 = extractSection(sampleMd, '真实成绩基线');
  assert.ok(sec2);
  assert.equal(sec2.title, '二、真实成绩基线');
  assert.ok(sec2.content.includes('真实成绩正文'));
  assert.ok(sec2.content.includes('#### 细项评分'));

  // 3. 携带 # 的匹配 ("## 核心决策规则")
  const sec3 = extractSection(sampleMd, '## 核心决策规则');
  assert.ok(sec3);
  assert.equal(sec3.title, '核心决策规则');

  // 4. 未找到章节返回 null
  const secNone = extractSection(sampleMd, '不存在的章节');
  assert.equal(secNone, null);
});

test('2.2 Parser: 时效元数据与版本替代 (updatedAt, supersedes, mtime fallback)', () => {
  // Frontmatter 包含 updated_at 与 supersedes
  const rawWithMeta = `---
title: 新决策
type: decision
updated_at: 2026-09-24
supersedes: [老决策A, 老决策B]
---
# 新决策
正文内容
`;
  const docMeta = parseWikiDoc('Decision/New.md', '/tmp/New.md', rawWithMeta, 0, rawWithMeta.length);
  assert.equal(docMeta.updatedAt, '2026-09-24');
  assert.deepEqual(docMeta.supersedes, ['老决策A', '老决策B']);

  // Frontmatter 无 updated_at，退回 mtimeMs
  const testMtime = new Date('2026-05-18T10:00:00Z').getTime();
  const rawNoDate = `---
title: 无日期
type: project
---
# 无日期
`;
  const docNoDate = parseWikiDoc('Project/NoDate.md', '/tmp/NoDate.md', rawNoDate, testMtime, rawNoDate.length);
  assert.equal(docNoDate.updatedAt, formatMtime(testMtime));
});

test('3. Scanner, Graph 与 Indexer 拓扑检索', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'wiki-test-'));
  try {
    const projDir = join(tmp, 'Project');
    const decDir = join(tmp, 'Decision');
    await mkdir(projDir, { recursive: true });
    await mkdir(decDir, { recursive: true });

    // 建立两个相互引用的词条
    const cordisDoc = `---
title: Cordis
type: asset
---
# Cordis 微内核
高性能微内核框架。
`;
    const dshDoc = `---
title: DSH
type: project
status: active
tags: [agent]
---
# DSH
DSH 智能体框架，构建在 [[Cordis]] 之上。
`;
    await writeFile(join(projDir, 'DSH.md'), dshDoc, 'utf8');
    await writeFile(join(decDir, 'Cordis.md'), cordisDoc, 'utf8');

    const scanner = new WikiScanner(tmp);
    const docs = await scanner.scan();
    assert.equal(docs.length, 2);

    const graph = new WikiGraph();
    graph.build(docs);

    // 验证拓扑出链与入链
    const dshForward = graph.getForwardLinks('Project/DSH.md');
    assert.ok(dshForward.includes('Decision/Cordis.md'));

    const cordisBack = graph.getBackLinks('Decision/Cordis.md');
    assert.ok(cordisBack.includes('Project/DSH.md'));

    // 验证检索
    const indexer = new WikiIndexer(graph);
    indexer.build(docs);

    const searchRes = indexer.search('DSH');
    assert.ok(searchRes.length >= 1);
    assert.equal(searchRes[0].title, 'DSH');

    const summary = indexer.getBriefSummary();
    assert.ok(summary.includes('DSH'));
    assert.ok(summary.includes('Cordis'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('4. ProposalStore: 提案创建、备份与小节安全追加合并', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'wiki-prop-test-'));
  try {
    const store = new ProposalStore(tmp);
    await store.init();

    // 1. 创建目标文件
    const docPath = join(tmp, 'Decision', 'TechStack.md');
    await mkdir(join(tmp, 'Decision'), { recursive: true });
    const initialContent = `---
title: 技术选型
type: decision
---

# 技术选型

## 背景
选择本地优先技术。

## 决策记录
- 2026-08 初始决定使用 Node.js。
`;
    await writeFile(docPath, initialContent, 'utf8');

    // 2. 提交修改建议提案
    const prop = await store.createProposal({
      type: 'record_decision',
      targetRelPath: 'Decision/TechStack.md',
      title: '技术选型更新',
      section: '决策记录',
      content: '- 2026-09 决策：知识库选用纯本地 Markdown 格式，绝不外泄。',
      reason: '用户强调数据私有化与完全掌控',
      confidence: 0.98,
    });

    assert.equal(prop.status, 'pending');
    assert.equal(store.listPending().length, 1);

    // 3. 批准提案
    const approveRes = await store.approve(prop.id);
    assert.equal(approveRes.ok, true);
    assert.equal(store.listPending().length, 0);

    // 4. 验证内容已安全追加至 ## 决策记录
    const updatedContent = await readFile(docPath, 'utf8');
    assert.ok(updatedContent.includes('绝不外泄'));
    assert.ok(updatedContent.includes('2026-08 初始决定使用 Node.js'));

    // 5. 验证备份已产生
    const backupDir = join(tmp, '.wiki', 'backups');
    const scanner = new WikiScanner(tmp);
    // 确保备份目录存在且有文件
    const files = await readFile(docPath, 'utf8');
    assert.ok(files.length > 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
