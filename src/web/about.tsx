import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  writeBody,
  type UpdateCheck,
  type UpdateJob,
} from "./api";
import { ConfirmDialog, Heading } from "./ui";

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return value.toFixed(index === 0 ? 0 : 1) + " " + units[index];
}

async function pollJob(
  id: string,
  onUpdate: (job: UpdateJob) => void,
): Promise<UpdateJob> {
  for (let i = 0; i < 1200; i++) {
    const job = await api<UpdateJob>("/update/jobs/" + id, "GET");
    onUpdate(job);
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error("任务超时未完成");
}

type Pending = {
  title: string;
  confirmLabel: string;
  code: string;
  run: (code: string) => Promise<void>;
};

export function About() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checkError, setCheckError] = useState("");
  const [checking, setChecking] = useState(false);
  const [job, setJob] = useState<UpdateJob | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setCheckError("");
    try {
      setCheck(await api<UpdateCheck>("/update/check", "GET"));
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [runCheck]);

  async function requestCode(action: string): Promise<string> {
    const result = await api<{ action: string; code: string; expires_at: number }>(
      "/update/confirm",
      "POST",
      writeBody({ action }),
    );
    return result.code;
  }

  async function prepare(
    action: string,
    title: string,
    confirmLabel: string,
    run: (code: string) => Promise<void>,
  ) {
    setError("");
    setNotice("");
    try {
      const code = await requestCode(action);
      setPending({ title, confirmLabel, code, run });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function startDownload() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const started = await api<{ job_id: string; version: string }>(
        "/update/download",
        "POST",
        writeBody({}),
      );
      const done = await pollJob(started.job_id, setJob);
      if (done.status === "done") setNotice("下载完成，可以覆盖程序文件。");
      else setError(done.error || "下载失败");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startJob(
    path: string,
    body: Record<string, unknown>,
    doneText: string,
    failText: string,
  ) {
    setError("");
    setNotice("");
    setBusy(true);
    setJob(null);
    try {
      const started = await api<{ job_id: string }>(path, "POST", writeBody(body));
      const done = await pollJob(started.job_id, setJob);
      if (done.status === "done") setNotice(doneText);
      else setError(done.error || failText);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const latest = check?.latest ?? null;
  const progress =
    job?.result && job.result.total
      ? Math.min(
          100,
          Math.floor(((job.result.received ?? 0) / job.result.total) * 100),
        )
      : null;

  return (
    <>
      <Heading
        eyebrow="ABOUT VECTORIZE"
        title="关于"
        description="让值得记住的信息保持清晰、可核对、由你掌握。"
      />
      <section className="panel padded">
        <div className="brandmark">✧</div>
        <h2>Vectorize MCP</h2>
        <dl className="details">
          <dt>作者</dt>
          <dd>w2018</dd>
          <dt>版本</dt>
          <dd>{check?.current ?? "0.3.4"}</dd>
          <dt>开源协议</dt>
          <dd>MIT</dd>
          <dt>开源地址</dt>
          <dd>
            <a
              href="https://github.com/w2018/vectorize-mcp"
              target="_blank"
              rel="noopener noreferrer"
            >
              github.com/w2018/vectorize-mcp ↗
            </a>
          </dd>
        </dl>
        <p>一个支持多账户隔离、语义检索与人工管理的长期记忆服务。</p>
      </section>

      <section className="panel padded">
        <h2>版本与更新</h2>
        <p className="hint">
          从 GitHub 检测最新版本，一键下载源码并覆盖程序文件（不会改动数据库与 data 目录），然后由你手动重新编译、启动。
        </p>
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
        {checkError && (
          <div className="notice warning">检测失败：{checkError}</div>
        )}
        <div className="notice">
          当前版本 <strong>{check?.current ?? "…"}</strong>
          {latest ? (
            <>
              ，最新版本 <strong>{latest.version}</strong>
              {latest.published_at
                ? "（发布于 " + latest.published_at.slice(0, 10) + "）"
                : ""}
              {check?.has_update ? "，有新版本可更新。" : "，已是最新。"}
            </>
          ) : check?.error ? (
            "，暂时无法获取最新版本。"
          ) : (
            ""
          )}
        </div>
        {latest && check?.has_update && (
          <details>
            <summary>查看更新说明</summary>
            <pre>{latest.notes || "（无说明）"}</pre>
          </details>
        )}
        <footer>
          <button disabled={checking} onClick={() => void runCheck()}>
            {checking ? "检测中…" : "重新检测"}
          </button>
          {check?.has_update && (
            <button className="primary" disabled={busy} onClick={() => void startDownload()}>
              {busy ? "下载中…" : "下载最新源码"}
            </button>
          )}
        </footer>
        {progress !== null && (
          <div className="notice">
            <p>
              下载进度 {progress}%（{formatBytes(job?.result?.received)} /{" "}
              {formatBytes(job?.result?.total)}）
            </p>
            <progress max={100} value={progress} style={{ width: "100%" }} />
          </div>
        )}
        {job && (
          <details open>
            <summary>操作日志</summary>
            <pre>
              {job.logs
                .map((entry) => entry.text)
                .join("\n")}
            </pre>
          </details>
        )}
        <footer>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void prepare(
                "apply",
                "覆盖程序文件",
                "确认覆盖",
                async (code) => {
                  if (!latest) throw new Error("缺少最新版本信息");
                  setBusy(true);
                  try {
                    const result = await api<{
                      installed_version: string;
                      files: number;
                    }>("/update/apply", "POST", writeBody({ code, version: latest.version }));
                    setNotice(
                      "已覆盖为 v" +
                        result.installed_version +
                        "（" +
                        result.files +
                        " 个文件），请在下方重新编译并启动。",
                    );
                  } finally {
                    setBusy(false);
                  }
                },
              )
            }
          >
            覆盖程序文件（先备份）
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void prepare("build", "重新编译", "确认编译", async (code) => {
                await startJob("/update/build", { code }, "编译完成，可以启动服务。", "编译失败");
              })
            }
          >
            重新编译
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void prepare("start", "启动服务", "确认启动", async (code) => {
                setBusy(true);
                try {
                  await api("/update/start", "POST", writeBody({ code }));
                  setNotice("已发起启动（npm start）。");
                } finally {
                  setBusy(false);
                }
              })
            }
          >
            启动服务
          </button>
          <button
            className="danger-outline"
            disabled={busy}
            onClick={() =>
              void prepare("stop", "停止服务", "确认停止", async (code) => {
                await api("/update/stop", "POST", writeBody({ code }));
                setNotice("服务正在停止，网页将断开，请在服务器上用 npm start 重新启动。");
              })
            }
          >
            停止服务
          </button>
        </footer>
      </section>

      {pending && (
        <ConfirmDialog
          title={pending.title}
          confirmLabel={pending.confirmLabel}
          verificationCode={pending.code}
          disabled={busy}
          onClose={() => setPending(null)}
          onConfirm={async (code) => {
            await pending.run(code || "");
            setPending(null);
          }}
        >
          <p>此操作会执行服务器上的固定命令或覆盖程序文件，请核对后输入验证码确认。</p>
        </ConfirmDialog>
      )}
    </>
  );
}
