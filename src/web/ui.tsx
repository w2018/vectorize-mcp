import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorText, type Preview } from "./api";
export function useResource<T>(path: string | null, refresh = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setData(null);
    setError("");
    if (!path) return;
    const abort = new AbortController();
    setLoading(true);
    api<T>(path, "GET", undefined, abort.signal)
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [path, refresh]);
  return { data, error, loading };
}
export function State({
  loading,
  error,
  empty = false,
  children,
}: {
  loading: boolean;
  error: string;
  empty?: boolean;
  children: ReactNode;
}) {
  if (loading)
    return (
      <div className="empty" role="status">
        <span className="spinner" />
        正在读取…
      </div>
    );
  if (error)
    return (
      <div className="notice error" role="alert">
        {error}
      </div>
    );
  if (empty)
    return (
      <div className="empty">
        <span className="empty-icon">◇</span>
        <strong>这里还没有内容</strong>
        <p>创建第一条记录，或调整上方筛选条件。</p>
      </div>
    );
  return <>{children}</>;
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function PreviewDialog({
  title,
  preview,
  busy,
  onClose,
  onConfirm,
  error,
}: {
  title: string;
  preview: Preview;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
  error?: string;
}) {
  const details = Object.fromEntries(
    Object.entries(preview).filter(([key]) => key !== "preview_token"),
  );
  const [cancelled, setCancelled] = useState(false);
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) setCancelled(true);
      }}
    >
      {cancelled ? (
        <div className="notice" role="status">
          操作已取消，未执行任何更改。
        </div>
      ) : (
        <>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          <p>请核对本次操作的影响。预览过期或数据发生变化时，需要重新预览。</p>
          <pre className="preview">{JSON.stringify(details, null, 2)}</pre>
        </>
      )}
      <footer>
        {cancelled ? (
          <button className="primary" onClick={onClose}>
            关闭
          </button>
        ) : (
          <>
            <button disabled={busy} onClick={() => setCancelled(true)}>
              取消
            </button>
            <button className="danger" disabled={busy} onClick={onConfirm}>
              {busy ? "正在执行…" : "确认执行"}
            </button>
          </>
        )}
      </footer>
    </Modal>
  );
}
export function LevelBadge({ level }: { level: "green" | "orange" | "red" }) {
  return (
    <span className={"level-badge level-" + level}>
      {
        {
          green: "兼容 · 可恢复",
          orange: "注意 · 有风险",
          red: "不兼容 · 禁止恢复",
        }[level]
      }
    </span>
  );
}
export function ConfirmDialog({
  title,
  children,
  onConfirm,
  onClose,
  disabled = false,
  confirmLabel = "确认执行",
}: {
  title: string;
  children?: ReactNode;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
  disabled?: boolean;
  confirmLabel?: string;
}) {
  const [state, setState] = useState<
    "confirm" | "busy" | "success" | "error" | "cancelled"
  >("confirm");
  const [error, setError] = useState("");
  const lock = useRef(false);
  function cancel() {
    if (!lock.current) setState("cancelled");
  }
  async function execute() {
    if (lock.current) return;
    lock.current = true;
    setState("busy");
    setError("");
    try {
      await onConfirm();
      setState("success");
    } catch (e) {
      setError(errorText(e));
      setState("error");
    } finally {
      lock.current = false;
    }
  }
  return (
    <Modal
      title={title}
      onClose={() => {
        if (lock.current) return;
        if (state === "success") onClose();
        else cancel();
      }}
    >
      <div data-confirm-state={state}>
        {state === "success" ? (
          <div className="notice success" role="status">
            操作已成功完成。
          </div>
        ) : state === "cancelled" ? (
          <div className="notice" role="status">
            操作已取消，未执行任何更改。
          </div>
        ) : (
          <>
            {children}
            {state === "error" && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            {state === "busy" && <p role="status">正在确认并执行，请稍候…</p>}
          </>
        )}
        <footer>
          {state === "success" ? (
            <button className="primary" onClick={onClose}>
              完成
            </button>
          ) : state === "cancelled" ? (
            <button className="primary" onClick={onClose}>
              关闭
            </button>
          ) : (
            <>
              <button disabled={state === "busy"} onClick={cancel}>
                取消
              </button>
              <button
                className="danger"
                disabled={disabled || state === "busy"}
                onClick={() => void execute()}
              >
                {state === "busy"
                  ? "确认中…"
                  : state === "error"
                    ? "重试"
                    : confirmLabel}
              </button>
            </>
          )}
        </footer>
      </div>
    </Modal>
  );
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run(action: () => Promise<void>, success = "操作已完成") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, run, setError };
}
export function Feedback({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}
    </>
  );
}
export function date(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}
import { MEMORY_CATALOG } from "../core/catalog";
import type { MemoryType } from "../core/types";
export const types = Object.fromEntries(
  MEMORY_CATALOG.map((item) => [item.key, item.label]),
) as Record<MemoryType, string>;
export function Heading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}
