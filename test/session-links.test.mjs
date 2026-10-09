import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { SessionLinksIndex } from '../lib/core/session-links.js';

test('1. SessionLinksIndex 双向链接添加、反查、持久化与重启加载', async () => {
  const tmpWiki = await mkdtemp(join(tmpdir(), 'wiki-links-test-'));

  try {
    const links = new SessionLinksIndex(tmpWiki);
    await links.init();

    // 1. 添加会话关联
    await links.addLink('session-alpha-101', 'Topics/DSH.md', 'DSH工作台', 'dsh-plugin-wiki');
    await links.addLink('session-alpha-101', 'Self.md');
    await links.addLink('session-exam-202', 'Topics/2026公考.md', '2026公考', '申论系统课');

    // 2. Topic 反查 (包含精确与模糊子串匹配)
    const dshSessions = links.getSessionsByTopic('DSH工作台');
    assert.deepEqual(dshSessions, ['session-alpha-101']);

    const dshFuzzySessions = links.getSessionsByTopic('DSH');
    assert.deepEqual(dshFuzzySessions, ['session-alpha-101']);

    const examSessions = links.getSessionsByTopic('公考');
    assert.deepEqual(examSessions, ['session-exam-202']);

    const nonExistSessions = links.getSessionsByTopic('未定义主题');
    assert.deepEqual(nonExistSessions, []);

    // 3. WikiRef 反查
    const refSessions = links.getSessionsByWikiRef('Topics/DSH.md');
    assert.deepEqual(refSessions, ['session-alpha-101']);

    const selfRefSessions = links.getSessionsByWikiRef('Self.md');
    assert.deepEqual(selfRefSessions, ['session-alpha-101']);

    // 4. SessionId 正向查询 (带 topics 与 wikiRefs)
    const entry1 = links.getWikiRefsBySession('session-alpha-101');
    assert.ok(entry1);
    assert.deepEqual(entry1.topics, ['DSH工作台']);
    assert.deepEqual(entry1.wikiRefs, ['Topics/DSH.md', 'Self.md']);

    // 兼容 session_ 前缀查验
    const entry1Prefix = links.getWikiRefsBySession('session_alpha-101');
    assert.ok(entry1Prefix);
    assert.deepEqual(entry1Prefix.topics, ['DSH工作台']);

    const nullEntry = links.getWikiRefsBySession('session-not-exist');
    assert.equal(nullEntry, null);

    // 5. 验证文件已成功持久化至 .wiki/session-links.json
    const jsonPath = join(tmpWiki, '.wiki', 'session-links.json');
    assert.ok(existsSync(jsonPath));
    const savedRaw = await readFile(jsonPath, 'utf8');
    const savedObj = JSON.parse(savedRaw);
    assert.ok(savedObj['session-alpha-101']);
    assert.equal(savedObj['session-alpha-101'].workspace, 'dsh-plugin-wiki');

    // 6. 模拟新实例冷启动加载
    const newLinksInstance = new SessionLinksIndex(tmpWiki);
    await newLinksInstance.init();
    const reloadedEntry = newLinksInstance.getWikiRefsBySession('session-alpha-101');
    assert.ok(reloadedEntry);
    assert.deepEqual(reloadedEntry.topics, ['DSH工作台']);
    assert.deepEqual(newLinksInstance.getSessionsByTopic('2026公考'), ['session-exam-202']);
  } finally {
    await rm(tmpWiki, { recursive: true, force: true });
  }
});
