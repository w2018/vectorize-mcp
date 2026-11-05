# Vectorize MCP：统一长期记忆服务

一次部署，为全平台、全 Agent 提供同一套会话记忆后端。数据保存在本地 SQLite，内置中文 Web 管理后台。一个有效 Token 对应一个独立账户，同一 Token 可被多个客户端共用；管理员密码与 MCP Token 相互独立。

## 功能

- **统一接口**：Streamable HTTP MCP 与 stdio 桥接，Bearer 鉴权，账户间数据隔离。
- **记忆操作**：查询、写入、更新、保守归档、精确去重、版本校验与幂等重试。
- **召回约束**：直接命中、关联联想与画像结果合计 0～5 条，默认 3 条，按权重排序并受预算约束。
- **存储**：单写多读 worker、有界队列、主业务库与独立观察日志库。
- **后台**：记忆、画像、可回溯的 three.js 3D 星图、统计、回收站、设置、导入导出、本地备份与 WebDAV 云端备份、审计。账户即数据边界，不设额外空间层级。
- **QQBOT**：独立账户提供人物、概念、人设记忆与自定义关系；可配置人设、边界、五套预设，并通过 `w_memory_bootstrap` 读取受预算约束的启动上下文。

## 环境要求

Node.js 24.x 与 npm。依赖含 SQLite 原生模块，安装失败时检查 Node 版本、系统架构与构建环境。

## 安装启动

Windows PowerShell：

```powershell
node --version
npm ci
npm run build
$env:DATA_DIR = "./data"
$env:ADMIN_PASSWORD = "请替换为至少12个字符的管理员密码"
npm run init-admin
Remove-Item Env:ADMIN_PASSWORD
npm start
```

初始化只在本机保存 scrypt 哈希；已有管理员文件时拒绝覆盖。启动与初始化必须使用同一个 `DATA_DIR`。生成环境变量文件后可参考 `.env.example`，并用 `node --env-file=.env dist/server/main.js` 启动。

打开 <http://127.0.0.1:3100>，用管理员密码登录，在“账户与凭据”中创建账户并保存**仅展示一次**的 Token。忘记时撤销旧凭据并重新签发即可。

## 配置

| 变量 | 说明 |
| --- | --- |
| `DATA_DIR` | 数据目录，默认 `data`，建议使用固定绝对路径 |
| `HOST` / `PORT` | 监听地址与端口，默认 `127.0.0.1:3100` |
| `PUBLIC_ORIGIN` | 浏览器实际访问的完整 origin，无末尾斜杠 |
| `ADMIN_PASSWORD` | 仅用于 `npm run init-admin` |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIMENSION` | 可选编码器，三项同时设置或全部省略 |
| `EMBEDDING_API_KEY` | 可选服务端编码器密钥，不通过后台返回 |

远程访问需 HTTPS 反向代理，并把 `PUBLIC_ORIGIN` 设为该 HTTPS 地址。后端监听地址与公开 origin 是两个设置。

## 连接 MCP

HTTP 客户端填写 `http://127.0.0.1:3100/mcp`，并发送请求头 `Authorization: Bearer <后台Token>`。远程使用 HTTPS。

仅支持 stdio 的客户端启动桥接器（需先构建）：

```json
{
  "mcpServers": {
    "vectorize": {
      "command": "node",
      "args": ["D:/apps/vectorize-mcp/dist/mcp/stdio.js"],
      "env": {
        "MCP_URL": "http://127.0.0.1:3100/mcp",
        "MCP_TOKEN": "<后台Token>"
      }
    }
  }
}
```

桥接器对可安全重放的工具调用做有限抖动重试，保持原始参数与 `request_id`；鉴权、业务校验与版本冲突不自动重试。

## 编码器与检索

可先不配置编码器运行，此时明确使用词法检索，不生成伪向量。配置后由后台“设置”预览并发布地址、模型与维度；更换模型会分批重建索引，未就绪期间可能退回词法结果。远程编码器会接收需要编码的内容，请自行评估数据隐私。

## 数据与备份

只支持**单个服务实例**使用同一数据目录，勿多实例共享。默认布局：

```text
data/
  admin-password.json          管理员密码哈希
  memory.sqlite                主数据库
  memory.sqlite.logs.sqlite    独立观察日志库
  memory.sqlite.trash.sqlite   回收站快照库
  memory.sqlite.instance-lock  单实例锁
  webdav.json / webdav.key     云端备份地址（密码加密）与本地密钥
  backups/                     已登记的主库备份
```

本地备份在后台上可查看实际存放路径、填写描述、连同文件删除；恢复前先做预检并需二次确认。

云端备份支持 WebDAV（默认坚果云 `https://dav.jianguoyun.com/dav/`，也可自填地址），默认远端目录 `vectorize-mcp`。密码经 AES-256-GCM 加密保存，密钥文件仅本机可读。云端恢复会把快照下载到系统临时目录并实时输出下载进度、完整性、外键、数据结构版本与各表数量，确认后才写入主库。

恢复主库会撤销全部旧 Token 并清除后台会话，需重新签发。不要直接复制运行中的数据库文件作为备份。

数据结构版本为 3；早期版本的数据库不再兼容，需按「后台导出 → 重建空库 → 导入」迁移，旧数据目录建议先整体归档。

## 开发

```sh
npm run typecheck
npm run build
npm run dev
```

前端改动需重新构建。自动化测试与本地设计文档仅保存在维护者本地 `tmp/` 目录，不进入仓库。

## 建议给 Agent 的使用约定

在客户端系统提示词或项目 `AGENTS.md` 中加入（凭据页「接入方式」可一键复制完整文案）：先判断当前需求是否需要长期记忆，再调用 `w_memory_search`，只使用相关结果；用户明确偏好、稳定画像、项目决定与可复用经验可写入，临时闲聊不写；写入前先检索去重，更新携带当前 revision；每个逻辑变更生成新 `request_id`，网络重试沿用原 ID 与参数；优先更新或归档，不轻易永久删除；不要保存访问密钥，不把猜测当作用户确认的事实。

## 当前限制

- 向量查询为精确扫描，未完成十万条规模与长期并发压测，不按 ANN 容量规划。
- Linux/Docker 与真实外部编码器尚未实机验收。
- JSON 导入在内存中解析，单份上限 100 MiB；逻辑导出不含完整修订历史。
- 登录会话与导入暂存保存在单进程内存，重启后需重新登录与预检。

版本与变更见 [版本变更记录](doc/版本变更记录.md)。
