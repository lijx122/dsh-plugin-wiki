# dsh-plugin-wiki

DeepSeek Harness (DSH) 长期认知记忆与 Markdown Wiki 插件。

## 核心架构原则与设计定位

1. **人类层（静态底座）**：
   - `AGENTS.md`：全局行为准则与纪律约束（静态行为基准，严禁写入 Wiki）；
   - Wiki 库：`Self.md`、`Topics/*.md`、`待整理/*.md`，客观事实、项目演化与技术决策。
2. **Agent 记忆层（动态追溯）**：
   - **Agent 记忆总结 (`Agent记忆总结.md`)**：放在 Wiki 根目录，由 Agent 自主维护的高密度交接纪要与项目断点概览；
   - **历史会话上下文检索工具 (`wiki_recall_session`)**：对 DSH 底层物理保存的 800+ 个历史会话（`~/.dsh/sessions/**/*.zstd`）进行定位与精准检索，按时间或内容**只选择性提取 1~2 段紧凑切片**，严禁把整个会话全量喂给 AI。

## 特性

- **Agent 长期认知记忆**：定位为智能体的长期认知记忆（记录用户长期事实、项目演化与设计推翻），默认直接落盘，支持认知迭代与就地纠错。
- **安全直接落盘与自动备份**：写入已有词条前自动备份至 `.wiki/backups`，支持指定二级小节就地替换正文，彻底避免内容重复堆叠与自相矛盾。
- **可选人工审批模式**：通过 `requireApproval` 配置可将写入降级为提案待审核模式（保留 `/wiki approve` 机制）。
- **会话基线 + 小节增量注入**：见下方「上下文注入行为」。
- **物理历史会话定向 Recall**：纯 Node 原生（基于 `node:zlib`）多帧 Zstandard 解码，两级极速剪枝，单轮紧凑抽取，毫秒级响应。
- **轻量秒级检索与拓扑图**：纯 Node.js 内存倒排索引与双链拓扑图谱，零外部大型数据库依赖。

## 上下文注入行为

- **静态协议**：通过 `systemPrompt.section`（`wiki:protocol`）注册一段固定的查阅/写入约定，不随 Wiki 内容变化，不影响系统提示词前缀缓存。
- **会话基线（每会话一次）**：在会话的第一个真实用户提问步（`agent/pre-step`），追加一条 `source.kind = 'wiki-context'` 的 user 消息，包含：
  - `关于你`：`Self.md` 的摘要（≤200 字）；
  - `主题索引`：`Topics/` 下未归档词条，每行 `- 标题 [status] (updated): 摘要`（摘要 ≤80 字，最多 12 行）；
  - 一行指引：完整内容用 `wiki_read` / `wiki_search` 获取。
  总长受 `maxContextTokens × 2.5` 字符限制。
- **小节增量**：之后每个用户提问步，把全库 `##` 小节的内容哈希与本会话最近一次注入记录的哈希比较，只注入新增/变更小节的最新内容（单节 ≤600 字、合计 ≤2400 字，超出部分仅列出位置）以及已删除的小节；没有变化时不注入。工具续步、被拒绝的步不受影响。
- `Archive/` 目录与 `status: archived` 的词条不参与基线与增量。

### 词条约定

- **`brief` frontmatter**：写一句话摘要，存在时直接作为词条摘要（主题索引、搜索结果都用它），否则取正文首段或 `## 摘要`。
- **`## 当前状态`**：主题词条保留这一节作为当前结论的唯一来源，用 `wiki_write` 的 `section: "当前状态"` 就地替换更新。
- `wiki_write` 写入已有文件时会把 frontmatter 的 `updated` 刷新为当天日期（无 frontmatter 的文件不改动），并在出现重复或空的 `##` 标题时返回 `warning`。

## 快速配置

默认情况下无需任何额外配置，插件会自动使用：
`~/.dsh/wiki`（Windows 下为 `C:\Users\<用户名>\.dsh\wiki`）。

若需要自定义，可在 DSH 插件配置中设置：

```yaml
wiki:
  path: ""                # 可选，默认使用 ~/.dsh/wiki
  maxContextTokens: 1500  # 会话基线注入的最大估算 token 限制
  autoWatch: true         # 开启文件变动热重新索引
  requireApproval: false  # 是否开启人工审批（默认 false，直接落盘）
```

## 命令与工具

### 用户斜杠命令 (Slash Commands)
- `/wiki status` - 查看 Wiki 词条总数、链接数与待处理提案
- `/wiki recent [n]` - 查看最近变更的若干词条列表（按更新时间倒序）
- `/wiki list` - 列出所有未确认的修改提案（审批模式开启时使用）
- `/wiki diff <id>` - 预览某提案的具体修改内容
- `/wiki approve <id>` - 批准提案并安全合入对应 Markdown
- `/wiki reject <id>` - 废弃提案
- `/wiki reindex` - 重新扫描与构建索引

### Agent Tools (四工具面)
- `wiki_search(query, type?, limit?)` - 在长期记忆库中搜索词条、匹配摘要与双链网络
- `wiki_read(path, headingsOnly?, section?)` - 读取词条全文、大纲树或定向读取指定小节
- `wiki_write(targetRelPath, content, section?, title?, reason?)` - 写入或更新词条。默认直接落盘，支持小节就地替换与新建词条补齐 Frontmatter
- `wiki_recall_session(query?, since?, until?, workspace?, limit?)` - 定向召回物理历史会话上下文切片（基于 `~/.dsh/sessions` 多帧 zstd 日志），仅提取 1~2 段高密度紧凑切片
