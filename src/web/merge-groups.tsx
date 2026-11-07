import { useCallback, useEffect, useState } from "react";
import {
  api,
  writeBody,
  type MaintenanceJob,
  type MergeDraft,
  type SimilarityGroup,
} from "./api";

const RISK_LABEL: Record<string, string> = {
  LOW_SCORE: "低分",
  NUMBER_CONFLICT: "数字冲突",
  TYPE_MIXED: "类型混杂",
  PROTECTED: "受保护类型",
};

/** 记忆整理页：相似分组 → 人工勾选 → 模型压缩去重合并（全后台任务 + 轮询）。 */
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

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ items: SimilarityGroup[]; total: number }>(
        "/maintenance/groups?subject_id=" + encodeURIComponent(subject) + "&limit=100",
      );
      setGroups(data.items);
      setTotal(data.total);
      setSelected((prev) => new Set([...prev].filter((id) => data.items.some((g) => g.id === id))));
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
            const merged = Number((next.result as { merged?: number }).merged ?? 0);
            setNotice("任务完成：合并 " + merged + " 组。");
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [job, load, onChanged]);

  const rebuild = async () => {
    setBusy("rebuild");
    setError("");
    try {
      const created = await api<MaintenanceJob>(
        "/maintenance/groups/rebuild",
        "POST",
        writeBody({ subject_id: subject }),
      );
      setJob(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "建组失败");
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
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "合并任务创建失败");
    } finally {
      setBusy("");
    }
  };

  const undo = async (batchId: string) => {
    if (!window.confirm("确认撤销本次合并？来源记忆会恢复为可用状态。")) return;
    setBusy("undo");
    try {
      const result = await api<{ restored: number; skipped: string[] }>(
        "/maintenance/merge/undo",
        "POST",
        writeBody({ subject_id: subject, batch_id: batchId }),
      );
      setNotice("已撤销，恢复 " + result.restored + " 条记忆。");
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
  const batchId = job ? (job.result as { batch_id?: string }).batch_id : undefined;
  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <section className="panel padded">
      <h2>相似分组与压缩去重</h2>
      <p className="muted">
        先用通用模型判断相似关系并分组，你勾选后由模型压缩成一条，旧记忆归档（可在 7 天内撤销）。检索方式不变。
      </p>
      <div className="maintenance-row">
        <button disabled={!!running || busy !== ""} onClick={rebuild}>
          {busy === "rebuild" ? "创建任务…" : "重建分组"}
        </button>
        <button
          disabled={!!running || busy !== "" || selected.size === 0}
          onClick={() => startMerge([...selected])}
        >
          合并已选（{selected.size} 组）
        </button>
        {groups.length > 0 && (
          <button
            disabled={!!running || busy !== ""}
            onClick={() => setSelected(new Set(groups.filter((g) => !g.risk).slice(0, 20).map((g) => g.id)))}
          >
            选中高置信组
          </button>
        )}
        {running && <span className="muted">任务进行中：{job!.done}/{job!.total}（{pct}%）</span>}
      </div>
      {running && (
        <div className="merge-progress"><span style={{ width: pct + "%" }} /></div>
      )}
      {job && job.status === "done" && batchId && (
        <div className="notice">
          <strong>合并任务完成</strong>
          <p>
            合并 {String((job.result as { merged?: number }).merged ?? 0)} 组。
            <button className="link" disabled={busy !== ""} onClick={() => undo(batchId)}>
              撤销本次合并
            </button>
          </p>
        </div>
      )}
      {job && job.status === "failed" && (
        <div className="notice warning">任务失败：{job.error || "未知错误"}</div>
      )}
      {error && <div className="notice warning">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      <div className="muted">共 {total} 个分组</div>
      {loading ? (
        <p className="muted">加载中…</p>
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
                    {group.member_count} 条 · 最低分 {group.min_score.toFixed(3)} · {group.status}
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
            <h3>合并预览</h3>
            <p className="muted">确认后会用下面这条记忆替换并归档组内 {groups.find((g) => g.id === draft.group_id)?.member_count ?? ""} 条记忆。</p>
            {draft.title && <p><strong>{draft.title}</strong></p>}
            <textarea
              rows={8}
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
            />
            <p className="muted">类型：{draft.type}；关键词：{draft.keywords.join("、") || "无"}；{draft.reason}</p>
            <div className="maintenance-row">
              <button disabled={busy !== "" || !draftContent.trim()} onClick={() => startMerge([draft.group_id])}>
                {busy === "merge" ? "执行中…" : "确认合并"}
              </button>
              <button disabled={busy !== ""} onClick={() => setDraft(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
