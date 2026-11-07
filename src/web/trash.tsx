import { useState } from "react";
import {
  api,
  query,
  writeBody,
  dataChanged,
  type Account,
  type Page,
  type TrashItemSummary,
  type TrashItemDetail,
  type TrashCompat,
} from "./api";
import {
  Heading,
  State,
  Feedback,
  Modal,
  ConfirmDialog,
  LevelBadge,
  date,
  useAction,
  useResource,
} from "./ui";
export function Trash({ refresh }: { refresh: number }) {
  const [version, setVersion] = useState(0),
    [kind, setKind] = useState(""),
    [cursor, setCursor] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [target, setTarget] = useState(""),
    [detailId, setDetailId] = useState<string | null>(null),
    [compat, setCompat] = useState<TrashCompat | null>(null),
    [deleting, setDeleting] = useState<string[] | null>(null);
  const action = useAction();
  const items = useResource<Page<TrashItemSummary>>(
    "/trash" + query({ kind, cursor, limit: 50 }),
    `${refresh}:${version}`,
  );
  const accounts = useResource<Page<Account>>("/accounts", refresh);
  const detail = useResource<TrashItemDetail>(
    detailId ? "/trash/" + encodeURIComponent(detailId) : null,
    `${refresh}:${version}`,
  );
  const reload = () => {
    setSelected([]);
    setVersion((v) => v + 1);
    dataChanged();
  };
  async function check(ids: string[]) {
    if (!target) {
      action.setError("请先选择恢复到的目标账户。");
      return;
    }
    await action.run(
      async () =>
        setCompat(
          await api<TrashCompat>(
            "/trash/restore-compat",
            "POST",
            writeBody({ ids, target_subject_id: target }),
          ),
        ),
      "",
    );
  }
  return (
    <>
      <Heading
        eyebrow="RECYCLE BIN"
        title="回收站"
        description="删除的数据快照独立保存。恢复前选择目标账户并检查兼容性；永久删除无法撤销。"
      />
      <Feedback error={action.error || accounts.error} notice={action.notice} />
      <section className="panel padded">
        <div className="filters">
          <select
            aria-label="回收站类型"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setCursor("");
              setSelected([]);
            }}
          >
            <option value="">全部类型</option>
            <option value="memory">记忆</option>
            <option value="token">凭据</option>
          </select>
          <select
            aria-label="恢复目标账户"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setCompat(null);
            }}
          >
            <option value="">选择目标账户</option>
            {accounts.data?.items.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            disabled={action.busy || !selected.length || !target}
            onClick={() => void check(selected)}
          >
            批量恢复检查（{selected.length}）
          </button>
          <button
            className="danger-outline"
            disabled={!selected.length || action.busy}
            onClick={() => setDeleting([...selected])}
          >
            批量永久删除
          </button>
        </div>
        <State
          loading={items.loading}
          error={items.error}
          empty={!items.data?.items.length}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="选择本页所有已提交记录"
                      checked={
                        !!items.data?.items.length &&
                        items.data.items
                          .filter((i) => i.state === "committed")
                          .every((i) => selected.includes(i.id))
                      }
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? items
                                .data!.items.filter(
                                  (i) => i.state === "committed",
                                )
                                .map((i) => i.id)
                            : [],
                        )
                      }
                    />
                  </th>
                  <th>内容 / 来源账户</th>
                  <th>类型 / 删除时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.data?.items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={"选择 " + i.label}
                        disabled={i.state !== "committed"}
                        checked={selected.includes(i.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, i.id]
                              : selected.filter((id) => id !== i.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setDetailId(i.id)}
                      >
                        {i.label || i.target_id}
                      </button>
                      <small>{i.source_label || i.source_subject_id}</small>
                      {i.state === "pending" && (
                        <small>一致性确认中，暂不可操作</small>
                      )}
                    </td>
                    <td>
                      {i.kind === "memory" ? "记忆" : "已撤销凭据"}
                      <small>{date(i.deleted_at)}</small>
                    </td>
                    <td>
                      <div className="toolbar">
                        <button
                          disabled={
                            action.busy || !target || i.state !== "committed"
                          }
                          onClick={() => void check([i.id])}
                        >
                          恢复检查
                        </button>
                        <button
                          className="danger-outline"
                          disabled={i.state !== "committed"}
                          onClick={() => setDeleting([i.id])}
                        >
                          永久删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <span>共 {items.data?.total ?? "—"} 条</span>
            <button
              disabled={!cursor}
              onClick={() => {
                setCursor("");
                setSelected([]);
              }}
            >
              第一页
            </button>
            <button
              disabled={!items.data?.next_cursor}
              onClick={() => {
                setCursor(items.data?.next_cursor || "");
                setSelected([]);
              }}
            >
              下一页
            </button>
          </div>
        </State>
      </section>
      {detailId && (
        <Modal title="回收站详情" onClose={() => setDetailId(null)}>
          <State loading={detail.loading} error={detail.error}>
            {detail.data && (
              <>
                <p>
                  {detail.data.label} ·{" "}
                  {detail.data.kind === "memory" ? "记忆" : "凭据"}
                </p>
                <p>
                  来源：{detail.data.source_label} · 删除时间：
                  {date(detail.data.deleted_at)}
                </p>
                <pre>{JSON.stringify(detail.data.payload, null, 2)}</pre>
              </>
            )}
          </State>
        </Modal>
      )}
      {compat && (
        <ConfirmDialog
          title="确认恢复到目标账户"
          disabled={!compat.restorable || compat.summary.red > 0}
          onClose={() => setCompat(null)}
          onConfirm={async () => {
            const result = await api<{
              restored: string[];
              warnings: string[];
            }>(
              "/trash/restore",
              "POST",
              writeBody({
                ids: compat.items.map((i) => i.trash_id),
                target_subject_id: compat.target_subject_id,
                preview_token: compat.preview_token,
              }),
            );
            action.setError("");
            reload();
            if (result.warnings.length)
              alert("恢复完成，请注意：" + result.warnings.join("；"));
          }}
        >
          <p>
            目标账户：<strong>{compat.target_label}</strong>。兼容{" "}
            {compat.summary.green} 条，风险 {compat.summary.orange} 条，禁止{" "}
            {compat.summary.red} 条。
          </p>
          {compat.items.map((i) => (
            <section className="compat-item" key={i.trash_id}>
              <strong>{i.label}</strong> <LevelBadge level={i.level} />
              {i.summary && <p>{i.summary}</p>}
              <ul>
                {i.issues.map((issue, n) => (
                  <li key={n}>{issue.message}</li>
                ))}
              </ul>
            </section>
          ))}
          {compat.summary.orange > 0 && (
            <div className="notice warning">
              橙色项目可能有信息缺失或已过期。确认恢复表示你已了解上方风险。
            </div>
          )}
          {compat.summary.red > 0 && (
            <div className="notice error">
              存在红色项目，不能执行恢复。请关闭并调整选择；凭据密钥不可逆，请重新签发。
            </div>
          )}
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          title="永久删除回收站快照"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const result = await api<{ deleted: number; missing: string[] }>(
              "/trash/delete",
              "POST",
              writeBody({ ids: deleting }),
            );
            reload();
            if (result.missing.length)
              action.setError(
                result.missing.length + " 条记录已不存在，其余已删除。",
              );
          }}
        >
          <div className="notice warning">
            将永久删除 {deleting.length}{" "}
            条回收站快照，无法恢复。此操作不会删除其他账户中的已恢复记忆。
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}
