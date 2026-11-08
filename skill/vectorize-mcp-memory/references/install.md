# 安装与排查（DSH）

本技能源目录：`D:\Harness_Work\vectorize-mcp\skill\vectorize-mcp-memory`。DSH **不会**自动扫描这个位置，必须放到下面的扫描根之一。

## 发现规则（源码事实，@deepseek-ai/dsh-skill-filesystem）

| Rank | 来源 | 路径 |
|---|---|---|
| 100 | project-dsh | `<项目根>\.dsh\skills` |
| 200 | project-agents | `<项目根>\.agents\skills` |
| 300 | custom | 配置项 `customSkillDirs` |
| 400 | user-dsh | `C:\Users\<你>\.dsh\skills` |
| 500 | user-agents | `C:\Users\<你>\.agents\skills` |

- 项目根 = 最近一个含 `.git` 的祖先目录（本项目即 `D:\Harness_Work\vectorize-mcp`）。
- **只认 `<root>\<name>\SKILL.md` 或 `<root>\<name>.md`，深度一层**；嵌套的 `**\SKILL.md` 不发现。
- frontmatter 必填 `name`（kebab-case）与 `description`；渲染进目录时 description 截断到 500 字符。任一无效，整条 skill 被静默丢弃（只留日志警告）。
- 已有根的 watcher 深度为 1；`write` / `edit` 还会主动失效提供方，因此新增或修改**无需重启** DSH。

## 方式 A：项目级（推荐）

```pwsh
New-Item -ItemType Directory -Force 'D:\Harness_Work\vectorize-mcp\.dsh\skills' | Out-Null
New-Item -ItemType SymbolicLink -Path 'D:\Harness_Work\vectorize-mcp\.dsh\skills\vectorize-mcp-memory' -Target 'D:\Harness_Work\vectorize-mcp\skill\vectorize-mcp-memory'
```

没有符号链接权限时改成复制：

```pwsh
Copy-Item 'D:\Harness_Work\vectorize-mcp\skill\vectorize-mcp-memory' 'D:\Harness_Work\vectorize-mcp\.dsh\skills\vectorize-mcp-memory' -Recurse
```

## 方式 B：全局

复制到 `C:\Users\<你>\.dsh\skills\vectorize-mcp-memory`，所有项目可用。

## 方式 C：自定义根

在 profile 的 `cordis.yml` 里给 filesystem skill 提供方加 `customSkillDirs`，指向 `D:/Harness_Work/vectorize-mcp/skill`。注意该目录的**每个直接子项**都会被当作候选扫描，不要在里面放散落的 `.md` 文件。

## 验证

1. 新建会话，问「你还记得我叫什么？」；模型目录里应出现 `vectorize-mcp-memory`，并先调 `w_memory_search`。
2. 手动加载：调用 `skill` 工具，`name: "vectorize-mcp-memory"`，应返回 SKILL.md 正文与资源指引。
3. 工具在场：`w_memory_config_get` 返回 `{"ok":true,...}`。

## 「agent 找不到」排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 目录里完全没这个 skill | 放错目录，或嵌套太深 | 放到 `<root>\<name>\SKILL.md` |
| 其它 skill 在、这个不在 | name 非 kebab-case、缺 description、或 `disable-model-invocation: true` | 修正 frontmatter |
| skill 能加载但工具不存在 | MCP 未接入 / 连接失败 | 查客户端配置、Bearer、服务 `/health` |
| 工具在但返回 401 | token 失效、含空格、或同时发了两个 Authorization | 重新签发并按格式重配 |
| 很少被主动触发 | description 缺场景词 | 补「记忆 / 记住 / 回忆 / 用户画像」等关键词 |