import { useEffect, useMemo, useState } from "react";
import { Graph3D } from "./graph3d";
import {
  api,
  dataChanged,
  query,
  writeBody,
  type AccountKind,
  type Graph,
  type AccountStats,
  type Config,
  type Link,
  type Memory,
  type Page,
  type Preview,
} from "./api";
import {
  ConfirmDialog,
  date,
  Feedback,
  Heading,
  Modal,
  PreviewDialog,
  State,
  types,
  useAction,
  useResource,
  weightText,
} from "./ui";
import { MEMORY_CATALOG, QQBOT_LINK_CATALOG } from "../core/catalog";
const colors = Object.fromEntries(
  MEMORY_CATALOG.map((item) => [item.key, item.color]),
) as Record<string, string>;
const linkLabels = Object.fromEntries(
  QQBOT_LINK_CATALOG.map((item) => [item.key, item.label]),
) as Record<string, string>;
const nodeName = (n: Memory | undefined) =>
  n ? n.title || n.content.slice(0, 45) : "关联记忆";
export function GraphView({
  subject,
  refresh,
  kind = "standard",
}: {
  subject: string;
  refresh: number;
  kind?: AccountKind;
}) {
  const [version, setVersion] = useState(0);
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [serverQuery, setServerQuery] = useState("");
  const [timePoint, setTimePoint] = useState<number | null>(null);
  const [selected, setSelected] = useState<Memory | null>(null);
  const [list, setList] = useState(false);
  const [relation, setRelation] = useState(false);
  const [editingLink, setEditingLink] = useState<Link | null>(null);
  const [removingLink, setRemovingLink] = useState<Link | null>(null);
  const [fallbackReason, setFallbackReason] = useState("");
  const action = useAction();
  useEffect(() => {
    setVersion(0);
    setType("");
    setSearch("");
    setServerQuery("");
    setTimePoint(null);
    setSelected(null);
    setRelation(false);
    setEditingLink(null);
    setRemovingLink(null);
    setFallbackReason("");
  }, [subject, kind]);
  // D-16: search is issued server-side so it covers the whole account, not just
  // the 500 nodes already loaded; local filtering only gives instant feedback
  // while the debounce is still pending.
  useEffect(() => {
    const timer = setTimeout(() => setServerQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const graph = useResource<Graph>(
    "/graph" +
      query({
        subject_id: subject,
        type,
        q: serverQuery || undefined,
        node_limit: 5000,
        edge_limit: 500,
      }),
    `${refresh}:${version}`,
  );
  const allNodes = useMemo(() => graph.data?.nodes || [], [graph.data]);
  const allEdges = useMemo(() => graph.data?.edges || [], [graph.data]);
  const bounds = useMemo(() => {
    if (!allNodes.length) return null;
    let min = Infinity,
      max = -Infinity;
    for (const n of allNodes) {
      min = Math.min(min, n.created_at);
      max = Math.max(max, n.created_at);
    }
    return { min, max };
  }, [allNodes]);
  const effectiveTime = timePoint ?? bounds?.max ?? null;
  const nodes = useMemo(
    () =>
      effectiveTime == null
        ? allNodes
        : allNodes.filter((n) => n.created_at <= effectiveTime),
    [allNodes, effectiveTime],
  );
  const edges = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return allEdges.filter(
      (e) =>
        (effectiveTime == null ||
          !e.created_at ||
          e.created_at <= effectiveTime) &&
        ids.has(e.source_id) &&
        ids.has(e.target_id),
    );
  }, [allEdges, nodes, effectiveTime]);
  const results = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return nodes
      .filter(
        (n) =>
          (n.title || "").toLowerCase().includes(term) ||
          n.content.toLowerCase().includes(term) ||
          n.keywords.some((k) => k.toLowerCase().includes(term)),
      )
      .slice(0, 20);
  }, [nodes, search]);
  const visible =
    selected && nodes.some((n) => n.id === selected.id) ? selected : null;
  const visibleEdges = useMemo(
    () =>
      visible
        ? edges.filter(
            (e) => e.source_id === visible.id || e.target_id === visible.id,
          )
        : [],
    [edges, visible],
  );
  const visibleLinks = useMemo(
    () => visibleEdges.filter((e) => e.kind !== "similarity"),
    [visibleEdges],
  );
  const visibleSimilar = useMemo(
    () => visibleEdges.filter((e) => e.kind === "similarity"),
    [visibleEdges],
  );
  const typeOptions = MEMORY_CATALOG.filter((item) =>
    item.kinds.includes(kind),
  );
  return (
    <>
      <Heading
        eyebrow="MEMORY GALAXY"
        title="记忆星图"
        description="拖动时间轴回看记忆网络的生长；搜索或点击节点，镜头会飞向它并展示关系链。"
      >
        <button disabled={!nodes.length} onClick={() => setRelation(true)}>
          ＋ 添加关系
        </button>
      </Heading>
      <Feedback error={action.error} notice={action.notice} />
      {fallbackReason && !list && (
        <div className="notice warning">
          {fallbackReason} 已切换为文字列表，记忆管理不受影响。
        </div>
      )}
      {graph.data?.truncated && (
        <div className="notice warning">
          当前账户记忆较多，星图最多显示 5000 个点、500 条边。搜索框的关键词由服务端在全库范围内筛选，不受已加载节点数量限制；缩小类型范围或指定关键词可看得更清楚。
        </div>
      )}
      <State
        loading={graph.loading}
        error={graph.error}
        empty={!allNodes.length}
      >
        {list || fallbackReason ? (
          <section className="panel padded">
            <div className="filters">
              <button
                onClick={() => {
                  setFallbackReason("");
                  setList(false);
                }}
              >
                重试星图
              </button>
            </div>
            {nodes.map((n) => (
              <div className="list-row" key={n.id}>
                <button className="text-button" onClick={() => setSelected(n)}>
                  {n.title || n.content.slice(0, 60)}
                </button>
                <span>
                  {types[n.type]} · 权重 {weightText(n.weight)} · {date(n.created_at)}
                </span>
              </div>
            ))}
          </section>
        ) : (
          <div className="graph-shell">
            <aside className="graph-side" aria-label="星图控制台">
              <label>
                搜索节点
                <input
                  aria-label="搜索节点"
                  value={search}
                  placeholder="名称、内容或关键词"
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              {search.trim() && (
                <div className="graph-results">
                  {results.length ? (
                    results.map((n) => (
                      <button
                        className="text-button"
                        key={n.id}
                        onClick={() => setSelected(n)}
                      >
                        {n.title || n.content.slice(0, 40)}
                        <small>{types[n.type]}</small>
                      </button>
                    ))
                  ) : (
                    <small>没有匹配的节点</small>
                  )}
                </div>
              )}
              <label>
                类型
                <select
                  aria-label="类型"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                >
                  <option value="">全部类型</option>
                  {typeOptions.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {bounds && (
                <fieldset className="graph-timeline">
                  <legend>时间轴回溯</legend>
                  <input
                    type="range"
                    aria-label="时间轴"
                    min={bounds.min}
                    max={bounds.max}
                    value={effectiveTime ?? bounds.max}
                    onChange={(e) => setTimePoint(Number(e.target.value))}
                  />
                  <small>
                    {date(effectiveTime)} · 可见 {nodes.length} 点 /{" "}
                    {edges.length} 条关系
                  </small>
                  <button
                    type="button"
                    disabled={timePoint == null}
                    onClick={() => setTimePoint(null)}
                  >
                    回到最新
                  </button>
                </fieldset>
              )}
              <div className="legend">
                {typeOptions.map((item) => (
                  <span key={item.key}>
                    <i style={{ background: colors[item.key] }} />
                    {item.label}
                  </span>
                ))}
              </div>
              <button onClick={() => setList(true)}>文字列表</button>
              <p className="graph-help">
                拖拽旋转 · 滚轮缩放 · 悬停高亮 ·
                点击飞行；键盘方向键旋转、空格暂停自动环绕。
              </p>
            </aside>
            <div className="graph-stage">
              {nodes.length ? (
                <Graph3D
                  nodes={nodes}
                  edges={edges}
                  colors={colors}
                  selectedId={visible?.id ?? null}
                  onSelect={setSelected}
                  onFailure={(message) => setFallbackReason(message)}
                />
              ) : (
                <div className="notice">
                  该时间点尚无记忆。向右拖动时间轴或点击“回到最新”。
                </div>
              )}
              {visible && (
                <aside className="graph-detail" aria-label="节点详情与关系链">
                  <header>
                    <strong>{visible.title || "记忆详情"}</strong>
                    <button
                      aria-label="关闭详情"
                      onClick={() => setSelected(null)}
                    >
                      ✕
                    </button>
                  </header>
                  <p className="full-content">{visible.content}</p>
                  <small>
                    {types[visible.type]} · 权重 {weightText(visible.weight)} · 找到{" "}
                    {visible.retrieval_count} 次 · {date(visible.created_at)}
                  </small>
                  <h3>关系链</h3>
                  {visibleLinks.length === 0 && (
                    <small>当前时间点没有手动关系链。</small>
                  )}
                  {visibleLinks.map((e) => {
                    const outgoing = e.source_id === visible.id;
                    const other = nodes.find(
                      (n) =>
                        n.id === (outgoing ? e.target_id : e.source_id),
                    );
                    return (
                      <div className="relation-chain" key={e.id}>
                        <div className="relation-path">
                          {outgoing ? (
                            <>
                              <span className="relation-node current">
                                {nodeName(visible)}
                              </span>
                              <span className="relation-arrow">
                                --[{linkLabels[e.type] || e.type}]--&gt;
                              </span>
                              <button
                                className="text-button relation-node"
                                onClick={() => other && setSelected(other)}
                              >
                                {nodeName(other)}
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="text-button relation-node"
                                onClick={() => other && setSelected(other)}
                              >
                                {nodeName(other)}
                              </button>
                              <span className="relation-arrow">
                                --[{linkLabels[e.type] || e.type}]--&gt;
                              </span>
                              <span className="relation-node current">
                                {nodeName(visible)}
                              </span>
                            </>
                          )}
                        </div>
                        <small>强度 {e.strength}</small>
                        <div className="toolbar">
                          <button
                            disabled={action.busy}
                            onClick={() => setEditingLink(e)}
                          >
                            编辑强度
                          </button>
                          <button
                            className="danger-outline"
                            disabled={action.busy}
                            onClick={() => setRemovingLink(e)}
                          >
                            移除
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {visibleSimilar.length > 0 && (
                    <>
                      <h3>相似记忆</h3>
                      {visibleSimilar.map((e) => {
                        const other = nodes.find(
                          (n) =>
                            n.id ===
                            (e.source_id === visible.id
                              ? e.target_id
                              : e.source_id),
                        );
                        return (
                          <div className="relation-chain" key={e.id}>
                            <div className="relation-path">
                              <span className="relation-node current">
                                {nodeName(visible)}
                              </span>
                              <span className="relation-arrow">
                                ≈ {Math.round((e.similarity || e.strength) * 100)}%
                              </span>
                              <button
                                className="text-button relation-node"
                                onClick={() => other && setSelected(other)}
                              >
                                {nodeName(other)}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </aside>
              )}
            </div>
          </div>
        )}
      </State>
      {removingLink && (
        <ConfirmDialog
          title="删除这条关系？"
          onClose={() => setRemovingLink(null)}
          onConfirm={async () => {
            await api(
              "/links",
              "POST",
              writeBody({
                subject_id: subject,
                action: "remove",
                source_id: removingLink.source_id,
                target_id: removingLink.target_id,
                type: removingLink.type,
                expected_revision: removingLink.revision,
              }),
            );
            dataChanged();
            setVersion((v) => v + 1);
            setRemovingLink(null);
          }}
        >
          记忆正文不会删除，只移除这条关联。
        </ConfirmDialog>
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
                dataChanged();
                setEditingLink(null);
                setVersion((v) => v + 1);
              }, "关系强度已更新");
            }}
          >
            <Feedback error={action.error} notice="" />
            <p>
              关系类型：{linkLabels[editingLink.type] || editingLink.type} · 当前版本：{editingLink.revision}
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
                dataChanged();
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
              {kind === "qqbot" ? (
                <>
                  <input
                    name="type"
                    list="qqbot-link-types"
                    required
                    maxLength={32}
                    placeholder="选择或输入自定义关系"
                    defaultValue="related_to"
                  />
                  <datalist id="qqbot-link-types">
                    {QQBOT_LINK_CATALOG.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.label}
                      </option>
                    ))}
                  </datalist>
                </>
              ) : (
                <select name="type">
                  {QQBOT_LINK_CATALOG.slice(0, 4).map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              )}
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
  memory_total: number;
  memory_total_tokens: number;
  extraction_total_tokens: number;
  hit_effective_rate: number | null;
  result_rate?: number | null;
  labeled_search_requests?: number;
  labeled_hit_at_1?: number | null;
  labeled_hit_at_3?: number | null;
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
  onSelectAccount,
}: {
  subject: string;
  refresh: number;
  onSelectAccount?: (id: string) => void;
}) {
  const [days, setDays] = useState("30");
  const data = useResource<Statistics>(
    "/stats" + query({ subject_id: subject, days }),
    refresh,
  );
  const accountStats = useResource<Page<AccountStats>>(
    "/stats/accounts" + query({ days }),
    refresh,
  );
  const config = useResource<Config>("/config", refresh);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildResult, setRebuildResult] = useState<string>("");
  const d = data.data;
  const embeddingMissing = config.data && !config.data.embeddingModel;
  const pct = (value: number | null | undefined) =>
    value == null ? "—" : (value * 100).toFixed(1) + "%";
  const metricGroups = [
    {
      title: "记忆规模",
      items: [
        ["记忆总条数", d?.memory_total],
        ["已激活记忆", d?.active],
        ["已归档", d?.archived],
        ["已合并", d?.merged],
        ["记忆内容 token", d?.memory_total_tokens],
      ],
    },
    {
      title: "检索质量",
      items: [
        ["有结果率", pct(d?.result_rate ?? d?.hit_effective_rate)],
        ["标注检索请求", d?.labeled_search_requests ?? "—"],
        ["标注 Hit@1（答案第 1 位）", pct(d?.labeled_hit_at_1)],
        ["标注 Hit@3（答案前 3 位）", pct(d?.labeled_hit_at_3)],
        ["空结果率", pct(d?.empty_result_rate)],
      ],
    },
    {
      title: "检索成本与健康",
      items: [
        ["提取内容 token", d?.extraction_total_tokens],
        [
          "平均返回 token",
          typeof d?.average_returned_tokens === "number"
            ? d.average_returned_tokens.toFixed(1)
            : "—",
        ],
        ["被找到次数", d?.retrieval_count],
        ["词法降级率", pct(d?.degraded_rate)],
        ["索引失败", d?.index_failed],
      ],
    },
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
          <option value="1">最近 1 天</option>
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="90">最近 90 天</option>
        </select>
      </Heading>
      <div className="maintenance-row">
        <button
          disabled={rebuilding}
          onClick={async () => {
            setRebuilding(true);
            setRebuildResult("");
            try {
              const stats = await api<{ memories: number; pairs: number }>(
                "/maintenance/similarity",
                "POST",
                writeBody({ subject_id: subject, neighbors: 5 }),
              );
              setRebuildResult(
                "已扫描 " + stats.memories + " 条记忆，关联 " + stats.pairs + " 对相似记忆。",
              );
              dataChanged();
            } catch (error) {
              setRebuildResult(error instanceof Error ? error.message : "重建失败");
            } finally {
              setRebuilding(false);
            }
          }}
        >
          {rebuilding ? "正在重建…" : "重建相似关系"}
        </button>
        <span className="muted">{rebuildResult}</span>
      </div>
      <State loading={data.loading} error={data.error}>
        <div className="metric-groups">
          {metricGroups.map((group) => (
            <section className="metric-group" key={group.title}>
              <h3>{group.title}</h3>
              <div className="metric-grid">
                {group.items.map(([label, value]) => (
                  <section className="metric" key={String(label)}>
                    <span>{label}</span>
                    <strong>{value ?? "—"}</strong>
                  </section>
                ))}
              </div>
            </section>
          ))}
        </div>
        <section className="panel padded">
          <h2>如何理解这些数字</h2>
          {embeddingMissing && (
            <div className="notice warning">
              当前未配置向量编码器，检索只能走词法匹配；上方「词法降级率」会显示所选时间范围内的实际降级比例。到「设置 → 检索配置」填写
              embeddingModel / embeddingBaseUrl / embeddingDimension
              后保存，可启用语义检索、明显提升召回率与有结果率。
            </div>
          )}
          <p>
            <strong>有结果率</strong> = 至少返回一条记忆的检索次数 ÷
            检索总次数。它只说明“有没有搜到东西”，不代表搜到的是否正确；样本若来自压测或预筛过的可答查询，这个数字会偏高，不能当作检索质量。
          </p>
          <p>
            <strong>标注 Hit@1 / Hit@3 是什么？</strong>{" "}
            假设一条测试查询的标准答案是记忆 A：A 排在返回结果第 1 位 → Hit@1
            命中；A 排在第 2 或第 3 位 → Hit@3 命中；A 不在前 3 → 未命中。当前账户共{" "}
            {d?.labeled_search_requests ?? 0} 条带标准答案的检索，其中标注 Hit@1 为{" "}
            {pct(d?.labeled_hit_at_1)}、标注 Hit@3 为 {pct(d?.labeled_hit_at_3)}
            。普通搜索没有标准答案，因此显示为“—”。
          </p>
          <p>
            <strong>重建相似关系</strong> 会扫描当前账户全部记忆，按「设置 → 检索配置」中的相似度构建阈值重新生成 memory_similarity
            自动关系，用于检索时折叠高度相似记忆、减少重复内容；它不会修改或删除手动关系链（links）。
          </p>
          <p>
            <strong>提取内容 token</strong> 为所选时间范围内实际返回内容的累计估算，用于衡量检索带来的上下文成本；v0.5.0 起所有「token」口径统一为响应 data 的 UTF-8 字节数（与 token_budget 同单位），不是模型精确分词，也不代表计费
            token；<strong>记忆内容 token</strong>
            是当前所有记忆正文的估算总量。没有检索请求时命中率、空结果率等显示为“—”。
          </p>
          <p>
            <strong>被找到次数</strong>仅统计最终交给助手的记忆，不包含候选项、管理浏览和重复请求，次数不代表独立会话数；同一记忆在不同会话中被再次命中会累加。
          </p>
          <p>
            <strong>词法降级率</strong>表示该次检索没有使用有效向量（编码器未配置、索引失败或向量过期时会降级为纯词法）。请结合下方「索引失败」和编码器配置排查，不要把词法检索当作语义检索正常。
          </p>
          <p>
            <strong>如何提高命中率</strong>：① 让 Agent
            在会话开始就检索，并传入贴近记忆内容的自然语言 query（无需再靠穷举关键词）；
            ② 配置向量编码器启用语义检索；③
            记忆正文写完整句子、关键词填写同义说法；④
            关注「空结果率」「词法降级率」「索引失败」三项，任一异常先修检索链路。
          </p>
          <small>
            统计口径：按所选时间范围实时聚合检索与记忆数据，页面打开或切换范围时重新计算；统计时点：
            {date(d?.as_of)}
          </small>
        </section>
      </State>
      <section className="panel padded">
        <h2>按账户统计</h2>
        <State
          loading={accountStats.loading}
          error={accountStats.error}
          empty={!accountStats.data?.items.length}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>账户</th>
                  <th>记忆总数</th>
                  <th>内容 token</th>
                  <th>检索请求</th>
                  <th>提取 token</th>
                  <th>有结果率</th>
                  <th>标注 Hit@1 / @3</th>
                  <th>活跃 / 归档 / 合并</th>
                </tr>
              </thead>
              <tbody>
                {accountStats.data?.items.map((a) => (
                  <tr key={a.subject_id}>
                    <td>
                      {onSelectAccount ? (
                        <button
                          className="text-button"
                          onClick={() => onSelectAccount(a.subject_id)}
                        >
                          {a.label}
                        </button>
                      ) : (
                        a.label
                      )}
                    </td>
                    <td>{a.memory_total}</td>
                    <td>{a.memory_total_tokens}</td>
                    <td>{a.search_requests}</td>
                    <td>{a.extraction_total_tokens}</td>
                    <td>
                      {(a.result_rate ?? a.hit_effective_rate) == null
                        ? "—"
                        : (
                            (a.result_rate ?? a.hit_effective_rate)! * 100
                          ).toFixed(1) + "%"}
                    </td>
                    <td>
                      {a.labeled_hit_at_1 == null || a.labeled_hit_at_3 == null
                        ? "—"
                        : (a.labeled_hit_at_1 * 100).toFixed(1) +
                          "% / " +
                          (a.labeled_hit_at_3 * 100).toFixed(1) +
                          "%"}
                    </td>
                    <td>
                      {a.active} / {a.archived} / {a.merged}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </State>
      </section>
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
    `${refresh}:${version}`,
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
              dataChanged();
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
                dataChanged();
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
