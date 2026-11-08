# vectorize-mcp 工具参数参考

通用约定：

- `request_id` 可选，任意 ≤200 字符文本；服务端会确定性地归一化为 UUID。重试**同一次写入**时复用同一个值，意图变化就换新值。
- 所有时间戳是毫秒整数；长度一律按 Unicode 码点计（不是字节）。
- 成功信封统一为 `{"ok":true,"request_id":"…","data":{…},"meta":{…},"state_token":"…"}`。

## w_memory_search

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| request_id | string | 否 | ≤200 字符 |
| query | string | 是 | 1–512 字符 |
| keywords | string[] | 否 | 每条 1–32 字符，最多 12 条，默认 [] |
| limit | int | 否 | 1–5 |
| token_budget | int | 否 | 128–1200，默认取服务端配置（通常 1200） |
| types | enum[] | 否 | fact/preference/profile/project/decision/lesson/task/person/concept/persona，1–10 个 |
| expected_ids | uuid[] | 否 | ≤20，去重；**仅评测用**，正常调用不要传 |

返回 `data`：`items[]`（含 id、type、title、content、importance、score 等）、`mode`（semantic / lexical / mixed）、`estimated_tokens`、`budget_exhausted`；带 `expected_ids` 时另有 `evaluation{hit_at_1,hit_at_3,labeled}`。只返回 effective 记忆（未归档、未被合并、未过有效期），总数上限 5（含一跳关联）。

## w_memory_get

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| ids | uuid[] | 是 | 1–5 个，不重复 |
| token_budget | int | 否 | 128–1200 |
| include_archived | bool | 否 | 默认 false |

不增加检索计数。不存在或不属于当前账户的 id 不泄露存在性。

## w_memory_add

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| type | enum | 是 | 10 类之一；person/concept/persona 仅 QQBOT 账户 |
| content | string | 是 | 1–1200 字符，一到两句话 |
| title | string | 否 | ≤80 字符，默认空 |
| keywords | string[] | 否 | 每条 1–32，≤12 |
| importance | int | 否 | 1–99，默认 50 |
| source | object/string | 否 | `{platform, agent, conversation_id, message_id, reference}`；不知道来源就省略 |
| sensitivity | enum | 否 | normal / private，默认 normal |
| valid_from / valid_until | int/null | 否 | 毫秒时间戳 |
| profile | object | 否 | 见下，`strict` |
| distinct_reason | string | 否 | 1–500；`needs_review` 后确认是新事实时必填 |

`profile` 结构（严格模式，多余字段报错）：

```json
{
  "profile_key": "preferred_name | answer_style | work_role | routine | tool_preference | language | answer_length | stage_goal | custom.xxx",
  "basis": "explicit | inferred",
  "confidence": 0.0,
  "evidence": ["原文片段"]
}
```

返回 `data.status`：

- `created`：新建成功，**此时服务端只回 `{"ok":true}`**。
- `existing`：存在相同的 active 记忆，返回其 id 与 revision。
- `existing_archived`：存在相同的已归档记忆；它当前不可检索，需恢复。
- `needs_review`：命中相似记忆而**未保存**，附 `similar_candidates`。

## w_memory_update

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| id | uuid | 是 | 目标记忆 |
| expected_revision | int | 是 | 正整数，来自最近一次读取 |
| patch | object | 是 | fields 的 partial，且非空；content 改动会重跑查重 |
| reason | string | 是 | 1–500 字符 |
| source | object | 否 | 同 add |
| confirm_current | object | 否 | `{evidence, source}`，用于刷新事实确认时间 |

成功静默返回 `{"ok":true}`。

## w_memory_merge

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| target | object | 是 | `{id, revision}` |
| sources | object[] | 是 | 1–8 个 `{id, revision}` |
| final_content | string | 是 | 1–1200 字符 |
| reason | string | 是 | 1–500 字符 |

源记忆变为 archived 并指向 target（保留来源、关联与计数）。受保护记忆（importance ≥ 80 或 profile）拒绝。

## w_memory_link

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| action | enum | 是 | upsert / remove |
| source_id / target_id | uuid | 是 | 必须不同，禁止自链接 |
| type | string | 是 | `related_to` 无向；`supports` / `contradicts` / `supersedes` 有向；允许自定义 |
| strength | number | 否 | 0–1，默认 0.7 |
| expected_revision | int | 条件必填 | 修改或删除**已存在**的关系时必填 |

只有 `related_to` 与 `supports` 参与一跳召回。

## w_memory_archive

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| action | enum | 是 | preview / execute |
| items | object[] | 是 | 1–5 个 `{id, revision}` |
| reason | string | 是 | 1–500 字符 |
| preview_token | string | 条件必填 | execute 必填，来自 preview；5 分钟有效，绑定 revision 与 reason |

agent 默认被禁用（`FEATURE_DISABLED`）；importance ≥ 80 或 profile 类型拒绝（`PROTECTED_MEMORY`）。execute 成功静默返回 `{"ok":true}`。

## w_memory_restore

`id` + `expected_revision` + `reason`。被合并掉的记忆不能单独恢复；过期记忆恢复后仍不进默认检索。

## w_memory_config_get

无参数，只读。返回 revision、默认 limit / token_budget、阈值、开关等非敏感配置。

## w_memory_similarity_groups

`limit` 1–50，默认 20。只读，返回疑似重复分组（组 id、成员数、最小相似度、风险标记、内容摘要）。**合并只能由人在 Web 端确认**。

## w_memory_bootstrap

`token_budget` 128–1200。仅 QQBOT 账户；一次返回 bot 配置、启用的人设与记忆，不修改数据。

## 边界值速查

| 项 | 上限 |
|---|---|
| content | 1200 字符 |
| title | 80 字符 |
| keyword 单条 / 条数 | 32 字符 / 12 条 |
| limit（search） | 5 |
| ids（get） | 5 |
| token_budget | 1200 |
| expected_ids | 20 |
| sources（merge） | 8 |
| items（archive） | 5 |
| reason | 500 字符 |
| query | 512 字符 |

超限返回 `VALIDATION_ERROR`，MCP 层文本形如 `MCP error -32602: Input validation error: ... Unicode character length must be 1–512 at query`。

## 返回细节与常见误用

- `data.estimated_tokens` 是整个 `data` 对象的 UTF-8 字节数，不是模型 token；预算耗尽时会裁掉尾部 items 并置 `budget_exhausted: true`。
- `state_token` 只用于服务端幂等重放，不要在对话里解读或缓存。
- 误用 1：content 超 1200 → 拆成多条原子事实。
- 误用 2：update 不带 expected_revision → 参数校验直接失败。
- 误用 3：link remove 不带 expected_revision → `REVISION_CONFLICT`。
- 误用 4：archive 跳过 preview → 缺 preview_token。
- 误用 5：把 `needs_review` 当成功 → 事实其实没保存。
- 误用 6：找 `w_memory_delete` → 不存在；删除 = 归档。