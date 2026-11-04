import { useState, type FormEvent } from "react";
import {
  api,
  query,
  writeBody,
  type Memory,
  type MemoryType,
  type Page,
  type Space,
  type Preview,
} from "./api";
import {
  date,
  Feedback,
  Heading,
  Modal,
  PreviewDialog,
  State,
  types,
  useAction,
  useResource,
} from "./ui";
export function MemoryEditor({
  subject,
  memory,
  spaces,
  onClose,
  onSaved,
  profile = false,
}: {
  subject: string;
  memory?: Memory;
  spaces: Space[];
  onClose: () => void;
  onSaved: () => void;
  profile?: boolean;
}) {
  const [type, setType] = useState<MemoryType>(
    memory?.type || (profile ? "profile" : "fact"),
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
                subject_id: subject,
                space_id: f.get("space_id"),
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
    <Modal title={memory ? "修改记忆" : "记下一件重要的事"} onClose={onClose}>
      <form onSubmit={submit}>
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
            空间
            <select
              name="space_id"
              required
              disabled={!!memory}
              defaultValue={memory?.space_id || spaces[0]?.id}
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
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
            取消
          </button>
          <button className="primary" disabled={action.busy || !spaces.length}>
            {action.busy ? "正在保存…" : "保存记忆"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function Memories({
  subject,
  refresh,
  profiles = false,
}: {
  subject: string;
  refresh: number;
  profiles?: boolean;
}) {
  const [version, setVersion] = useState(0);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [space, setSpace] = useState("");
  const [status, setStatus] = useState("active");
  const [cursor, setCursor] = useState("");
  const [editing, setEditing] = useState<Memory | null | undefined>();
  const [detail, setDetail] = useState<Memory | null>(null);
  const [preview, setPreview] = useState<{
    value: Preview;
    path: string;
    body: Record<string, unknown>;
    title: string;
  } | null>(null);
  const action = useAction();
  const spaces = useResource<Page<Space>>(
    "/spaces" + query({ subject_id: subject }),
    refresh,
  );
  const records = useResource<Page<Memory>>(
    (profiles ? "/profiles" : "/memories") +
      query({
        subject_id: subject,
        q: search,
        type: profiles ? "profile" : type,
        space_id: space,
        status,
        cursor,
        limit: 20,
      }),
    refresh + version,
  );
  const reload = () => {
    setVersion((v) => v + 1);
    setDetail(null);
  };
  async function prepare(m: Memory, kind: "archive" | "purge") {
    const reason = window.prompt(
      kind === "archive" ? "归档原因（可恢复）" : "永久清除原因（不可恢复）",
    );
    if (!reason) return;
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
      setPreview({
        value,
        path: "/memories/" + kind,
        body,
        title: kind === "archive" ? "确认归档记忆" : "永久清除记忆",
      });
    }, "");
  }
  return (
    <>
      <Heading
        eyebrow={profiles ? "ABOUT YOU" : "YOUR MEMORY"}
        title={profiles ? "关于我" : "记忆"}
        description={
          profiles
            ? "你告诉我的，和仍待你确认的。随时纠正，保持真实。"
            : "把值得记住的事收在一起，需要时再找到。管理浏览不会增加被找到次数。"
        }
      >
        <button className="primary" onClick={() => setEditing(null)}>
          ＋ {profiles ? "添加画像" : "新建记忆"}
        </button>
      </Heading>
      <Feedback error={action.error || spaces.error} notice={action.notice} />
      <section className="panel">
        <div className="filters">
          <label className="search">
            ⌕
            <input
              aria-label="搜索记忆"
              placeholder="搜索标题、内容或关键词…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCursor("");
              }}
            />
          </label>
          <select
            aria-label="空间"
            value={space}
            onChange={(e) => {
              setSpace(e.target.value);
              setCursor("");
            }}
          >
            <option value="">全部空间</option>
            {spaces.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {!profiles && (
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
          )}
          <select
            aria-label="记忆状态"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setCursor("");
            }}
          >
            <option value="active">正在使用</option>
            <option value="archived">已归档</option>
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
                  <button onClick={() => setEditing(m)}>编辑</button>
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
          memory={editing || undefined}
          profile={profiles}
          spaces={spaces.data?.items || []}
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
            <dd>{detail.weight ?? "—"}</dd>
            <dt>最近确认</dt>
            <dd>{date(detail.confirmed_at)}</dd>
            <dt>有效截止</dt>
            <dd>{date(detail.valid_until)}</dd>
            <dt>索引状态</dt>
            <dd>{detail.embedding_state}</dd>
            <dt>版本</dt>
            <dd>{detail.revision}</dd>
          </dl>
          <details>
            <summary>来源记录</summary>
            <pre>
              {JSON.stringify(
                detail.sources || detail.provenance || [],
                null,
                2,
              )}
            </pre>
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
                归档…
              </button>
            ) : (
              <button
                disabled={action.busy || !!detail.merged_into}
                onClick={() => {
                  if (window.confirm("恢复这条记忆？原有效期不会延长。"))
                    void action.run(async () => {
                      await api(
                        "/memories/restore",
                        "POST",
                        writeBody({
                          subject_id: subject,
                          id: detail.id,
                          expected_revision: detail.revision,
                          reason: "管理员恢复",
                        }),
                      );
                      reload();
                    }, "已恢复记忆");
                }}
              >
                恢复
              </button>
            )}
            <button
              className="danger-outline"
              disabled={action.busy}
              onClick={() => void prepare(detail, "purge")}
            >
              永久清除…
            </button>
          </footer>
        </Modal>
      )}
      {preview && (
        <PreviewDialog
          title={preview.title}
          preview={preview.value}
          busy={action.busy}
          error={action.error}
          onClose={() => setPreview(null)}
          onConfirm={() =>
            void action.run(async () => {
              await api(
                preview.path,
                "POST",
                writeBody({
                  ...preview.body,
                  preview_token: preview.value.preview_token,
                }),
              );
              setPreview(null);
              reload();
            })
          }
        />
      )}
    </>
  );
}
