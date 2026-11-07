import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  dataChanged,
  query,
  writeBody,
  type Account,
  type Memory,
  type MemoryType,
  type Page,
  type Preview,
} from "./api";
import {
  date,
  Feedback,
  Heading,
  Modal,
  ConfirmDialog,
  State,
  types,
  useAction,
  useResource,
  weightText,
} from "./ui";
/** 来源记录的结构化展示：调用方未提供来源时明确说明，而不是显示一个空数组。 */
type SourceRef = {
  platform?: string;
  agent?: string;
  conversation_id?: string;
  message_id?: string;
  reference?: string;
};

const SOURCE_LABELS: [keyof SourceRef, string][] = [
  ["platform", "平台"],
  ["agent", "Agent"],
  ["conversation_id", "会话"],
  ["message_id", "消息"],
  ["reference", "引用"],
];

function SourceList({ sources }: { sources: SourceRef[] }) {
  const rows = sources.filter((s) => s && typeof s === "object");
  if (rows.length === 0)
    return (
      <p className="source-empty">
        未记录来源：该条记忆写入时没有携带来源信息（v0.5.6 之前的写入均如此）。
        新写入会自动带上调用方声明的平台，也可在写入时显式传 source。
      </p>
    );
  return (
    <ul className="source-list">
      {rows.map((source, index) => (
        <li key={index}>
          {SOURCE_LABELS.filter(([key]) => source[key]).map(([key, label]) => (
            <span className="source-item" key={key}>
              <span className="source-key">{label}</span>
              <span className="source-value">{String(source[key])}</span>
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

export function MemoryEditor({
  subject,
  accounts,
  memory,
  onClose,
  onSaved,
}: {
  subject: string;
  accounts: Account[];
  memory?: Memory;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<MemoryType>(memory?.type || "fact");
  const [account, setAccount] = useState(subject);
  const [peek, setPeek] = useState<Memory | null>(null);
  const sameType = useResource<Page<Memory>>(
    "/memories" +
      query({
        subject_id: account,
        type,
        status: "active",
        limit: 20,
      }),
    0,
  );
  const action = useAction();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const patch = {
      title: f.get("title"),
      content: f.get("content"),
      type,
      keywords: String(f.get("keywords"))
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      importance: Number(f.get("importance")),
      sensitivity: f.get("sensitivity"),
      valid_from: f.get("valid_from")
        ? new Date(String(f.get("valid_from"))).getTime()
        : null,
      valid_until: f.get("valid_until")
        ? new Date(String(f.get("valid_until"))).getTime()
        : null,
      ...(type === "profile"
        ? {
            profile: {
              profile_key: f.get("profile_key"),
              basis: f.get("basis"),
              confidence: Number(f.get("confidence")),
              evidence: String(f.get("evidence")).split("\n").filter(Boolean),
            },
          }
        : memory?.type === "profile"
          ? { profile: null }
          : {}),
    };
    void action.run(async () => {
      const result = await api<{
        status?: string;
        similar_candidates?: unknown[];
      }>(
        "/memories" + (memory ? "/" + memory.id : ""),
        memory ? "PATCH" : "POST",
        writeBody(
          memory
            ? {
                subject_id: subject,
                expected_revision: memory.revision,
                patch,
                reason: f.get("reason"),
              }
            : {
                subject_id: account,
                ...patch,
                source: { platform: "web" },
                ...(f.get("distinct_reason")
                  ? { distinct_reason: f.get("distinct_reason") }
                  : {}),
              },
        ),
      );
      if (result.status === "needs_review")
        throw new Error(
          "发现近似内容，请说明差异后重新提交：" +
            JSON.stringify(result.similar_candidates),
        );
      if (result.status === "existing" || result.status === "existing_archived")
        throw new Error("这条记忆已存在，请关闭表单后查找原记录。");
      onSaved();
      onClose();
    });
  }
  const localTime = (v: number | null | undefined) =>
    v
      ? new Date(v - new Date(v).getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : "";
  return (
    <Modal
      title={memory ? "修改记忆" : "记下一件重要的事"}
      onClose={onClose}
      locked
    >
      <div className="editor-shell">
      <form className="editor-form" onSubmit={submit}>
        <Feedback error={action.error} notice="" />
        <div className="form-grid">
          <label>
            类型
            <select
              value={type}
              onChange={(e) => setType(e.target.value as MemoryType)}
            >
              {Object.entries(types).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            写入到哪个账户
            <select
              value={account}
              disabled={!!memory}
              onChange={(e) => {
                setAccount(e.target.value);
                setPeek(null);
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.kind === "qqbot" ? " · QQBOT" : ""}
                  {a.status === "unbound" ? " · 未绑定凭据" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          标题
          <input
            name="title"
            maxLength={80}
            defaultValue={memory?.title}
            placeholder="用一句话概括，方便以后找到"
          />
        </label>
        <label>
          记忆内容
          <textarea
            name="content"
            required
            maxLength={1200}
            rows={5}
            defaultValue={memory?.content}
            placeholder="记录一个具体事实，保留适用条件。"
          />
        </label>
        <label>
          关键词 <small>用逗号分隔，最多 12 个</small>
          <input name="keywords" defaultValue={memory?.keywords.join("，")} />
        </label>
        <div className="form-grid">
          <label>
            重要程度 <small>1～99，默认 50</small>
            <input
              name="importance"
              type="number"
              min={1}
              max={99}
              required
              defaultValue={memory?.importance || 50}
            />
          </label>
          <label>
            隐私
            <select
              name="sensitivity"
              defaultValue={memory?.sensitivity || "normal"}
            >
              <option value="normal">普通</option>
              <option value="private">私密</option>
            </select>
          </label>
          <label>
            开始有效时间
            <input
              name="valid_from"
              type="datetime-local"
              defaultValue={localTime(memory?.valid_from)}
            />
          </label>
          <label>
            有效截止时间
            <input
              name="valid_until"
              type="datetime-local"
              defaultValue={localTime(memory?.valid_until)}
            />
          </label>
        </div>
        {type === "profile" && (
          <fieldset>
            <legend>画像依据</legend>
            <label>
              画像类别
              <select
                name="profile_key"
                defaultValue={memory?.profile?.profile_key || "answer_style"}
              >
                {[
                  "preferred_name",
                  "answer_style",
                  "work_role",
                  "routine",
                  "tool_preference",
                  "custom.other",
                ].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <div className="form-grid">
              <label>
                依据
                <select
                  name="basis"
                  defaultValue={memory?.profile?.basis || "explicit"}
                >
                  <option value="explicit">你明确告诉我的</option>
                  <option value="inferred">待确认的猜测</option>
                </select>
              </label>
              <label>
                可信度（0～1）
                <input
                  name="confidence"
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={memory?.profile?.confidence ?? 1}
                />
              </label>
            </div>
            <label>
              证据 <small>每行一条；推断需证据和有效期</small>
              <textarea
                name="evidence"
                defaultValue={memory?.profile?.evidence?.join("\n")}
              />
            </label>
          </fieldset>
        )}
        {memory ? (
          <label>
            修改原因
            <input
              name="reason"
              required
              placeholder="例如：工作角色发生变化"
            />
          </label>
        ) : (
          <label>
            与近似记忆的差异 <small>仅在提示近似时填写</small>
            <input name="distinct_reason" />
          </label>
        )}
        <footer>
          <button type="button" disabled={action.busy} onClick={onClose}>
            关闭
          </button>
          <button className="primary" disabled={action.busy}>
            {action.busy ? "正在保存" : "保存记忆"}
          </button>
        </footer>
      </form>
      <aside className="editor-side" aria-label="同类型已有记忆">
        <h3>这个账户已有的「{types[type]}」</h3>
        <p className="hint">
          先看看有没有重复，点击条目可查看完整内容。
        </p>
        <State
          loading={sameType.loading}
          error={sameType.error}
          empty={!sameType.data?.items.length}
        >
          <ul className="editor-side-list">
            {sameType.data?.items.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => setPeek(m)}>
                  {m.title || m.content.slice(0, 28)}
                </button>
                <small>{date(m.updated_at)}</small>
              </li>
            ))}
          </ul>
        </State>
        {peek && (
          <div className="editor-peek">
            <strong>{peek.title || "无标题"}</strong>
            <p>{peek.content}</p>
            <button type="button" onClick={() => setPeek(null)}>
              收起
            </button>
          </div>
        )}
      </aside>
      </div>
    </Modal>
  );
}
export function Memories({
  subject,
  accounts,
  refresh,
}: {
  subject: string;
  accounts: Account[];
  refresh: number;
}) {
  const [version, setVersion] = useState(0);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("active");
  const [cursor, setCursor] = useState("");
  const [editing, setEditing] = useState<Memory | null | undefined>();
  const [detail, setDetail] = useState<Memory | null>(null);
  const [similar, setSimilar] = useState<
    { id: string; content: string; type: MemoryType; importance: number; similarity: number }[]
  >([]);
  const [preview, setPreview] = useState<{
    value: Preview;
    path: string;
    body: Record<string, unknown>;
    title: string;
  } | null>(null);
  const [reasonRequest, setReasonRequest] = useState<{
    memory: Memory;
    kind: "archive" | "delete";
  } | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [restoreMemory, setRestoreMemory] = useState<Memory | null>(null);
  const action = useAction();
  const accountTotal = accounts.find((a) => a.id === subject)?.memory_count;
  const records = useResource<Page<Memory>>(
    "/memories" +
      query({
        subject_id: subject,
        q: search,
        type,
        status,
        cursor,
        limit: 20,
      }),
    `${refresh}:${version}`,
  );
  useEffect(() => {
    if (!detail) {
      setSimilar([]);
      return;
    }
    let live = true;
    api<
      { id: string; content: string; type: MemoryType; importance: number; similarity: number }[]
    >("/memories/" + detail.id + "/similar" + query({ subject_id: subject }))
      .then((rows) => {
        if (live) setSimilar(rows);
      })
      .catch(() => {
        if (live) setSimilar([]);
      });
    return () => {
      live = false;
    };
  }, [detail, subject]);
  const reload = () => {
    setVersion((v) => v + 1);
    setDetail(null);
    dataChanged();
  };
  function prepare(m: Memory, kind: "archive" | "delete") {
    setDetail(null);
    setReasonText("管理员整理");
    setReasonRequest({ memory: m, kind });
  }
  async function previewReason() {
    if (!reasonRequest || !reasonText.trim()) return;
    const { memory: m, kind } = reasonRequest;
    const reason = reasonText.trim();
    await action.run(async () => {
      const body = {
        subject_id: subject,
        items: [{ id: m.id, revision: m.revision }],
        reason,
      };
      const value = await api<Preview>(
        "/memories/" + kind + "-preview",
        "POST",
        writeBody(body),
      );
      setReasonRequest(null);
      setPreview({
        value,
        path: "/memories/" + kind,
        body,
        title: kind === "archive" ? "确认归档记忆" : "确认删除到回收站",
      });
    }, "");
  }
  return (
    <>
      <Heading
        eyebrow="YOUR MEMORY"
        title="记忆"
        description="把值得记住的事收在一起，需要时再找到。管理浏览不会增加被找到次数。"
      >
        <div className="heading-actions">
          <span className="heading-total">
            <strong>{accountTotal ?? "—"}</strong>
            <small>条记忆</small>
          </span>
          <button className="primary" onClick={() => setEditing(null)}>
            ＋ 新建记忆
          </button>
        </div>
      </Heading>
      <Feedback error={action.error} notice={action.notice} />
      <section className="panel">
        <div className="filters">
          <label className="search">
            ⌕
            <input
              aria-label="搜索记忆"
              placeholder="搜索标题、内容或关键词"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCursor("");
              }}
            />
          </label>
          <select
            aria-label="类型"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setCursor("");
            }}
          >
            <option value="">全部类型</option>
            {Object.entries(types).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select
            aria-label="记忆状态"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setCursor("");
            }}
          >
            <option value="active">已激活记忆</option>
            <option value="archived">已归档</option>
            <option value="merged">已合并</option>
          </select>
        </div>
        <State
          loading={records.loading}
          error={records.error}
          empty={!records.data?.items.length}
        >
          <div className="memory-list">
            {records.data?.items.map((m) => (
              <article className="memory-card" key={m.id}>
                <div className="memory-main">
                  <div className="memory-meta">
                    <span className={"tag " + m.type}>{types[m.type]}</span>
                    {m.profile && (
                      <span
                        className={
                          m.profile.basis === "inferred" ? "tag warning" : "tag"
                        }
                      >
                        {m.profile.basis === "explicit"
                          ? "你告诉我的"
                          : "待确认的猜测"}
                      </span>
                    )}
                    {m.sensitivity === "private" && (
                      <span className="tag">私密</span>
                    )}
                    <span>{date(m.updated_at)}</span>
                  </div>
                  <button className="memory-title" onClick={() => setDetail(m)}>
                    {m.title || m.content.slice(0, 36)}
                  </button>
                  <p>{m.content}</p>
                  <div className="keywords">
                    {m.keywords.map((k) => (
                      <span key={k}>#{k}</span>
                    ))}
                  </div>
                </div>
                <div className="memory-side">
                  <strong>
                    {m.importance}
                    <small>重要程度</small>
                  </strong>
                  <span>找到 {m.retrieval_count} 次</span>
                  <div className="row-actions">
                    <button onClick={() => setEditing(m)}>编辑</button>
                    {m.status === "archived" ? (
                      <button
                        disabled={action.busy || !!m.merged_into}
                        onClick={() => setRestoreMemory(m)}
                      >
                        取消归档
                      </button>
                    ) : (
                      <button
                        disabled={action.busy}
                        onClick={() => prepare(m, "archive")}
                      >
                        归档
                      </button>
                    )}
                    <button
                      className="danger-outline"
                      disabled={action.busy}
                      onClick={() => prepare(m, "delete")}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <div className="pagination">
            <span>
              {records.data?.total !== undefined
                ? "共 " + records.data.total + " 条"
                : "每页最多 20 条"}
            </span>
            <button disabled={!cursor} onClick={() => setCursor("")}>
              第一页
            </button>
            <button
              disabled={!records.data?.next_cursor}
              onClick={() => setCursor(records.data?.next_cursor || "")}
            >
              下一页 →
            </button>
          </div>
        </State>
      </section>
      {editing !== undefined && (
        <MemoryEditor
          subject={subject}
          accounts={accounts}
          memory={editing || undefined}
          onClose={() => setEditing(undefined)}
          onSaved={reload}
        />
      )}
      {detail && (
        <Modal
          title={detail.title || "记忆详情"}
          onClose={() => setDetail(null)}
        >
          <span className="tag">{types[detail.type]}</span>
          <p className="full-content">{detail.content}</p>
          <dl className="details">
            <dt>被找到次数</dt>
            <dd>{detail.retrieval_count}（不等于会话数）</dd>
            <dt>服务端权重</dt>
            <dd>{weightText(detail.weight)}</dd>
            <dt>最近确认</dt>
            <dd>{date(detail.confirmed_at)}</dd>
            <dt>有效截止</dt>
            <dd>{date(detail.valid_until)}</dd>
            <dt>索引状态</dt>
            <dd>{detail.embedding_state}</dd>
            <dt>版本</dt>
            <dd>{detail.revision}</dd>
          </dl>
          {similar.length > 0 && (
            <div className="similar-block">
              <h4>相似记忆（已自动关联，检索时只返回一条代表）</h4>
              <ul>
                {similar.map((item) => (
                  <li key={item.id}>
                    <span className="tag">{types[item.type]}</span>
                    <span className="similar-text">{item.content}</span>
                    <span className="similar-score">
                      {(item.similarity * 100).toFixed(0)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <details open>
            <summary>来源记录</summary>
            <SourceList
              sources={(detail.sources || detail.provenance || []) as SourceRef[]}
            />
          </details>
          <footer>
            <button
              onClick={() => {
                setEditing(detail);
                setDetail(null);
              }}
            >
              编辑
            </button>
            {detail.status === "active" ? (
              <button
                disabled={action.busy}
                onClick={() => void prepare(detail, "archive")}
              >
                归档
              </button>
            ) : (
              <button
                disabled={action.busy || !!detail.merged_into}
                onClick={() => {
                  setRestoreMemory(detail);
                  setDetail(null);
                }}
              >
                取消归档
              </button>
            )}
            <button
              className="danger-outline"
              disabled={action.busy}
              onClick={() => void prepare(detail, "delete")}
            >
              删除
            </button>
          </footer>
        </Modal>
      )}
      {reasonRequest && (
        <Modal
          title={reasonRequest.kind === "delete" ? "删除到回收站" : "归档记忆"}
          onClose={() => {
            if (!action.busy) setReasonRequest(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void previewReason();
            }}
          >
            <Feedback error={action.error} notice="" />
            <p>{reasonRequest.memory.title || reasonRequest.memory.content}</p>
            <label>
              操作原因
              <input
                autoFocus
                required
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                placeholder="说明此次整理的原因"
              />
            </label>
            <footer>
              <span>下一步：核对预览并确认执行</span>
              <button
                type="button"
                disabled={action.busy}
                onClick={() => setReasonRequest(null)}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={action.busy || !reasonText.trim()}
                title={reasonText.trim() ? undefined : "请先填写操作原因"}
              >
                {action.busy ? "正在读取预览" : "查看预览"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {restoreMemory && (
        <ConfirmDialog
          title="取消归档"
          onClose={() => setRestoreMemory(null)}
          onConfirm={async () => {
            await api(
              "/memories/restore",
              "POST",
              writeBody({
                subject_id: subject,
                id: restoreMemory.id,
                expected_revision: restoreMemory.revision,
                reason: "管理员取消归档",
              }),
            );
            reload();
          }}
        >
          <p>原有效期不会延长。确认将这条记忆恢复到正在使用列表？</p>
          <p>{restoreMemory.title || restoreMemory.content}</p>
        </ConfirmDialog>
      )}
      {preview && (
        <ConfirmDialog
          title={preview.title}
          confirmLabel={
            preview.path === "/memories/delete" ? "确认删除" : "确认执行"
          }
          verificationCode={
            preview.path === "/memories/delete"
              ? String(preview.value.code || "")
              : undefined
          }
          onClose={() => setPreview(null)}
          onConfirm={async (code) => {
            await api(
              preview.path,
              "POST",
              writeBody({
                ...preview.body,
                preview_token: preview.value.preview_token,
                ...(code ? { code } : {}),
              }),
            );
            reload();
          }}
        >
          <p>删除会移入回收站；归档可在记忆列表取消。请核对服务器预览。</p>
          <pre>
            {JSON.stringify(
              Object.fromEntries(
                Object.entries(preview.value).filter(
                  ([k]) => k !== "preview_token",
                ),
              ),
              null,
              2,
            )}
          </pre>
        </ConfirmDialog>
      )}
    </>
  );
}
