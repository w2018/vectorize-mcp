# Vectorize MCP：统一长期记忆服务

一次部署，为全平台、全 Agent 提供同一套会话记忆后端。数据保存在本地 SQLite，内置中文 Web 管理后台。一个有效 Token 对应一个独立账户，同一 Token 可被多个客户端共用；管理员密码与 MCP Token 相互独立。

## 功能

- **统一接口**：Streamable HTTP MCP 与 stdio 桥接，Bearer 鉴权，账户间数据隔离。
- **记忆操作**：查询、写入、更新、保守归档、精确去重、版本校验与幂等重试。
- **召回约束**：直接命中、关联联想与画像结果合计 0～5 条，默认 3 条，按相关度 × 重要度 × 类型半衰期时间衰减排序，并受预算约束。
- **相似关系**：独立 `memory_similarity` 表按记忆 ID 自动关联高相似内容，检索时同一相似簇只返回一条代表，减少重复内容与模型阅读负担；管理后台 3D 星图同时展示自动相似边（只读）。
- **存储**：单写多读 worker、有界队列、主业务库与独立观察日志库。
- **后台**：记忆、画像、可回溯的 three.js 3D 星图、统计（含标注 Hit@1/Hit@3）、回收站、设置、导入导出、本地备份与 WebDAV 云端备份、审计。账户即数据边界，不设额外空间层级。
- **手机端**：按浏览器 UA 自动切换手机布局（抽屉导航、单列卡片、可滚动表格），PC 布局不变。
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

Linux / macOS：

```sh
node --version
npm ci
npm run build
export DATA_DIR="$PWD/data"
ADMIN_PASSWORD="请替换为至少12个字符的管理员密码" npm run init-admin
unset ADMIN_PASSWORD
npm start
```

> Linux 前置依赖：Node.js 24.x、npm，以及编译原生模块所需的构建环境（Debian/Ubuntu 上为 `build-essential python3`，RHEL/CentOS 上为 `gcc-c++ make python3`）。若 `npm ci` 安装失败，先升级 Node 版本或补装构建工具。

Windows 与 Linux 行为一致：初始化只在本机保存 scrypt 哈希；已有管理员文件时拒绝覆盖。启动与初始化必须使用同一个 `DATA_DIR`。生成环境变量文件后可参考 `.env.example`，并用 `node --env-file=.env dist/server/main.js` 启动。

打开 <http://127.0.0.1:3100>，用管理员密码登录，在“账户与凭据”中创建账户并保存**仅展示一次**的 Token。忘记时撤销旧凭据并重新签发即可。

## 配置

| 变量 | 说明 |
| --- | --- |
| `DATA_DIR` | 数据目录，默认 `data`，建议使用固定绝对路径 |
| `ADMIN_PASSWORD` | 仅用于 `npm run init-admin` |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIMENSION` | 可选编码器，**三项必须同时设置或全部省略**；只设一部分会被配置校验拒绝 |
| `EMBEDDING_API_KEY` | 可选的编码器密钥兜底来源；界面保存的密钥优先（见下）。两者都不会被接口回显 |

### 向量编码器（语义检索）

「设置 → 高级设置 → 向量编码器」提供预设下拉，选中后自动填入三项：

| 预设 | baseUrl | model | 默认维度 | 可调维度 | 是否需要 Key |
| --- | --- | --- | --- | --- | --- |
| OpenAI 官方 | `https://api.openai.com/v1` | `text-embedding-3-small` | 1536 | 1536 / 1024 / 512 | 是 |
| 阿里云百炼 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `text-embedding-v3` | 1024 | 1024 / 768 / 512 | 是 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `embedding-3` | 2048 | 256 ～ 2048 | 是 |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `nomic-embed-text` | 768 | 固定 768 | 否 |
| 本地 LM Studio | `http://127.0.0.1:1234/v1` | `text-embedding-nomic-embed-text-v1.5` | 768 | 固定 768 | 否 |

- **baseUrl 填到 `/v1` 这一层**，程序自动追加 `/embeddings`（拉取模型时追加 `/models`）；写成 `.../v1/embeddings` 会 404。
- **维度可留空**：点「测试连接」会读回服务真实输出的维度并自动填入表单；维度写错时测试会明确提示「服务实际返回 N 维」。请求体会带 `dimensions` 字段，服务不支持时自动退回默认维度重试一次。
- **维度怎么选**：每条记忆向量占 `4 字节 × 维度`，检索是逐条比对、没有 ANN 索引，所以维度直接决定存储与扫描耗时。5000 条记忆下 2048 维约 41 MB、1024 维约 20 MB；精度足够时优先 1024（或中文场景 768）。
- **API Key 可在界面填写**：加密后落在 `<DATA_DIR>/embedding-secret.json`，密钥文件 `embedding-secret.key` 独立保存（0600）。接口只返回 `has_key` / `source`（`file` | `env`），永不回显明文；留空保存表示保持现状，只有「清除密钥」才删除。优先级：加密文件 > 环境变量 `EMBEDDING_API_KEY`。
- **模型名可以从服务拉取**：点「拉取模型」调用 `GET {baseUrl}/models`，从下拉里选，避免手打错名字导致 `model mismatch`。
- **保存前先点「测试连接」**：用草稿配置真实请求一次，不写库、不切换当前配置，返回实际维度、耗时或具体失败原因（地址非法 / 401 鉴权 / 维度不匹配 / 超时）。
- 三项全部留空表示不使用语义检索；配置有值但不完整会在保存阶段直接拒绝，不再出现「配置写错导致每次检索 500」。
- 编码器运行期失败（网络中断、Key 失效）不会丢记忆，只降级为词法检索，并在响应 `warnings` 中给出原因。

