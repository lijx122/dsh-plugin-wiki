# dsh-plugin-wiki

DeepSeek Harness (DSH) 个人长期上下文与 Markdown Wiki 插件。

## 特性

- **数据物理隔离**：Wiki 是纯本地 Markdown 文件，代码与知识库解耦。
- **默认无侵入路径**：默认存取于当前用户主目录 `~/.dsh/wiki`，无需指定绝对路径。
- **系统上下文注入**：通过 DSH `systemPrompt` 动态向 Agent 提供个人背景、核心项目与偏好摘要。
- **AI 提议 + 人类终审**：AI 发现重要长期信息后通过 `wiki_propose` 提交提案，用户通过 `/wiki approve` 确认写入，防止上下文污染。
- **轻量秒级检索**：纯 Node.js 内存倒排索引与双链拓扑图谱，零外部大型数据库依赖。

## 快速配置

默认情况下无需任何额外配置，插件会自动使用：
`~/.dsh/wiki`（Windows 下为 `C:\Users\<用户名>\.dsh\wiki`）。

若需要自定义目录，在 `~/.dsh/settings.yaml` 中配置：

```yaml
wiki:
  path: "custom/relative/or/absolute/path" # 可选，默认使用 ~/.dsh/wiki
  maxContextTokens: 1500                  # 注入上下文的最大 token 限制
  autoWatch: true                         # 开启文件变动热重新索引
```

## 命令与工具

### 用户斜杠命令 (Slash Commands)
- `/wiki status` - 查看 Wiki 词条总数、链接数与待处理提案
- `/wiki list` - 列出所有未确认的修改提案
- `/wiki diff <id>` - 预览某提案的具体修改内容
- `/wiki approve <id>` - 批准提案并安全合入对应 Markdown
- `/wiki reject <id>` - 废弃提案
- `/wiki reindex` - 重新扫描与构建索引

### Agent Tools
- `wiki_search(query, type?)` - 搜索词条与关联
- `wiki_read(path)` - 读取词条全文
- `wiki_propose(target, title, section, content, reason, confidence)` - 提交修改提议
- `wiki_create(type, title, content)` - 创建新词条草稿
