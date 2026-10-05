# dsh-plugin-wiki

DeepSeek Harness (DSH) 长期认知记忆与 Markdown Wiki 插件。

## 特性

- **Agent 长期认知记忆**：定位为智能体的长期认知记忆（记录用户长期事实、项目演化与设计推翻），默认直接落盘，支持认知迭代与就地纠错。
- **安全直接落盘与自动备份**：写入已有词条前自动备份至 `.wiki/backups`，支持指定二级小节就地替换正文，彻底避免内容重复堆叠与自相矛盾。
- **可选人工审批模式**：通过 `requireApproval` 配置可将写入降级为提案待审核模式（保留 `/wiki approve` 机制）。
- **四段式记忆档案注入**：通过 DSH `systemPrompt` 动态向 Agent 注入结构化记忆档案（关于你 `Self.md`、活跃主题 `Topics/` 与最近变更、未整理线索 `待整理/`、交接记忆 `Agent/记忆.md`）。
- **轻量秒级检索与拓扑图**：纯 Node.js 内存倒排索引与双链拓扑图谱，零外部大型数据库依赖。

## 快速配置

默认情况下无需任何额外配置，插件会自动使用：
`~/.dsh/wiki`（Windows 下为 `C:\Users\<用户名>\.dsh\wiki`）。

若需要自定义，可在 DSH 插件配置中设置：

```yaml
wiki:
  path: ""                # 可选，默认使用 ~/.dsh/wiki
  maxContextTokens: 1500  # 注入上下文的最大 token 限制
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

### Agent Tools
- `wiki_search(query, type?, limit?)` - 在长期记忆库中搜索词条、匹配摘要与双链网络
- `wiki_read(path, headingsOnly?, section?)` - 读取词条全文、大纲树或定向读取指定小节
- `wiki_write(targetRelPath, content, section?, title?, reason?)` - 写入或更新词条。默认直接落盘，支持小节就地替换与新建词条补齐 Frontmatter