监听 IP 与端口放在 `<DATA_DIR>/server-config.json`，首次启动自动生成默认值 `{ "host": "0.0.0.0", "port": 3100 }`。修改文件后重启服务生效；不再读取 HOST / PORT 环境变量。

## 管理员密码

- **在线修改**：登录后在「设置 → 安全」输入当前密码与新密码即可修改；改密成功后所有会话立即退出，需用新密码重新登录。
- **忘记密码**：无法反推哈希，只能重置。停服务后设置 `ADMIN_PASSWORD`（8–1024 字符）并执行 `npm run reset-admin`，清掉该环境变量后重启服务。

## 监听地址

编辑 `<DATA_DIR>/server-config.json` 的 `host` 与 `port`，重启服务生效。例如仅本机：`{ "host": "127.0.0.1", "port": 3100 }`；局域网访问保持 `0.0.0.0`。

## 在线更新

「关于 → 版本与更新」可检测 GitHub 最新 Release，一键下载源码包（GitHub tar.gz）并覆盖程序文件；覆盖前自动备份被改动文件到 `data/updates/backup-*`，且**不会触碰 `data/`、`node_modules/`、`dist/`、`.git/`**，数据库与配置安全。覆盖后需在页面上手动「重新编译」（`npm install` + `npm run build`）再「启动服务」（`npm start`）；每一步都要 6 位验证码二次确认。源码包不含原生模块，跨平台（Windows / Linux）均需在本机重新编译。

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

## 返回体积与写入结果约定

`estimated_tokens` 是**响应 `data` 对象的 UTF-8 字节数**（`Buffer.byteLength(JSON.stringify(data), "utf8")`），不是模型分词器算出的 token 数；它与 `token_budget` 使用同一单位，因此可以直接比较。`memory_get`、`memory_search`、`memory_bootstrap` 三处口径一致，统计页的 `average_returned_tokens` 也沿用此单位。预算用尽时 `budget_exhausted: true`，可通过提高 `token_budget`（128–1200）取回更多条。

`w_memory_add` 命中相似记忆且未给 `distinct_reason` 时返回 `ok: false` / `error.code: "NEEDS_REVIEW"`，**事实并未落库**，且该结果不会进入 `request_id` 幂等缓存。调用方必须把非成功结果告知用户，检查 `data.similar_candidates`：若确实是新事实，补上 `distinct_reason` 说明差异后重新提交；若已被代表则不要再写。只有成功写入才保持静默、不向用户汇报。

## 数据与备份

只支持**单个服务实例**使用同一数据目录，勿多实例共享。默认布局：

```text
data/
  admin-password.json          管理员密码哈希
  server-config.json           监听 IP 与端口（修改后重启生效）
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

在客户端系统提示词或项目 `AGENTS.md` 中加入（凭据页「接入方式」→「复制 AGENTS.md 文案」可一键复制完整文案）。`estimated_tokens` 的单位是 data 的 UTF-8 字节数（与 `token_budget` 同单位）；`NEEDS_REVIEW` 不是成功，事实未保存，必须告知用户并视情况补 `distinct_reason` 重提。这是**强制性**约定：**会话第一条消息必须先 `w_memory_search` 再回答**（QQBOT 账户先 `w_memory_bootstrap`），之后涉及用户偏好/画像/项目/既往决定时都要先检索；用户表达稳定偏好、画像、决定或经验时**立即静默 `w_memory_add`，不询问、不汇报**，多条事实拆开写；写入前去重，更新携带当前 `revision`；所有工具都可省略 `request_id`（服务端自动生成），只有重试同一笔写入才沿用原值；`source` 一般省略，确需来源时只传平台字符串（如 `{"platform":"desktop"}`），不要传 kind/detail；`w_memory_add` 只强依赖 `type` 与 `content`；`importance`（1–99）真实影响检索排序，长期事实给高分、临时琐事给低分；相似记忆由服务自动关联，检索时合并为代表，不必重复记录；优先更新或归档，不轻易永久删除；禁止保存密码、令牌、私钥，不把猜测当用户确认的事实。

## 当前限制

- 向量查询为精确扫描，未完成十万条规模与长期并发压测，不按 ANN 容量规划。
- Linux/Docker 与真实外部编码器尚未实机验收。
- JSON 导入在内存中解析，单份上限 100 MiB；逻辑导出不含完整修订历史。
- 登录会话与导入暂存保存在单进程内存，重启后需重新登录与预检。

版本与变更见 [版本变更记录](doc/版本变更记录.md)。
