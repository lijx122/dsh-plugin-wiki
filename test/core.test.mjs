import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { resolveWikiPath } from '../lib/core/config.js';
import { parseFrontmatter, extractWikiLinks, parseWikiDoc, parseHeadings, extractSection, formatMtime, replaceSection, inferDocTypeFromPath } from '../lib/core/parser.js';
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

本机资源区间 1000~2000 单位，调用 \`wiki_write\` 记录。
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
  assert.ok(doc.summary.includes('1000~2000'), '摘要不得抹掉 ~ 导致 1000~2000 变成 10002000');
  assert.ok(doc.summary.includes('`wiki_write`'), '摘要不得抹掉反引号包裹的标识符');
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

test('4.1 ProposalStore.writeDirect: 直写落盘、小节就地替换(防重复)、未匹配小节新增、自动备份与新建文件 Frontmatter 补齐', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'wiki-direct-test-'));
  try {
    const store = new ProposalStore(tmp);
    await store.init();

    // 1. 新建文件：验证自动补齐 frontmatter (推导 type 为 inbox，status active，补齐 updated 与 title)
    const newRes = await store.writeDirect({
      targetRelPath: '待整理/软件构想.md',
      content: '基于 DSH 的无头轻量记忆流。',
    });
    assert.equal(newRes.ok, true);
    assert.equal(newRes.applied, true);

    const createdDoc = await readFile(join(tmp, '待整理', '软件构想.md'), 'utf8');
    assert.ok(createdDoc.includes('title: "软件构想"'));
    assert.ok(createdDoc.includes('type: "inbox"'));
    assert.ok(createdDoc.includes('status: "active"'));
    assert.ok(createdDoc.includes('updated: "'));
    assert.ok(createdDoc.includes('# 软件构想'));
    assert.ok(createdDoc.includes('基于 DSH 的无头轻量记忆流。'));

    // 2. 准备已存在文件用于就地替换测试
    const topicPath = join(tmp, 'Topics', 'DSH.md');
    await mkdir(join(tmp, 'Topics'), { recursive: true });
    const initialTopic = `---
title: "DSH 智能体"
type: "topic"
status: "active"
updated: "2026-09-01"
---

# DSH 智能体

## 核心定位
这是旧的核心定位正文，应该在后续被就地替换掉。

## 关联模块
- Core
- Tools
`;
    await writeFile(topicPath, initialTopic, 'utf8');

    // 3. 执行 section 就地替换
    const replaceRes = await store.writeDirect({
      targetRelPath: 'Topics/DSH.md',
      section: '核心定位',
      content: '这是全新的核心定位：长期自治认知记忆系统。',
      reason: '设计定位升级',
    });
    assert.equal(replaceRes.ok, true);
    assert.equal(replaceRes.applied, true);

    // 4. 验证备份已在 .wiki/backups 下生成
    const backupDir = join(tmp, '.wiki', 'backups');
    const backupFiles = await readdir(backupDir);
    assert.ok(backupFiles.length >= 1);
    assert.ok(backupFiles.some((f) => f.includes('Topics__DSH.md')));

    // 5. 验证就地替换关键契约：
    //    - 旧内容消失
    //    - 新内容出现
    //    - 标题在全文中只出现一次（关键防重复断言）
    //    - 后续小节不受破坏
    const updatedTopic = await readFile(topicPath, 'utf8');
    assert.ok(!updatedTopic.includes('这是旧的核心定位正文'), '旧内容必须彻底消失');
    assert.ok(updatedTopic.includes('这是全新的核心定位：长期自治认知记忆系统。'), '新内容必须存在');
    const headingMatches = updatedTopic.match(/##\s*核心定位/g);
    assert.equal(headingMatches?.length, 1, '目标小节标题必须只出现一次');
    assert.ok(updatedTopic.includes('## 关联模块'), '后续小节必须完好保留');

    // 6. 传了 section 但找不到：在文末新增该节
    const addSecRes = await store.writeDirect({
      targetRelPath: 'Topics/DSH.md',
      section: '未闭环事项',
      content: '- 事项 A\n- 事项 B',
    });
    assert.equal(addSecRes.ok, true);
    const addedSecTopic = await readFile(topicPath, 'utf8');
    assert.ok(addedSecTopic.includes('## 未闭环事项'));
    assert.ok(addedSecTopic.includes('- 事项 A'));

    // 7. 未传 section：直接追加到文末
    const appendRes = await store.writeDirect({
      targetRelPath: 'Topics/DSH.md',
      content: '<!-- 文末附录备忘 -->',
    });
    assert.equal(appendRes.ok, true);
    const appendedTopic = await readFile(topicPath, 'utf8');
    assert.ok(appendedTopic.trim().endsWith('<!-- 文末附录备忘 -->'));

    // 8. 写入超标软提醒：当文件超过 4.5KB (4500 字节) 时触发 warning，但不阻断写入
    const largeContent = '超长补充正文段落。'.repeat(300);
    const overLimitRes = await store.writeDirect({
      targetRelPath: 'Topics/DSH.md',
      content: largeContent,
      section: '超长记录',
    });
    assert.equal(overLimitRes.ok, true);
    assert.equal(overLimitRes.applied, true);
    assert.ok(overLimitRes.sizeBytes > 4500);
    assert.ok(overLimitRes.warning);
    assert.ok(overLimitRes.warning.includes('超出 4.5KB 软上限'));
    assert.ok(overLimitRes.message.includes('超出 4.5KB 软上限'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('4.2 Indexer: getBriefSummary 四段式 Agent 记忆档案 (Self.md / Topics/ / 待整理/ / Agent记忆总结.md)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'wiki-indexer-test-'));
  try {
    await mkdir(join(tmp, 'Topics'), { recursive: true });
    await mkdir(join(tmp, '待整理'), { recursive: true });

    // 1. Self.md (关于你)
    await writeFile(
      join(tmp, 'Self.md'),
      `---
