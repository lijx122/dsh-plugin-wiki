import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

import { scanZstdFrames, decompressSessionZstd } from '../lib/core/session-decoder.js';
import { SessionScanner, decodeWorkspaceDirName, parseDateBoundary, formatTimestamp, cleanUserText, cleanAssistantText } from '../lib/core/session-scanner.js';

test('1. 多帧 Zstandard 流解析与解压缩 (scanZstdFrames & decompressSessionZstd)', async () => {
  const line1 = JSON.stringify({ type: 'session', id: 's1', createdAt: 1700000000000 }) + '\n';
  const line2 = JSON.stringify({ type: 'user/message', data: { content: '你好' } }) + '\n';
  const line3 = JSON.stringify({ type: 'assistant/message', data: { content: [{ type: 'text', text: '你好！' }] } }) + '\n';

  // 模拟 DSH 追加写入：多帧独立流拼接
  const frame1 = zlib.zstdCompressSync(Buffer.from(line1, 'utf8'));
  const frame2 = zlib.zstdCompressSync(Buffer.from(line2, 'utf8'));
  const frame3 = zlib.zstdCompressSync(Buffer.from(line3, 'utf8'));
  const multiFrameBuffer = Buffer.concat([frame1, frame2, frame3]);

  // 1. scanZstdFrames 应精确切分出 3 帧
  const frames = scanZstdFrames(multiFrameBuffer);
  assert.equal(frames.length, 3, '应扫描出 3 个独立 Zstd Frame');
  assert.equal(frames[0].start, 0);
  assert.equal(frames[0].end, frame1.length);
  assert.equal(frames[1].start, frame1.length);
  assert.equal(frames[2].end, multiFrameBuffer.length);

  // 2. 单帧解压缩只会读取第 1 帧，遗漏后续消息
  const singleDecomp = zlib.zstdDecompressSync(multiFrameBuffer).toString('utf8');
  assert.ok(singleDecomp.includes('s1'));
  assert.ok(!singleDecomp.includes('你好'), '单帧解压应遗漏第 2、3 帧');

  // 3. 多帧流解压器完整还原所有行
  const fullDecomp = decompressSessionZstd(multiFrameBuffer);
  assert.ok(fullDecomp.includes('s1'));
  assert.ok(fullDecomp.includes('你好'));
  assert.ok(fullDecomp.includes('你好！'));

  // 4. 非 Zstd 纯文本 buffer 降级保护
  const plainBuf = Buffer.from('plain json text\n', 'utf8');
  assert.equal(decompressSessionZstd(plainBuf), 'plain json text\n');
});

test('2. 目录解码、日期解析与文本清洗防御机制', () => {
  // 1. Unicode 转义目录名解码
  const rawDir = '--D-B~7AD9~8BFE~7A0B-~7533~8BBA~7CFB~7EDF~8BFE--';
  const decoded = decodeWorkspaceDirName(rawDir);
  assert.equal(decoded, '--D-B站课程-申论系统课--');

  // 2. 日期边界解析
  const startMs = parseDateBoundary('2026-10-08', false);
  const endMs = parseDateBoundary('2026-10-08', true);
  assert.ok(typeof startMs === 'number');
  assert.ok(typeof endMs === 'number');
  assert.ok(endMs > startMs);
  assert.ok(formatTimestamp(startMs).startsWith('2026-10-08'));

  // 3. 用户文本系统噪音清洗
  const dirtyUserPrompt = `
<system-reminder>
Current device time: 2026年10月08日
</system-reminder>
<environment_context>
  <cwd>C:\\Users\\l</cwd>
</environment_context>
写成html或者pdf帮我总结公式
Current runtime context. This snapshot supersedes earlier runtime-context snapshots.
### Agent 记忆档案
**关于你**：测试用户
<available_skills>
- test-skill
</available_skills>
`;
  const cleaned = cleanUserText(dirtyUserPrompt);
  assert.equal(cleaned, '写成html或者pdf帮我总结公式', '系统注入与标签必须彻底剔除');

  // 4. 助手长回复截断（严禁全量注水）
  const longText = 'A'.repeat(800);
  const truncated = cleanAssistantText(longText, 400);
  assert.equal(truncated.length, 403);
  assert.ok(truncated.endsWith('...'));
});

