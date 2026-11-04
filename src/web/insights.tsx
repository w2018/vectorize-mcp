import { useMemo, useState } from "react";
import {
  api,
  query,
  writeBody,
  type Graph,
  type Link,
  type Memory,
  type Page,
  type Preview,
  type Space,
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
const colors: Record<string, string> = {
  fact: "#378e80",
  preference: "#b0854d",
  profile: "#8b73b7",
  project: "#578cc3",
  decision: "#d17d63",
  lesson: "#a39744",
  task: "#689a8b",
};
function layout(nodes: Memory[], edges: Link[]) {
  const positions = new Map(
    nodes.map((n, i) => [
      n.id,
      {
        x: 420 + Math.cos(i * 2.399963) * Math.sqrt(i + 1) * 19,
        y: 270 + Math.sin(i * 2.399963) * Math.sqrt(i + 1) * 14,
      },
    ]),
  );
  for (let round = 0; round < 80; round++) {
    const forces = new Map(nodes.map((n) => [n.id, { x: 0, y: 0 }]));
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = positions.get(nodes[i]!.id)!;
        const b = positions.get(nodes[j]!.id)!;
        const dx = a.x - b.x,
          dy = a.y - b.y,
          d = Math.max(dx * dx + dy * dy, 16),
          f = 700 / d;
        forces.get(nodes[i]!.id)!.x += dx * f;
        forces.get(nodes[i]!.id)!.y += dy * f;
        forces.get(nodes[j]!.id)!.x -= dx * f;
        forces.get(nodes[j]!.id)!.y -= dy * f;
      }
    for (const e of edges) {
      const a = positions.get(e.source_id),
        b = positions.get(e.target_id);
      if (!a || !b) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      forces.get(e.source_id)!.x += dx * 0.008;
      forces.get(e.source_id)!.y += dy * 0.008;
      forces.get(e.target_id)!.x -= dx * 0.008;
      forces.get(e.target_id)!.y -= dy * 0.008;
    }
    for (const n of nodes) {
      const p = positions.get(n.id)!,
        f = forces.get(n.id)!;
      p.x = Math.max(35, Math.min(805, p.x + f.x + (420 - p.x) * 0.004));
      p.y = Math.max(35, Math.min(505, p.y + f.y + (270 - p.y) * 0.004));
    }
  }
  return positions;
}
export function GraphView({
  subject,
  refresh,
}: {
  subject: string;
  refresh: number;
}) {
  const [version, setVersion] = useState(0);
  const [space, setSpace] = useState("");
  const [type, setType] = useState("");
  const [focus, setFocus] = useState("");
  const [selected, setSelected] = useState<Memory | null>(null);
  const [list, setList] = useState(false);
  const [relation, setRelation] = useState(false);
  const [editingLink, setEditingLink] = useState<Link | null>(null);
  const action = useAction();
  const spaces = useResource<Page<Space>>(
    "/spaces" + query({ subject_id: subject }),
    refresh,
  );
  const graph = useResource<Graph>(
    "/graph" +
      query({
        subject_id: subject,
        space_id: space,
        type,
        focus_id: focus,
        node_limit: 200,
        edge_limit: 500,
      }),
    refresh + version,
  );
  const nodes = graph.data?.nodes || [];
  const edges = graph.data?.edges || [];
  const positions = useMemo(() => layout(nodes, edges), [graph.data]);
  return (
    <>
      <Heading
        eyebrow="CONNECTED MEMORIES"
        title="记忆星图"
        description="每一个点是一条记忆，连线表示明确记录的关系。点的大小来自服务端权重。"
      >
        <button disabled={!nodes.length} onClick={() => setRelation(true)}>
          ＋ 添加关系
        </button>
      </Heading>
      <Feedback error={action.error || spaces.error} notice={action.notice} />
      <section className="panel">
        <div className="filters">
          <select
            aria-label="空间"
            value={space}
            onChange={(e) => setSpace(e.target.value)}
          >
            <option value="">全部空间</option>
            {spaces.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            aria-label="类型"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">全部类型</option>
            {Object.entries(types).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button onClick={() => setList(!list)}>
            {list ? "切换星图" : "文字列表"}
          </button>
          {focus && <button onClick={() => setFocus("")}>返回完整范围</button>}
        </div>
        {graph.data?.truncated && (
          <div className="notice warning">
            只显示部分关系（最多 200 个点、500
            条边）。缩小空间或类型范围可看得更清楚。
          </div>
        )}
        <State
          loading={graph.loading}
          error={graph.error}
          empty={!nodes.length}
        >
          {list ? (
            <div className="padded">
              {nodes.map((n) => (
                <div className="list-row" key={n.id}>
                  <button
                    className="text-button"
                    onClick={() => setSelected(n)}
                  >
                    {n.title || n.content.slice(0, 60)}
                  </button>
                  <span>
                    {types[n.type]} · 权重 {n.weight}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <svg
              className="star-map"
              viewBox="0 0 840 540"
              role="img"
              aria-label="记忆关系星图，可切换文字列表"
            >
              <defs>
                <pattern
                  id="dots"
                  width="24"
                  height="24"
                  patternUnits="userSpaceOnUse"
                >
                  <circle cx="12" cy="12" r="1" fill="#e0e9e6" />
                </pattern>
              </defs>
              <rect width="840" height="540" fill="url(#dots)" />
              {edges.map((e) => {
                const a = positions.get(e.source_id),
                  b = positions.get(e.target_id);
                return a && b ? (
                  <line
                    key={e.id}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="#aac4bc"
                    strokeWidth={1 + e.strength * 2}
                  />
                ) : null;
              })}
              {nodes.map((n) => {
                const p = positions.get(n.id)!;
                return (
                  <g
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={n.title || n.content}
                    onClick={() => setSelected(n)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(n);
                      }
                    }}
                  >
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={7 + Math.max(0, Math.min(1, n.weight || 0)) * 13}
                      fill={colors[n.type]}
                      stroke="white"
                      strokeWidth={3}
                    />
                    <title>{n.title || n.content}</title>
                    {nodes.length < 45 && (
                      <text
                        x={p.x}
                        y={p.y + 31}
                        textAnchor="middle"
                        fontSize={11}
                        fill="#43574e"
                      >
                        {(n.title || n.content).slice(0, 12)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
          <div className="legend">
            {Object.entries(types).map(([k, v]) => (
              <span key={k}>
                <i style={{ background: colors[k] }} />
                {v}
              </span>
            ))}
          </div>
        </State>
      </section>
      {selected && (
        <Modal
          title={selected.title || "记忆详情"}
          onClose={() => setSelected(null)}
        >
          <p className="full-content">{selected.content}</p>
          <p>
            权重 {selected.weight} · 找到 {selected.retrieval_count} 次
          </p>
          <h3>可见关系</h3>
          {edges
            .filter(
              (e) => e.source_id === selected.id || e.target_id === selected.id,
            )
            .map((e) => (
              <div className="list-row" key={e.id}>
                <div>
                  <strong>
                    {nodes.find(
                      (n) =>
                        n.id ===
                        (e.source_id === selected.id
                          ? e.target_id
                          : e.source_id),
                    )?.title || "关联记忆"}
                  </strong>
                  <small>
                    {e.type} · 强度 {e.strength}
                  </small>
                </div>
                <button
                  disabled={action.busy}
                  onClick={() => {
                    setSelected(null);
                    setEditingLink(e);
                  }}
                >
                  编辑强度
                </button>
                <button
                  className="danger-outline"
                  disabled={action.busy}
                  onClick={() => {
                    if (window.confirm("删除这条关系？记忆正文不会删除。"))
                      void action.run(async () => {
                        await api(
                          "/links",
                          "POST",
                          writeBody({
                            subject_id: subject,
                            action: "remove",
                            source_id: e.source_id,
                            target_id: e.target_id,
                            type: e.type,
                            expected_revision: e.revision,
                          }),
                        );
                        setVersion((v) => v + 1);
                        setSelected(null);
                      }, "关系已删除");
                  }}
                >
                  移除
                </button>
              </div>
            ))}
          <footer>
            <button
              onClick={() => {
                setFocus(selected.id);
                setSelected(null);
              }}
            >
              查看附近关系
            </button>
            <button onClick={() => setSelected(null)}>关闭</button>
          </footer>
        </Modal>
      )}
      {editingLink && (
        <Modal
          title="编辑关系强度"
          onClose={() => {
            if (!action.busy) setEditingLink(null);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void action.run(async () => {
                await api(
                  "/links",
                  "POST",
                  writeBody({
                    subject_id: subject,
                    action: "upsert",
                    source_id: editingLink.source_id,
                    target_id: editingLink.target_id,
                    type: editingLink.type,
                    strength: Number(form.get("strength")),
                    expected_revision: editingLink.revision,
                  }),
                );
                setEditingLink(null);
                setVersion((v) => v + 1);
              }, "关系强度已更新");
            }}
          >
            <Feedback error={action.error} notice="" />
            <p>
              关系类型：{editingLink.type} · 当前版本：{editingLink.revision}
            </p>
            <label>
              关系强度（0～1）
              <input
                autoFocus
                name="strength"
                type="number"
                min={0}
                max={1}
                step={0.01}
                required
                defaultValue={editingLink.strength}
              />
            </label>
            <p>
              保存时会检查版本。若关系已被他人修改，请关闭弹窗并刷新星图后重新编辑。
            </p>
            <footer>
              <button
                type="button"
                disabled={action.busy}
                onClick={() => setEditingLink(null)}
              >
                取消
              </button>
              <button className="primary" disabled={action.busy}>
                {action.busy ? "正在保存…" : "保存强度"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {relation && (
        <Modal title="添加记忆关系" onClose={() => setRelation(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action.run(async () => {
                await api(
                  "/links",
                  "POST",
                  writeBody({
                    subject_id: subject,
                    action: "upsert",
                    source_id: f.get("source_id"),
                    target_id: f.get("target_id"),
                    type: f.get("type"),
                    strength: Number(f.get("strength")),
                  }),
                );
                setRelation(false);
                setVersion((v) => v + 1);
              }, "关系已保存");
            }}
          >
            <Feedback error={action.error} notice="" />
            {["source_id", "target_id"].map((key, i) => (
              <label key={key}>
                {i ? "目标记忆" : "起点记忆"}
                <select name={key} required>
                  {nodes.map((n) => (
                    <option value={n.id} key={n.id}>
                      {n.title || n.content.slice(0, 45)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              关系类型
              <select name="type">
                {["related_to", "supports", "contradicts", "supersedes"].map(
                  (t) => (
                    <option key={t}>{t}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              关系强度（0～1）
              <input
                name="strength"
                type="number"
                min={0}
                max={1}
                step={0.01}
                defaultValue={0.7}
              />
            </label>
            <p>仅同一空间内的不同记忆可建立关系。</p>
            <footer>
              <button type="button" onClick={() => setRelation(false)}>
                取消
              </button>
              <button className="primary" disabled={action.busy}>
                保存关系
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}
interface Statistics {
  active: number;
  archived: number;
  merged: number;
  retrieval_count: string;
  empty_result_rate: number | null;
  degraded_rate: number | null;
  index_failed: number;
  average_returned_tokens: number | null;
  as_of: number;
  [key: string]: unknown;
}
export function Stats({
  subject,
  refresh,
}: {
  subject: string;
  refresh: number;
}) {
  const [days, setDays] = useState("30");
  const data = useResource<Statistics>(
    "/stats" + query({ subject_id: subject, days }),
    refresh,
  );
  const d = data.data;
  const metrics = [
    ["正在使用", d?.active],
    ["已归档", d?.archived],
    ["已被合并", d?.merged],
    ["被找到次数", d?.retrieval_count],
    [
      "空结果率",
      d?.empty_result_rate == null
        ? "—"
        : (d.empty_result_rate * 100).toFixed(1) + "%",
    ],
    [
      "词法降级率",
      d?.degraded_rate == null ? "—" : (d.degraded_rate * 100).toFixed(1) + "%",
    ],
    ["索引失败", d?.index_failed],
    ["平均返回 token", d?.average_returned_tokens ?? "—"],
  ];
  return (
    <>
      <Heading
        eyebrow="AT A GLANCE"
        title="记忆统计"
        description="观察记忆的使用和检索健康状况。没有数据的指标显示为“—”。"
      >
        <select
          aria-label="统计时间范围"
          value={days}
          onChange={(e) => setDays(e.target.value)}
        >
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="90">最近 90 天</option>
        </select>
      </Heading>
      <State loading={data.loading} error={data.error}>
        <div className="metric-grid">
          {metrics.map(([label, value]) => (
            <section className="metric" key={label}>
              <span>{label}</span>
              <strong>{value ?? "—"}</strong>
            </section>
          ))}
        </div>
        <section className="panel padded">
          <h2>如何理解这些数字</h2>
          <p>
            被找到次数仅统计最终交给助手的记忆，不包含候选项、管理浏览和重复请求，次数不代表独立会话数。
          </p>
          <p>
            词法降级表示该次检索没有使用有效向量。请结合编码器配置和索引失败数量检查，不将词法检索视为语义检索正常。
          </p>
          <small>统计时点：{date(d?.as_of)}</small>
        </section>
      </State>
    </>
  );
}
interface Suggestion {
  id?: string;
  type: string;
  reason: string;
  items: Memory[];
}
export function Suggestions({
  subject,
  refresh,
}: {
  subject: string;
  refresh: number;
}) {
  const [version, setVersion] = useState(0);
  const data = useResource<Page<Suggestion>>(
    "/suggestions" + query({ subject_id: subject }),
    refresh + version,
  );
  const action = useAction();
  const [preview, setPreview] = useState<{
    value: Preview;
    body: Record<string, unknown>;
  } | null>(null);
  const [merge, setMerge] = useState<Suggestion | null>(null);
  return (
    <>
      <Heading
        eyebrow="A LITTLE CARE"
        title="整理建议"
        description="重复、冲突和过期只是提醒。由你判断是否保留，系统不会自动删除。"
      />
      <Feedback error={action.error} notice={action.notice} />
      <State
        loading={data.loading}
        error={data.error}
        empty={!data.data?.items.length}
      >
        {data.data?.items.map((s, i) => (
          <section className="panel padded" key={s.id || i}>
            <span className="tag warning">{s.type}</span>
            <h2>{s.reason}</h2>
            {s.items.map((m) => (
              <div className="suggestion-memory" key={m.id}>
                <strong>{m.title || "未命名记忆"}</strong>
                <p>{m.content}</p>
                <small>
                  版本 {m.revision} · 重要程度 {m.importance}
                </small>
              </div>
            ))}
            <div className="toolbar">
              <button
                disabled={action.busy || !s.items.length}
                onClick={() =>
                  void action.run(async () => {
                    const body = {
                      subject_id: subject,
                      items: s.items.map((m) => ({
                        id: m.id,
                        revision: m.revision,
                      })),
                      reason: s.reason,
                    };
                    setPreview({
                      body,
                      value: await api<Preview>(
                        "/memories/archive-preview",
                        "POST",
                        writeBody(body),
                      ),
                    });
                  }, "")
                }
              >
                预览归档…
              </button>
              {s.items.length > 1 && (
                <button onClick={() => setMerge(s)}>整理合并…</button>
              )}
            </div>
          </section>
        ))}
      </State>
      {preview && (
        <PreviewDialog
          title="确认归档建议中的记忆"
          preview={preview.value}
          busy={action.busy}
          error={action.error}
          onClose={() => setPreview(null)}
          onConfirm={() =>
            void action.run(async () => {
              await api(
                "/memories/archive",
                "POST",
                writeBody({
                  ...preview.body,
                  preview_token: preview.value.preview_token,
                }),
              );
              setPreview(null);
              setVersion((v) => v + 1);
            }, "已归档，可在记忆页面恢复")
          }
        />
      )}
      {merge && (
        <Modal title="合并前确认最终内容" onClose={() => setMerge(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const target = merge.items.find((m) => m.id === f.get("target"))!;
              if (
                !window.confirm(
                  "确认合并？源记忆将归档并指向目标，来源、关系和次数将按规则合并。",
                )
              )
                return;
              void action.run(async () => {
                await api(
                  "/memories/merge",
                  "POST",
                  writeBody({
                    subject_id: subject,
                    target: { id: target.id, revision: target.revision },
                    sources: merge.items
                      .filter((m) => m.id !== target.id)
                      .map((m) => ({ id: m.id, revision: m.revision })),
                    final_content: f.get("content"),
                    reason: f.get("reason"),
                  }),
                );
                setMerge(null);
                setVersion((v) => v + 1);
              }, "合并已完成");
            }}
          >
            <Feedback error={action.error} notice="" />
            <label>
              保留的目标记忆
              <select name="target">
                {merge.items.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.title || m.content.slice(0, 50)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              最终正文
              <textarea
                name="content"
                required
                maxLength={1200}
                rows={6}
                defaultValue={merge.items[0]?.content}
              />
            </label>
            <label>
              合并理由
              <input name="reason" required />
            </label>
            <p>请保留事实的限定条件，不要把互相矛盾的内容直接拼接。</p>
            <footer>
              <button type="button" onClick={() => setMerge(null)}>
                取消
              </button>
              <button className="primary" disabled={action.busy}>
                确认合并
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}
