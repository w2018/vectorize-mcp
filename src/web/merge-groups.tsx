import { useCallback, useEffect, useState } from "react";
import {
  api,
  writeBody,
  type MaintenanceJob,
  type MergeBatch,
  type MergeDraft,
  type SimilarityGroup,
} from "./api";

const RISK_LABEL: Record<string, string> = {
  LOW_SCORE: "低分",
  NUMBER_CONFLICT: "数字冲突",
  TYPE_MIXED: "类型混杂",
  PROTECTED: "受保护类型",
};

/** 记忆整理页：相似分组 -> 人工勾选 -> 模型压缩去重合并（全后台任务 + 进度轮询）。 */
export function MergeGroupsPanel({
  subject,
  onChanged,
}: {
  subject: string;
  onChanged: () => void;
}) {
  const [groups, setGroups] = useState<SimilarityGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<MaintenanceJob | null>(null);
  const [draft, setDraft] = useState<MergeDraft | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [busy, setBusy] = useState("");
  const [compact, setCompact] = useState<{ rows: number; bytes: number } | null>(null);
  const [basis, setBasis] = useState<"lexical" | "llm">("llm");
  const [threshold, setThreshold] = useState(0.85);
  const [thresholdText, setThresholdText] = useState("0.85");
  const [batches, setBatches] = useState<MergeBatch[]>([]);
  const [batchView, setBatchView] = useState<MergeBatch | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [data, history, active] = await Promise.all([
        api<{ items: SimilarityGroup[]; total: number }>(
          "/maintenance/groups?subject_id=" + encodeURIComponent(subject) + "&status=proposed&limit=200",
        ),
        api<{ items: MergeBatch[] }>(
          "/maintenance/batches?subject_id=" + encodeURIComponent(subject) + "&limit=5",
        ),
        api<MaintenanceJob | null>(
          "/maintenance/jobs/active?subject_id=" + encodeURIComponent(subject),
        ),
      ]);
      setGroups(data.items);
      setTotal(data.total);
      setSelected((prev) => new Set([...prev].filter((id) => data.items.some((g) => g.id === id))));
      setBatches(history.items);
      // 刷新页面后从服务端接续仍在运行的任务，避免进度条消失又重建触发 JOB_BUSY。
      if (active && (active.status === "queued" || active.status === "running")) setJob(active);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载分组失败");
    } finally {
      setLoading(false);
    }
  }, [subject]);

  useEffect(() => {
    void load();
  }, [load]);

  // 任务轮询：刷新页面后仍按状态继续显示（任务在服务端）。
  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const timer = setInterval(() => {
      void api<MaintenanceJob>("/maintenance/jobs/" + job.id)
        .then((next) => {
          setJob(next);
          if (next.status === "done") {
            void load();
            onChanged();
            const result = next.result as { merged?: number; groups?: number; batch_id?: string };
            if (next.kind === "merge_groups") {
              setNotice("合并完成：" + String(result.merged ?? 0) + " 组，可查看合并前后对比。");
              if (result.batch_id) void viewBatch(String(result.batch_id));
              setSelected(new Set());
            } else {
              setNotice("重建完成：生成 " + String(result.groups ?? 0) + " 个分组。");
            }
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [job, load, onChanged]);

  const saveThreshold = (value: number) => {
    const safe = Math.max(0.3, Math.min(0.99, value));
    setThreshold(safe);
    setThresholdText(String(safe));
    try {
      window.localStorage.setItem("merge-threshold", String(safe));
    } catch {
      /* 忽略隐私模式下的存储失败 */
    }
  };

  /** 遇到 JOB_BUSY 时接续服务端已有任务，而不是让用户以为需要再点一次。 */
  const resumeActiveJob = async (fallback: string) => {
    try {
      const active = await api<MaintenanceJob | null>(
        "/maintenance/jobs/active?subject_id=" + encodeURIComponent(subject),
      );
      if (active && (active.status === "queued" || active.status === "running")) {
        setJob(active);
        setNotice("已有任务正在运行，已接续显示进度。");
        return;
      }
    } catch {
      /* 忽略接续查询失败，回落到原错误 */
    }
    setError(fallback);
  };

  const rebuild = async () => {
    setBusy("rebuild");
    setError("");
    setNotice("");
    try {
      const created = await api<MaintenanceJob>(
        "/maintenance/groups/rebuild",
        "POST",
        writeBody({
          subject_id: subject,
          basis,
          group_threshold: threshold,
        }),
      );
      setJob(created);
    } catch (e) {
      const message = e instanceof Error ? e.message : "建组失败";
      if (message.includes("JOB_BUSY")) await resumeActiveJob(message);
      else setError(message);
    } finally {
      setBusy("");
    }
  };

  const ignore = async (ids: string[]) => {
    setBusy("ignore");
    try {
      await api("/maintenance/groups/ignore", "POST", writeBody({ subject_id: subject, group_ids: ids }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "忽略失败");
    } finally {
      setBusy("");
    }
  };

  const openPreview = async (group: SimilarityGroup) => {
    setBusy("preview");
    setError("");
    try {
      const data = await api<MergeDraft>(
        "/maintenance/merge/preview",
        "POST",
        writeBody({ subject_id: subject, group_id: group.id }),
      );
      setDraft(data);
      setDraftContent(data.content);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成合并稿失败");
    } finally {
      setBusy("");
    }
  };

  const startMerge = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy("merge");
    setError("");
    try {
      const created = await api<MaintenanceJob>(
        "/maintenance/merge",
        "POST",
        writeBody({ subject_id: subject, group_ids: ids }),
      );
      setJob(created);
      setDraft(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "合并任务创建失败";
      if (message.includes("JOB_BUSY")) await resumeActiveJob(message);
      else setError(message);
    } finally {
      setBusy("");
    }
  };

  const viewBatch = async (batchId: string) => {
    try {
      setBatchView(
        await api<MergeBatch>(
          "/maintenance/batches/" + encodeURIComponent(batchId) +
            "?subject_id=" + encodeURIComponent(subject),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取合并结果失败");
    }
  };

  const undo = async (batchId: string, groupIds?: string[]) => {
    const tip = groupIds && groupIds.length
      ? "确认撤销这一组合并？该组来源记忆会恢复为可用状态。"
      : "确认撤销本次合并？来源记忆会恢复为可用状态。";
    if (!window.confirm(tip)) return;
    setBusy("undo");
    try {
      const result = await api<{ restored: number; skipped: string[]; remaining: number }>(
        "/maintenance/merge/undo",
        "POST",
        writeBody({ subject_id: subject, batch_id: batchId, group_ids: groupIds }),
      );
      setNotice("已撤销，恢复 " + result.restored + " 条记忆。");
      if (result.remaining > 0) await viewBatch(batchId);
      else setBatchView(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "撤销失败");
    } finally {
      setBusy("");
    }
  };

  const previewCompact = async () => {
    setBusy("compact");
    try {
      setCompact(await api<{ rows: number; bytes: number }>("/maintenance/compact/preview", "POST", writeBody({ subject_id: subject })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "统计失败");
    } finally {
      setBusy("");
    }
  };

  const runCompact = async () => {
    if (!window.confirm("确认清理已归档记忆的历史版本？此操作不可恢复。")) return;
    setBusy("compact");
    try {
      const result = await api<{ deleted: number; bytes: number }>(
        "/maintenance/compact",
        "POST",
        writeBody({ subject_id: subject, confirm: true }),
      );
      setCompact(null);
      setNotice("已清理 " + result.deleted + " 条历史版本，释放约 " + Math.round(result.bytes / 1024) + " KB。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "清理失败");
    } finally {
      setBusy("");
    }
  };

  const running = job && (job.status === "queued" || job.status === "running");
  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const stage = !job
    ? ""
    : job.kind === "merge_groups"
      ? "合并"
      : basis === "llm"
        ? "模型判定与建组"
        : "词法召回与建组";
  // 高置信=最低相似度达到阈值且不低于 0.9。数字冲突无法在相似度上体现，
  // 因此不排除选组，但在真正合并前会二次确认并明确告知会保留更可信的一条、可在 7 天内撤销。
  const confidenceFloor = Math.max(threshold, 0.9);
  const confidence = groups.filter((g) => g.min_score >= confidenceFloor);
  const conflictCount = confidence.filter((g) => g.risk.split(",").includes("NUMBER_CONFLICT")).length;
  const requestMerge = (ids: string[]) => {
    const conflicts = groups.filter((g) => ids.includes(g.id) && g.risk.split(",").includes("NUMBER_CONFLICT")).length;
    if (conflicts > 0) {
      const ok = window.confirm(
        "已选 " + ids.length + " 组，其中 " + conflicts + " 组存在数字冲突。合并会把多组压成一条，冲突数字只保留更可信的一项并在原因中说明；来源记忆会归档，7 天内可逐组或整批撤销。确认继续？",
      );
      if (!ok) return;
    }
    void startMerge(ids);
  };
  const previewGroup = draft ? groups.find((g) => g.id === draft.group_id) : undefined;

  useEffect(() => {
    const saved = Number(window.localStorage.getItem("merge-threshold"));
    if (Number.isFinite(saved) && saved >= 0.3 && saved <= 0.99) {
      setThreshold(saved);
      setThresholdText(String(saved));
    }
  }, []);

  return (
    <section className="panel padded">
      <h2>相似分组与压缩去重</h2>
      <p className="muted">
        先按所选依据生成相似分组，你勾选后由模型压缩成一条，旧记忆归档（7 天内可逐组或整批撤销）。检索方式不变。
      </p>
      <div className="maintenance-row">
        <label className="inline-field">
          重建依据
          <select
            value={basis}
            onChange={(e) => setBasis(e.target.value as "lexical" | "llm")}
            disabled={!!running}
          >
            <option value="llm">通用模型（判断是否同一件事）</option>
            <option value="lexical">词法（按字面，快）</option>
          </select>
        </label>
        <label className="inline-field">
          合并阈值
          <input
            type="number"
            min={0.3}
            max={0.99}
            step={0.01}
            value={thresholdText}
            onChange={(e) => {
              const raw = e.target.value;
              setThresholdText(raw);
              const next = Number(raw);
              if (raw.trim() !== "" && Number.isFinite(next) && next >= 0.3 && next <= 0.99) {
                setThreshold(next);
                try {
                  window.localStorage.setItem("merge-threshold", String(next));
                } catch {
                  /* 忽略隐私模式下的存储失败 */
                }
              }
            }}
            onBlur={() => setThresholdText(String(threshold))}
            disabled={!!running}
          />
        </label>
        <button disabled={!!running || busy !== ""} onClick={rebuild}>
          {busy === "rebuild" ? "创建任务" : "重建分组"}
        </button>
        <button
          disabled={!!running || busy !== "" || selected.size === 0}
          onClick={() => requestMerge([...selected])}
        >
          合并已选（{selected.size} 组）
        </button>
        <button
          disabled={!!running || busy !== "" || confidence.length === 0}
          onClick={() => setSelected(new Set(confidence.map((g) => g.id)))}
        >
          选中高置信组（{confidence.length}）
        </button>
        {running && (
          <span className="muted">
            {stage}：{job!.done}/{job!.total}（{pct}%）
            <button className="link" onClick={() => api("/maintenance/jobs/" + job!.id + "/cancel", "POST", writeBody({}))}>取消</button>
          </span>
        )}
      </div>
      {running && (
        <div className="merge-progress"><span style={{ width: pct + "%" }} /></div>
      )}
      {job && job.status === "failed" && (
        <div className="notice warning">任务失败：{job.error || "未知错误"}</div>
      )}
      {error && <div className="notice warning">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      <div className="muted">
        共 {total} 个分组；当前阈值下可一键选中 {confidence.length} 个高置信组
        {conflictCount > 0 ? "（其中 " + conflictCount + " 个含数字冲突，合并前会再次确认）" : ""}
      </div>
      {loading ? (
        <p className="muted">加载中</p>
      ) : groups.length === 0 ? (
        <p className="muted">还没有分组。点「重建分组」按当前记忆生成。</p>
      ) : (
        <div className="merge-groups">
          {groups.map((group) => {
            const checked = selected.has(group.id);
            return (
              <div className={"merge-group" + (checked ? " selected" : "")} key={group.id}>
                <label className="merge-group-head">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(group.id);
                      else next.delete(group.id);
                      setSelected(next);
                    }}
                  />
                  <span>
                    {group.member_count} 条 · 最低分 {group.min_score.toFixed(3)} · {group.basis === "llm" ? "模型" : "词法"}
                  </span>
                  {group.risk.split(",").filter(Boolean).map((risk) => (
                    <span className="tag warning" key={risk}>{RISK_LABEL[risk] ?? risk}</span>
                  ))}
                </label>
                <ul className="merge-members">
                  {(group.members ?? []).map((m) => (
                    <li key={m.memory_id}>
                      <strong>{m.title || "未命名"}</strong>
                      <span className="muted">（{m.type} · {m.score.toFixed(3)}）</span>
                      <p>{String(m.content ?? "").slice(0, 160)}</p>
                    </li>
                  ))}
                </ul>
                <div className="merge-group-actions">
                  <button disabled={busy !== ""} onClick={() => openPreview(group)}>预览合并</button>
                  <button disabled={busy !== ""} onClick={() => ignore([group.id])}>忽略</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {batches.length > 0 && (
        <div className="merge-batches">
          <h3>最近合并批次</h3>
          {batches.map((batch) => (
            <div className="merge-batch-row" key={batch.id}>
              <span>
                {new Date(Number(batch.created_at)).toLocaleString()} · {batch.groups} 组 · {batch.status}
              </span>
              <button className="link" onClick={() => viewBatch(batch.id)}>查看合并前后对比</button>
              {batch.status === "done" && (
                <button className="link" disabled={busy !== ""} onClick={() => undo(batch.id)}>撤销整批</button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="maintenance-row" style={{ marginTop: 16 }}>
        <button disabled={busy !== ""} onClick={previewCompact}>统计可回收空间</button>
        {compact && (
          <span className="muted">
            已归档历史版本 {compact.rows} 条，约 {Math.round(compact.bytes / 1024)} KB。
            <button className="link" onClick={runCompact}>清理</button>
          </span>
        )}
      </div>
      {draft && (
        <div className="modal-backdrop">
          <div className="modal merge-preview">
            <h3>合并预览（合并前 vs 合并后）</h3>
            <div className="compare-cols">
              <div>
                <h4>合并前（{previewGroup?.members?.length ?? 0} 条）</h4>
                {(previewGroup?.members ?? []).map((m) => (
                  <div className="compare-item" key={m.memory_id}>
                    <strong>{m.title || "未命名"}</strong>
                    <span className="muted">（{m.type} · {m.score.toFixed(3)}）</span>
                    <p>{String(m.content ?? "")}</p>
                  </div>
                ))}
              </div>
              <div>
                <h4>合并后（1 条，可编辑）</h4>
                {draft.title && <p><strong>{draft.title}</strong></p>}
                <textarea
                  rows={10}
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                />
                <p className="muted">类型：{draft.type}；关键词：{draft.keywords.join("、") || "无"}；{draft.reason}</p>
              </div>
            </div>
            <div className="maintenance-row">
              <button disabled={busy !== "" || !draftContent.trim()} onClick={() => startMerge([draft.group_id])}>
                {busy === "merge" ? "执行中" : "确认合并"}
              </button>
              <button disabled={busy !== ""} onClick={() => setDraft(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
      {batchView && (
        <div className="modal-backdrop">
          <div className="modal merge-compare">
            <div className="merge-compare-head">
              <div>
                <h3>合并结果对比</h3>
                <p className="muted">
                  {new Date(Number(batchView.created_at)).toLocaleString()} · 共 {batchView.groups} 组
                </p>
              </div>
              <span className={"batch-status " + batchView.status}>
                {batchView.status === "done" ? "已完成" : "已撤销"}
              </span>
            </div>
            {batchView.detail.length === 0 ? (
              <p className="muted">该批次没有可显示的合并明细。</p>
            ) : (
              batchView.detail.map((entry, index) => (
                <div className="compare-card" key={entry.group_id}>
                  <div className="compare-card-head">
                    <strong>第 {index + 1} 组</strong>
                    <span className="muted">
                      {entry.before?.length ?? 0} 条合并为 1 条
                      {entry.after?.type ? " · " + entry.after.type : ""}
                    </span>
                  </div>
                  <div className="compare-cols">
                    <div className="compare-col">
                      <h4 className="compare-col-title">合并前（{entry.before?.length ?? 0} 条）</h4>
                      {(entry.before ?? []).length === 0 ? (
                        <p className="muted">该批次未保存合并前快照。</p>
                      ) : (
                        (entry.before ?? []).map((m) => (
                          <div className="compare-item" key={m.id}>
                            <div className="compare-item-head">
                              <strong>{m.title || "未命名"}</strong>
                              <span className="tag">{m.type || "未分类"}</span>
                              <span className="muted">
                                {m.score > 0 ? "相似度 " + m.score.toFixed(3) : "旧批次无相似度"}
                              </span>
                            </div>
                            <p>{m.content}</p>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="compare-col">
                      <h4 className="compare-col-title">合并后（1 条）</h4>
                      <div className="compare-item compare-after">
                        {entry.after?.title && <strong>{entry.after.title}</strong>}
                        <p>{entry.after?.content || "该批次未保存合并后内容。"}</p>
                        {entry.after?.reason && (
                          <p className="muted compare-reason">合并原因：{entry.after.reason}</p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="compare-card-actions">
                    <button
                      className="link"
                      disabled={busy !== ""}
                      onClick={() => undo(batchView.id, [entry.group_id])}
                    >
                      撤销这一组
                    </button>
                  </div>
                </div>
              ))
            )}
            <div className="maintenance-row merge-compare-foot">
              <button disabled={busy !== ""} onClick={() => undo(batchView.id)}>撤销整批</button>
              <button disabled={busy !== ""} onClick={() => setBatchView(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