test('3. SessionScanner 真实场景模拟：两级剪枝、关键词与时间范围切片检索', async () => {
  const tmpSessions = await mkdtemp(join(tmpdir(), 'dsh-sessions-test-'));

  try {
    // 创建测试工作区 1: 申论工作区 (带 Unicode 转义目录)
    const ws1Dir = join(tmpSessions, '--D-B~7AD9~8BFE~7A0B-~7533~8BBA~7CFB~7EDF~8BFE--');
    const s1Dir = join(ws1Dir, 'session-exam-001');
    await mkdir(s1Dir, { recursive: true });

    // 创建测试工作区 2: 普通工作区
    const ws2Dir = join(tmpSessions, '--MyProject--');
    const s2Dir = join(ws2Dir, 'session-proj-002');
    await mkdir(s2Dir, { recursive: true });

    const baseTime = new Date('2026-10-08T10:00:00Z').getTime();

    // 组装 session-exam-001 的 JSONL 数据
    const s1Lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'session-exam-001', createdAt: baseTime, cwd: 'D:\\B站课程\\申论系统课' }),
      // Turn 1: 资料分析公式
      JSON.stringify({
        type: 'user/message',
        time: baseTime + 1000,
        data: {
          content: [
            { type: 'text', text: '<system-reminder>Current time: 10:00</system-reminder>' },
            { type: 'text', text: '请帮我整理资料分析合分比定理与等比性质速算公式' },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        time: baseTime + 2000,
        data: {
          message: {
            content: [
              { type: 'reasoning', text: 'Analyzing math formulas...' },
              { type: 'text', text: '已为你整理好资料分析合分比定理：若 a/b = c/d，则 (a+c)/(b+d) = a/b。' + '详细展开内容。'.repeat(100) },
            ],
          },
        },
      }),
      // Turn 2: PDF 排版要求
      JSON.stringify({
        type: 'user/message',
        time: baseTime + 10000,
        data: {
          content: '请重新排版成单页无缝长图 PDF，不要分成两页',
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        time: baseTime + 12000,
        data: {
          message: {
            content: [
              { type: 'text', text: '已将 PDF 彻底重构为一页到底的无缝长图单页版，适合顺滑滚动背诵。' },
            ],
          },
        },
      }),
    ];

    // 以多帧 Zstandard 写入 session-exam-001
    const s1CompressedFrames = s1Lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8')));
    await writeFile(join(s1Dir, 'session.v3.jsonl.zstd'), Buffer.concat(s1CompressedFrames));

    // 组装 session-proj-002 的数据 (普通非 zstd jsonl)
    const s2Lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'session-proj-002', createdAt: baseTime + 50000, cwd: 'C:\\Work\\MyProject' }),
      JSON.stringify({
        type: 'user/message',
        time: baseTime + 51000,
        data: { content: '实现分布式分布式锁' },
      }),
      JSON.stringify({
        type: 'assistant/message',
        time: baseTime + 52000,
        data: {
          content: [{ type: 'text', text: '使用 Redis Redlock 算法实现。' }],
        },
      }),
    ];
    await writeFile(join(s2Dir, 'session.jsonl'), s2Lines.join('\n') + '\n', 'utf8');

    const scanner = new SessionScanner(tmpSessions);

    // 1. 关键词检索：检索 "合分比定理"
    const r1 = await scanner.recall({ query: '合分比定理' });
    assert.equal(r1.found, true);
    assert.equal(r1.count, 1);
    assert.equal(r1.snippets[0].sessionId, 'session-exam-001');
    assert.equal(r1.snippets[0].workspace, '申论系统课');
    assert.ok(r1.snippets[0].userText.includes('合分比定理'));
    // 断言助手消息被截断至 400 字左右（非全量注水）
    assert.ok(r1.snippets[0].assistantText.length <= 405);
    assert.ok(r1.snippets[0].assistantText.endsWith('...'));
    assert.ok(!r1.snippets[0].userText.includes('<system-reminder>'), '用户文本不得含有 system-reminder');
    assert.ok(r1.text.includes('[会话: session-exam-001 | 时间:'));

    // 2. 工作区过滤：仅检索申论工作区
    const r2 = await scanner.recall({ workspace: '申论', limit: 2 });
    assert.equal(r2.found, true);
    assert.equal(r2.count, 2);
    // 验证按时间倒序（最新一轮优先）
    assert.ok(r2.snippets[0].userText.includes('单页无缝长图 PDF'));
    assert.ok(r2.snippets[1].userText.includes('合分比定理'));

    // 3. 时间过滤：since 剪枝
    const r3 = await scanner.recall({ since: '2026-10-09' });
    assert.equal(r3.found, false, '未来的时间应被剪枝过滤');
    assert.equal(r3.count, 0);

    // 4. 未匹配关键词返回
    const r4 = await scanner.recall({ query: '不存在的随机词汇' });
    assert.equal(r4.found, false);
    assert.equal(r4.count, 0);
    assert.ok(r4.text.includes('未在历史会话中找到匹配切片'));
  } finally {
    await rm(tmpSessions, { recursive: true, force: true });
  }
});