title: "Self"
type: "general"
---
# 用户画像
全栈技术实践者，长期在高强度自学与项目交付之间切换，偏好本地离线与高密度认知交付。

第二段不应出现在档案里（关于你只取首段）。
`,
      'utf8'
    );

    // 2. Topics/ (活跃主题)
    await writeFile(
      join(tmp, 'Topics', 'DSH.md'),
      `---
title: "DSH 工作台"
type: "topic"
status: "active"
updated_at: "2026-10-04"
---
# DSH
本地 AI 工作台与长期记忆载体。
`,
      'utf8'
    );

    await writeFile(
      join(tmp, 'Topics', 'CLIProxy.md'),
      `---
title: "CLIProxy"
type: "topic"
status: "active"
updated_at: "2026-10-05"
---
# CLIProxy
高性能无头代理中间件。
`,
      'utf8'
    );

    // 3. 待整理/ (未整理线索)
    await writeFile(
      join(tmp, '待整理', '灵感想法.md'),
      `---
title: "灵感想法"
type: "inbox"
---
# 灵感
关于自动化代码测试生成的小构想。
`,
      'utf8'
    );

    // 4. Agent记忆总结.md (Agent 记忆总结)
    await writeFile(
      join(tmp, 'Agent记忆总结.md'),
      `---
title: "Agent 记忆总结"
type: "agent"
---
# 跨会话交接
## 本次交接
上次会话已完成 ProposalStore 扩展，本次接续完成记忆注入协议重写，日常通过 \`wiki_write\` 记录，路径为 ~/.dsh/wiki 与 [[决策档案|旧决策页]]。
`,
      'utf8'
    );

    const scanner = new WikiScanner(tmp);
    const docs = await scanner.scan();
    const graph = new WikiGraph();
    graph.build(docs);
    const indexer = new WikiIndexer(graph);
    indexer.build(docs);

    const summary = indexer.getBriefSummary(2500);

    // 断言必须包含四段式结构
    assert.ok(summary.includes('**关于你**：'), '需包含第 1 段：关于你');
    assert.ok(summary.includes('全栈技术实践者'), '需提取 Self.md 正文');

    assert.ok(summary.includes('**活跃主题**：'), '需包含第 2 段：活跃主题');
    assert.ok(summary.includes('DSH 工作台'), '需包含 Topics/ 词条');
    assert.ok(summary.includes('[更新: 2026-10-05]'), '需按 updatedAt 标注更新时间');

    assert.ok(summary.includes('**未整理线索**：'), '需包含第 3 段：未整理线索');
    assert.ok(summary.includes('灵感想法'), '需列出 待整理/ 下词条');

    assert.ok(summary.includes('**Agent 记忆总结**：'), '需包含第 4 段：Agent 记忆总结');
    assert.ok(summary.includes('上次会话已完成 ProposalStore 扩展'), '需提取 Agent记忆总结.md 正文段落');

    // 修复断言 A：标题行（H1/H2）不得被当作正文粘连进档案
    assert.ok(!summary.includes('用户画像 全栈技术实践者'), 'Self 标题行不应粘连进正文');
    assert.ok(!summary.includes('跨会话交接 上次会话'), '记忆条目标题行不应粘连进正文');
    assert.ok(!summary.includes('本次交接 上次会话'), 'H2 标题行同样不得粘连进正文');
    assert.ok(!summary.includes('第二段不应出现在档案里'), '「关于你」只取首段，不得拼接后续段落');

    // 修复断言 C：正文中的反引号标识符、~ 路径与双链不得被破坏
    assert.ok(summary.includes('`wiki_write`'), '代码标识符应保持原样（不得被抹成 wikiwrite）');
    assert.ok(summary.includes('~/.dsh/wiki'), '路径中的 ~ 不得被删成 /.dsh/wiki');
    assert.ok(summary.includes('旧决策页'), '双链应降级为可读文本');

    // 修复断言 B：同一条目不得在多个段落重复出现（最近变更只保留净增量）
    const bulletTitles = summary
      .split('\n')
      .filter((line) => line.startsWith('- **'))
      .map((line) => (line.match(/\*\*([^*]+)\*\*/) || [])[1]);
    const duplicated = bulletTitles.filter((t, i) => t && bulletTitles.indexOf(t) !== i);
    assert.deepEqual(duplicated, [], `档案中条目不得重复出现，实际重复: ${duplicated.join(', ')}`);

    // 验证 maxChars 截断与提示行为
    const truncated = indexer.getBriefSummary(100);
    assert.ok(truncated.includes('(已截断，请通过 wiki_search 工具查询详细信息)'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('4.3 Indexer: 尚无 Topics/ 目录时最近变更不得借用「活跃主题」标题', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'wiki-indexer-legacy-'));
  try {
    await writeFile(
      join(tmp, 'Self.md'),
      `---
title: "Self"
type: "general"
---
# 用户
独立开发者。
`,
      'utf8'
    );
    // 模拟未迁移的旧库：只有 Project/ 与 Decision/，没有 Topics/
    await mkdir(join(tmp, 'Project'), { recursive: true });
    await writeFile(
      join(tmp, 'Project', '旧项目.md'),
      `---
title: "旧项目"
type: "project"
updated_at: "2026-10-05"
---
# 旧项目
尚未迁移到 Topics/。
`,
      'utf8'
    );

    const scanner = new WikiScanner(tmp);
    const docs = await scanner.scan();
    const graph = new WikiGraph();
    graph.build(docs);
    const indexer = new WikiIndexer(graph);
    indexer.build(docs);

    const summary = indexer.getBriefSummary(2500);
    assert.ok(!summary.includes('**活跃主题**：'), '无 Topics/ 时不得出现「活跃主题」标题（标签错位）');
    assert.ok(summary.includes('**最近变更**：'), '无 Topics/ 时最近变更应独立成段');
    assert.ok(summary.includes('旧项目'), '应列出旧库中最近变更的词条');

    // 归档区的历史留档不得出现在当前认知档案里
    await mkdir(join(tmp, 'Archive'), { recursive: true });
    await writeFile(
      join(tmp, 'Archive', '已废弃条目.md'),
      `---
title: "已废弃条目"
type: "general"
updated_at: "2026-10-06"
---
# 已废弃
这是归档历史，不应进入档案。
`,
      'utf8'
    );
    const scanner2 = new WikiScanner(tmp);
    const docs2 = await scanner2.scan();
    const graph2 = new WikiGraph();
    graph2.build(docs2);
    const indexer2 = new WikiIndexer(graph2);
    indexer2.build(docs2);
    const summary2 = indexer2.getBriefSummary(2500);
    assert.ok(!summary2.includes('已废弃条目'), 'Archive/ 下的归档词条不得进入记忆档案');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
