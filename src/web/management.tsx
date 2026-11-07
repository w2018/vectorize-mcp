import { useEffect, useRef, useState } from "react";
import {
  api,
  download,
  query,
  writeBody,
  type Account,
  type Audit,
  type Backup,
  type CloudFile,
  type CloudJob,
  type Config,
  type EncoderPresetsResponse,
  type EncoderTestResult,
  type EncoderModelsResult,
  type EncoderKeyStatus,
  type BotPreset,
  type Page,
  type Preview,
  type Token,
  type WebdavStatus,
} from "./api";
import {
  date,
  Feedback,
  Heading,
  Modal,
  PreviewDialog,
  ConfirmDialog,
  State,
  useAction,
  useResource,
} from "./ui";
import { MEMORY_RULES } from "../core/memory-rules";
type IssuedCredential = {
  id: string;
  label: string;
  subject_id: string;
  token: string;
  created_at: number;
};
type McpFormat = "opencode" | "claude" | "http";
function mcpJson(format: McpFormat, token: string): string {
  const url = window.location.origin + "/mcp";
  const authorization = "Bearer " + token;
  if (format === "opencode")
    return JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          vectorize: {
            type: "remote",
            url,
            enabled: true,
            headers: { Authorization: authorization },
          },
        },
      },
      null,
      2,
    );
  if (format === "claude")
    return JSON.stringify(
      {
        mcpServers: {
          vectorize: {
            type: "http",
            url,
            headers: { Authorization: authorization },
          },
        },
      },
      null,
      2,
    );
  return JSON.stringify(
    {
      mcp: {
        vectorize: {
          type: "remote",
          url,
          headers: { Authorization: authorization },
        },
      },
    },
    null,
    2,
  );
}
// 文案唯一真源在 src/core/memory-rules.ts（与仓库根 AGENTS.md 逐字一致）。
type Pending = {
  title: string;
  value: Preview;
  path: string;
  method?: string;
  body: Record<string, unknown>;
  capture?: boolean;
  label?: string;
  /** Endpoint that can issue a fresh preview_token after one has been consumed. */
  previewPath?: string;
};
export function Accounts({
  refresh,
  onChange,
}: {
  refresh: number;
  onChange: () => void;
}) {
  const tokens = useResource<Page<Token>>("/tokens", refresh);
  const accounts = useResource<Page<Account>>("/accounts", refresh);
  const action = useAction();
  const [label, setLabel] = useState("");
  const [bot, setBot] = useState(false);
  const [presetId, setPresetId] = useState("gentle");
  const presets = useResource<Page<BotPreset>>("/qqbot/presets", 0);
  const [issued, setIssued] = useState<IssuedCredential[]>([]);
  const [issueWarning, setIssueWarning] = useState("");
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessTokenId, setAccessTokenId] = useState<string | null>(null);
  const [accessFormat, setAccessFormat] = useState<McpFormat>("opencode");
  const [pending, setPending] = useState<Pending | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  /** D-18: after a failed confirm the preview_token is consumed; re-issue it
   *  rather than replaying an expired one on "retry". */
  function regeneratePending() {
    if (!pending?.previewPath) return;
    void action.run(async () => {
      const value = await api<Preview>(
        pending.previewPath!,
        "POST",
        writeBody({}),
      );
      setPending((current) => (current ? { ...current, value } : current));
    }, "");
  }
  const accessRef = useRef<HTMLDetailsElement | null>(null);
  type TokenResponse = {
    id?: string;
    label?: string;
    subject_id?: string;
    token?: string;
    secret?: string;
    secret_available?: boolean;
  };
  function rememberIssued(result: TokenResponse, fallback: string) {
    const token = result.token || result.secret;
    // D-18: the credential was already created successfully. A missing plaintext
    // is a display problem, not a failed operation — never throw here, or the
    // ConfirmDialog would offer a retry that replays a consumed preview_token.
    if (!token) {
      setIssueWarning("凭据已创建，但服务端未返回明文；请撤销该凭据后重新创建。");
      setAccessOpen(true);
      return;
    }
    setIssueWarning("");
    const record: IssuedCredential = {
      id: result.id ?? token.slice(0, 12),
      label: result.label ?? fallback,
      subject_id: result.subject_id ?? "",
      token,
      created_at: Date.now(),
    };
    setIssued((list) => [
      record,
      ...list.filter((item) => item.id !== record.id),
    ]);
    setAccessTokenId(record.id);
    setAccessOpen(true);
    return record;
  }
  async function create(body: Record<string, unknown>) {
    const result = await api<TokenResponse>("/tokens", "POST", writeBody(body));
    onChange();
    setLabel("");
    rememberIssued(result, String(body.label ?? "新凭据"));
  }
  const activeTokens = (tokens.data?.items ?? []).filter(
    (item) => item.status === "active",
  );
  const selectedToken =
    activeTokens.find((item) => item.id === accessTokenId) ?? activeTokens[0];
  const selectedIssued = selectedToken
    ? issued.find((item) => item.id === selectedToken.id)
    : undefined;
  function openAccess(tokenId: string) {
    setAccessTokenId(tokenId);
    setAccessOpen(true);
    requestAnimationFrame(() =>
      accessRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      }),
    );
  }
  async function reveal(token: Token) {
    await action.run(async () => {
      const result = await api<TokenResponse>(
        "/tokens/" + token.id + "/reveal",
        "POST",
        writeBody({}),
      );
      rememberIssued(
        {
          ...result,
          label: token.label,
          subject_id: token.subject_id,
        },
        token.label,
      );
    }, "已加载凭据，可在下方查看与复制");
  }
  function requestRotate(token: Token) {
    return action.run(async () => {
      const value = await api<Preview>(
        "/tokens/" + token.id + "/rotate-preview",
        "POST",
        writeBody({}),
      );
      setPending({
        title: "重新签发访问凭据",
        value,
        path: "/tokens/" + token.id + "/rotate",
        previewPath: "/tokens/" + token.id + "/rotate-preview",
        body: {},
        capture: true,
        label: token.label,
      });
    }, "");
  }
  return (
    <>
      <Heading
        eyebrow="ACCESS"
        title="账户与访问凭据"
        description="一枚有效 Token 对应一个独立账户。创建后可在「接入方式」折叠块中一键复制 MCP 配置，并切换不同凭据。"
      />
      <Feedback error={action.error || accounts.error} notice={action.notice} />
      <section className="panel padded">
        <h2>创建新账户</h2>
        <p>
          创建后会展开「接入方式」折叠块，可直接复制可粘贴的 MCP
          配置；凭据明文会安全保存，可随时在列表中查看与复制。
        </p>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(
              () =>
                create({
                  label,
                  kind: bot ? "qqbot" : "standard",
                  preset_id: bot ? presetId : undefined,
                }),
              "",
            );
          }}
        >
          <label>
            账户 / 凭据名称
            <input
              required
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如：我的工作助手"
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={bot}
              onChange={(e) => setBot(e.target.checked)}
            />
            供 QQBOT 使用
          </label>
          {bot && (
            <label>
              初始预设
              <select
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
              >
                {(presets.data?.items ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="primary" disabled={action.busy}>
            创建凭据
          </button>
        </form>
        {bot && (
          <small>
            QQBOT 账户额外拥有「人物 / 概念 / 人设」记忆类型与自定义关系，可在
            QQBOT 人设页调整配置。
          </small>
        )}
      </section>
      <section className="panel padded">
        <h2>访问凭据</h2>
        <State
          loading={tokens.loading}
          error={tokens.error}
          empty={!tokens.data?.items.length}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>状态</th>
                  <th>创建 / 最近使用</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {tokens.data?.items.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.label}</strong>
                      {accounts.data?.items.find((a) => a.id === t.subject_id)
                        ?.kind === "qqbot" && (
                        <span className="tag">QQBOT</span>
                      )}
                      <small>{t.id}</small>
                    </td>
                    <td>{t.status === "active" ? "有效" : "已撤销"}</td>
                    <td>
                      {date(t.created_at)}
                      <small>{date(t.last_used_at)}</small>
                    </td>
                    <td>
                      {t.status === "active" && (
                        <>
                        <button
                          disabled={action.busy || !t.viewable}
                          title={
                            t.viewable
                              ? "查看并复制凭据明文"
                              : "该凭据由旧版本创建，重新签发后即可随时查看"
                          }
                          onClick={() => void reveal(t)}
                        >
                          查看
                        </button>{" "}
                        <button
                          disabled={action.busy}
                          onClick={() => openAccess(t.id)}
                          title={
                            issued.some((item) => item.id === t.id)
                              ? "查看并复制可粘贴的 MCP 配置"
                              : "选择该凭据；如需复制配置可重新签发"
                          }
                        >
                          接入…
                        </button>
                        </>
                      )}{" "}
                      <button
                        className="danger-outline"
                        disabled={action.busy || t.status !== "active"}
                        onClick={() =>
                          void action.run(async () => {
                            const value = await api<Preview>(
                              "/tokens/" + t.id + "/revoke-preview",
                              "POST",
                              writeBody({}),
                            );
                            setPending({
                              title: "撤销访问凭据",
                              value,
                              path: "/tokens/" + t.id + "/revoke",
                              previewPath: "/tokens/" + t.id + "/revoke-preview",
                              body: {},
                            });
                          }, "")
                        }
                      >
                        撤销…
                      </button>
                      {t.status === "revoked" && (
                        <button
                          className="danger-outline"
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              const value = await api<Preview>(
                                "/tokens/" + t.id + "/delete-preview",
                                "POST",
                                writeBody({}),
                              );
                              setPending({
                                title: "删除已撤销凭据到回收站",
                                value,
                                path: "/tokens/" + t.id + "/delete",
                              previewPath: "/tokens/" + t.id + "/delete-preview",
                                body: {},
                              });
                            }, "")
                          }
                        >
                          删除…
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </State>
        <details
          ref={accessRef}
          className="access-block"
          open={accessOpen}
          onToggle={(e) => setAccessOpen(e.currentTarget.open)}
        >
          <summary>
            接入方式 <span>（示例配置，可一键复制）</span>
          </summary>
          <div className="access-body">
            {issueWarning && <div className="notice warning">{issueWarning}</div>}
            {!activeTokens.length ? (
              <p>暂无可用的有效凭据，请先在下方创建或重新启用。</p>
            ) : (
              <>
                <div className="access-controls">
                  <label>
                    选择凭据
                    <select
                      value={selectedToken!.id}
                      onChange={(e) => setAccessTokenId(e.target.value)}
                    >
                      {activeTokens.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}（{item.id.slice(0, 8)}）
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    接入方式
                    <select
                      value={accessFormat}
                      onChange={(e) =>
                        setAccessFormat(e.target.value as McpFormat)
                      }
                    >
                      <option value="opencode">opencode（远程 HTTP）</option>
                      <option value="claude">Claude / 通用 mcpServers</option>
                      <option value="http">通用远程 MCP</option>
                    </select>
                  </label>
                </div>
                {selectedIssued ? (
                  <>
                    <label>
                      可直接粘贴的配置
                      <textarea
                        readOnly
                        rows={10}
                        value={mcpJson(accessFormat, selectedIssued.token)}
                        spellCheck={false}
                      />
                    </label>
                    <div className="access-actions">
                      <button
                        className="primary"
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(async () => {
                            await navigator.clipboard.writeText(
                              mcpJson(accessFormat, selectedIssued.token),
                            );
                          }, "已复制 MCP 配置")
                        }
                      >
                        复制 JSON
                      </button>
                      <button
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(async () => {
                            await navigator.clipboard.writeText(
                              selectedIssued.token,
                            );
                          }, "已复制凭据")
                        }
                      >
                        复制 Token
                      </button>
                      <span className="access-hint">
                        凭据明文已安全保存，可随时在列表点击「查看」再次复制。
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="notice warning">
                    该凭据由旧版本创建，未保存可查看的明文。重新签发会立即废弃旧
                    Token，并生成可随时查看与复制的新凭据；账户记忆与计数保持不变。
                    <div className="access-actions">
                      <button
                        disabled={action.busy}
                        onClick={() => void requestRotate(selectedToken!)}
                      >
                        重新签发并生成配置
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="access-agents">
              <h3>让 Agent 自动使用（AGENTS.md）</h3>
              <p>
                把下面文案追加到项目根目录的 <code>AGENTS.md</code>，或 DSH
                的全局自定义指令；保存后新会话生效。
              </p>
              <label>
                AGENTS.md 文案
                <textarea
                  readOnly
                  rows={10}
                  value={MEMORY_RULES}
                  spellCheck={false}
                />
              </label>
              <div className="access-actions">
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await navigator.clipboard.writeText(MEMORY_RULES);
                    }, "已复制 AGENTS.md 文案")
                  }
                >
                  复制 AGENTS.md 文案
                </button>
                <span className="access-hint">
                  触发机制写在 AGENTS.md 中，Token 与 MCP 配置分开填写。
                </span>
              </div>
            </div>
          </div>
        </details>
      </section>
      <section className="panel padded">
        <h2>未绑定凭据的账户</h2>
        <p>
          撤销凭据不会删除记忆。为原账户重新签发凭据后，内容和次数保持不变，旧凭据仍然无效。
        </p>
        <State
          loading={accounts.loading || tokens.loading}
          error={accounts.error || tokens.error}
          empty={
            !accounts.data?.items.filter(
              (a) =>
                !tokens.data?.items.some(
                  (t) => t.subject_id === a.id && t.status === "active",
                ),
            ).length
          }
        >
          {accounts.data?.items
            .filter(
              (a) =>
                !tokens.data?.items.some(
                  (t) => t.subject_id === a.id && t.status === "active",
                ),
            )
            .map((a) => (
              <div className="list-row" key={a.id}>
                <div>
                  <strong>{a.name}</strong>
                  <small>{a.id}</small>
                </div>
                <div className="row-actions">
                  <button
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        const value = await api<Preview>(
                          "/accounts/" + a.id + "/enable-preview",
                          "POST",
                          writeBody({}),
                        );
                        setPending({
                          title: "重新启用原账户",
                          value,
                          path: "/tokens",
                          previewPath: "/accounts/" + a.id + "/enable-preview",
                          body: { subject_id: a.id, label: a.name },
                        });
                      }, "")
                    }
                  >
                    重新启用…
                  </button>
                  <button
                    className="danger-outline"
                    disabled={action.busy}
                    onClick={() => setDeleting(a)}
                  >
                    彻底删除…
                  </button>
                </div>
              </div>
            ))}
        </State>
      </section>
      {pending && (
        <ConfirmDialog
          title={pending.title}
          onClose={() => setPending(null)}
          onRetry={pending.previewPath ? regeneratePending : undefined}
          onConfirm={async () => {
            const result = await api<TokenResponse>(
              pending.path,
              "POST",
              writeBody({
                ...pending.body,
                preview_token: pending.value.preview_token,
              }),
            );
            onChange();
            if (pending.capture)
              rememberIssued(result, pending.label ?? "凭据");
            else if (pending.path === "/tokens")
              rememberIssued(result, String(pending.body.label ?? "新凭据"));
          }}
        >
          <p>
            删除仅适用于已撤销的凭据；快照移入回收站后无法恢复密钥，需要重新签发。
          </p>
          <pre>
            {JSON.stringify(
              Object.fromEntries(
                Object.entries(pending.value).filter(
                  ([k]) => k !== "preview_token",
                ),
              ),
              null,
              2,
            )}
          </pre>
        </ConfirmDialog>
      )}
      {deleting && (
        <DeleteAccountDialog
          account={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={onChange}
        />
      )}
    </>
  );
}
function DeleteAccountDialog({
  account,
  onClose,
  onDeleted,
}: {
  account: Account;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [stage, setStage] = useState<"loading" | "ready" | "error" | "done">(
    "loading",
  );
  const [code, setCode] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errorText = (e: unknown) =>
    e instanceof Error ? e.message : String(e);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await api<{ code: string; expires_at: number }>(
          "/accounts/" + account.id + "/delete-preview",
          "POST",
          writeBody({}),
        );
        if (!alive) return;
        setCode(result.code);
        setStage("ready");
      } catch (e) {
        if (!alive) return;
        setError(errorText(e));
        setStage("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [account.id]);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api(
        "/accounts/" + account.id + "/delete",
        "POST",
        writeBody({ code: input }),
      );
      setStage("done");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="彻底删除账户" onClose={onClose} locked>
      {stage === "loading" && <p>正在生成验证码…</p>}
      {stage === "error" && (
        <>
          <div className="notice error" role="alert">
            {error}
          </div>
          <div className="form-actions">
            <button onClick={onClose}>关闭</button>
          </div>
        </>
      )}
      {stage === "done" ? (
        <>
          <div className="notice success" role="status">
            账户及其全部数据已彻底删除。
          </div>
          <div className="form-actions">
            <button
              className="primary"
              onClick={() => {
                onDeleted();
                onClose();
              }}
            >
              完成
            </button>
          </div>
        </>
      ) : (
        stage === "ready" && (
          <>
            <p>
              将永久删除账户「{account.name}」及其名下全部记忆、关联与凭据，
              <strong>不可恢复</strong>。
            </p>
            <label>
              本次验证码（5 分钟内有效）
              <code
                aria-label="删除验证码"
                style={{
                  display: "inline-block",
                  padding: "6px 14px",
                  fontSize: 22,
                  letterSpacing: 6,
                  fontWeight: 700,
                  alignSelf: "flex-start",
                }}
              >
                {code}
              </code>
            </label>
            <label>
              输入验证码
              <input
                inputMode="numeric"
                maxLength={6}
                value={input}
                autoFocus
                placeholder="输入上方 6 位数字"
                onChange={(e) =>
                  setInput(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
              />
            </label>
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <div className="form-actions">
              <button onClick={onClose} disabled={busy}>
                取消
              </button>
              <button
                className="danger"
                disabled={busy || input.length !== 6}
                onClick={() => void submit()}
              >
                确认彻底删除
              </button>
            </div>
          </>
        )
      )}
    </Modal>
  );
}
export function Transfer({ subject }: { subject: string }) {
  const action = useAction();
  const [includePrivate, setIncludePrivate] = useState(false);
  const [bundle, setBundle] = useState<unknown>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  return (
    <>
      <div className="section-head">
        <h2>账户数据导入导出</h2>
        <p>用版本化 JSON 迁移当前账户；导入先预检，不直接覆盖。</p>
      </div>
      <Feedback error={action.error} notice={action.notice} />
      <div className="two-columns">
        <section className="panel padded">
          <h2>导出当前账户</h2>
          <p>
            导出正文、关系和统计。访问凭据与管理员登录信息不会包含在文件中。
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={includePrivate}
              onChange={(e) => setIncludePrivate(e.target.checked)}
            />
            包含私密记忆
          </label>
          <button
            className="primary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const data = await api(
                  "/exports",
                  "POST",
                  writeBody({
                    subject_id: subject,
                    include_private: includePrivate,
                  }),
                );
                download(
                  "vectorize-export-" +
                    new Date().toISOString().slice(0, 10) +
                    ".json",
                  data,
                );
              }, "导出文件已生成")
            }
          >
            下载 JSON
          </button>
        </section>
        <section className="panel padded">
          <h2>导入到当前账户</h2>
          <p>默认追加并跳过冲突。检查结果会列出可导入项与冲突，不自动合并。</p>
          <label className="file-input">
            选择 JSON 文件
            <input
              type="file"
              accept=".json,application/json"
              disabled={action.busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                setBundle(null);
                setPreview(null);
                setFileName("");
                if (!file) return;
                void action.run(async () => {
                  if (file.size > 100 * 1024 * 1024)
                    throw new Error("文件超过 100 MiB，请分批导入。");
                  const parsed: unknown = JSON.parse(await file.text());
                  setBundle(parsed);
                  setFileName(file.name);
                }, "文件已读取，请预检");
              }}
            />
          </label>
          {fileName && <p>{fileName}</p>}
          <button
            disabled={action.busy || !bundle}
            onClick={() =>
              void action.run(async () => {
                setPreview(
                  await api<Preview>(
                    "/imports/preview",
                    "POST",
                    writeBody({ subject_id: subject, bundle }),
                  ),
                );
              }, "")
            }
          >
            检查导入内容…
          </button>
        </section>
      </div>
      {preview && (
        <PreviewDialog
          title="确认导入到当前账户"
          preview={preview}
          busy={action.busy}
          error={action.error}
          onClose={() => setPreview(null)}
          onConfirm={() =>
            void action.run(async () => {
              const result = await api(
                "/imports/commit",
                "POST",
                writeBody({
                  subject_id: subject,
                  preview_token: preview.preview_token,
                }),
              );
              setPreview(null);
              setBundle(null);
              setFileName("");
              download("import-report.json", result);
            }, "导入已完成，结果报告已下载")
          }
        />
      )}
    </>
  );
}
export function Backups({
  refresh,
  subject,
}: {
  refresh: number;
  subject: string;
}) {
  const [version, setVersion] = useState(0);
  const backups = useResource<Page<Backup>>("/backups", `${refresh}:${version}`);
  const action = useAction();
  const [pending, setPending] = useState<{
    backup_id: string;
    value: Preview;
  } | null>(null);
  const [labelFor, setLabelFor] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [removing, setRemoving] = useState<Backup | null>(null);
  const [cloudRemoving, setCloudRemoving] = useState<CloudFile | null>(null);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [cloudVersion, setCloudVersion] = useState(0);
  const cloud = useResource<WebdavStatus>("/webdav", `${refresh}:${cloudVersion}`);
  const [form, setForm] = useState({
    provider: "jianguoyun" as "jianguoyun" | "custom",
    url: "https://dav.jianguoyun.com/dav/",
    username: "",
    password: "",
    root: "vectorize-mcp",
  });
  // 云端表单必须跟随服务端已保存的值：之前在渲染期只填一次（formLoaded 门控），
  // 保存后或别处改动 WebDAV 配置再回来时会显示旧值，看起来像「没读回配置」。
  useEffect(() => {
    if (!cloud.data) return;
    setForm({
      provider: cloud.data.provider,
      url: cloud.data.url,
      username: cloud.data.username,
      password: "",
      root: cloud.data.root,
    });
  }, [cloud.data]);
  const [files, setFiles] = useState<CloudFile[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<CloudJob | null>(null);
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    const timer = window.setInterval(() => {
      void api<CloudJob>("/webdav/jobs/" + jobId)
        .then((next) => {
          if (!live) return;
          setJob(next);
          if (next.status !== "running") window.clearInterval(timer);
        })
        .catch(() => undefined);
    }, 600);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [jobId]);
  const loadFiles = () =>
    action.run(async () => {
      const result = await api<{ items: CloudFile[] }>("/webdav/files");
      setFiles(result.items);
    }, "云端列表已刷新");
  const startRestore = (name: string) =>
    action.run(async () => {
      setJob(null);
      const started = await api<{ job_id: string }>(
        "/webdav/restore",
        "POST",
        writeBody({ name }),
      );
      setJobId(started.job_id);
    }, "");
  return (
    <>
      <Heading
        eyebrow="RECOVERY"
        title="备份与数据"
        description="备份是整个数据库的一致性快照，与单账户的数据导出不同。本地备份留在服务器，云端备份可以多存一份到 WebDAV。"
      >
        <button
          className="primary"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await api("/backups", "POST", writeBody({ label: "" }));
              setVersion((v) => v + 1);
            }, "备份已创建并校验")
          }
        >
          立即备份到本地
        </button>
        <button
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await api("/webdav/upload", "POST", writeBody({ label: "" }));
              setVersion((v) => v + 1);
              setFiles(null);
            }, "已上传一份备份到云端")
          }
        >
          上传到云端
        </button>
      </Heading>
      <Feedback error={action.error} notice={action.notice} />
      <div className="notice warning">
        恢复会回退记忆、次数与配置，并撤销全部旧 MCP
        凭据。完成后需要重新登录，为账户签发新凭据。
      </div>
      <section className="panel padded">
        <h3>本地备份（{backups.data?.items.length ?? 0} 份）</h3>
        <State
          loading={backups.loading}
          error={backups.error}
          empty={!backups.data?.items.length}
        >
          {backups.data?.items.map((b) => (
            <div className="list-row" key={b.id}>
              <div>
                <strong>{b.label || date(b.created_at)}</strong>
                <small>
                  {date(b.created_at)} · {(b.size / 1024 / 1024).toFixed(2)} MiB
                </small>
                <small title={b.path}>存放位置：{b.path || "—"}</small>
              </div>
              <div className="row-actions">
                <button
                  disabled={action.busy}
                  onClick={() => {
                    setLabelFor(b.id);
                    setLabelDraft(b.label || "");
                  }}
                >
                  {b.label ? "改描述" : "加描述"}
                </button>
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      setPending({
                        backup_id: b.id,
                        value: await api<Preview>(
                          "/restores/preview",
                          "POST",
                          writeBody({ backup_id: b.id }),
                        ),
                      });
                    }, "")
                  }
                >
                  预检恢复…
                </button>
                <button
                  className="danger"
                  disabled={action.busy}
                  onClick={() => setRemoving(b)}
                >
                  删除
                </button>
              </div>
              {labelFor === b.id && (
                <div className="inline-form">
                  <input
                    aria-label={"备份描述 " + b.id}
                    value={labelDraft}
                    maxLength={200}
                    placeholder="例如：升级前、周末例行"
                    onChange={(event) => setLabelDraft(event.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await api(
                          "/backups/label",
                          "POST",
                          writeBody({ backup_id: b.id, label: labelDraft }),
                        );
                        setLabelFor(null);
                        setVersion((v) => v + 1);
                      }, "描述已保存")
                    }
                  >
                    保存
                  </button>
                  <button onClick={() => setLabelFor(null)}>关闭</button>
                </div>
              )}
            </div>
          ))}
        </State>
      </section>
      <section className="panel padded">
        <div className="section-head">
          <h3>云端备份（WebDAV）</h3>
          <button onClick={() => setCloudOpen((open) => !open)}>
            {cloudOpen ? "收起设置" : "设置云端"}
          </button>
        </div>
        <p className="hint">
          {cloud.data?.configured
            ? "已连接：" +
              (cloud.data.presets.find((item) => item.key === cloud.data?.provider)
                ?.label ?? cloud.data.provider) +
              " · 目录 " +
              cloud.data.root +
              " · 账号 " +
              cloud.data.username
            : "还没有配置云端。配置后可以把备份另存到坚果云等 WebDAV 网盘。"}
        </p>
        {cloudOpen && (
          <div className="form-grid">
            <label>
              <span>网盘类型</span>
              <select
                aria-label="网盘类型"
                value={form.provider}
                onChange={(event) => {
                  const provider = event.target.value as "jianguoyun" | "custom";
                  const preset = cloud.data?.presets.find(
                    (item) => item.key === provider,
                  );
                  setForm((current) => ({
                    ...current,
                    provider,
                    url: preset?.url || current.url,
                  }));
                }}
              >
                {(cloud.data?.presets ?? []).map((preset) => (
                  <option key={preset.key} value={preset.key}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>服务地址</span>
              <input
                aria-label="WebDAV 地址"
                value={form.url}
                onChange={(event) =>
                  setForm((current) => ({ ...current, url: event.target.value }))
                }
              />
            </label>
            <label>
              <span>登录账号</span>
              <input
                aria-label="WebDAV 账号"
                value={form.username}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    username: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>登录密码 / 应用密码</span>
              <input
                aria-label="WebDAV 密码"
                type="password"
                placeholder={cloud.data?.has_password ? "已保存，留空表示不修改" : ""}
                value={form.password}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    password: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>云端目录</span>
              <input
                aria-label="云端目录"
                value={form.root}
                onChange={(event) =>
                  setForm((current) => ({ ...current, root: event.target.value }))
                }
              />
            </label>
            <div className="form-actions">
              <button
                className="primary"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api("/webdav", "POST", writeBody(form));
                    setForm((current) => ({ ...current, password: "" }));
                    setCloudVersion((v) => v + 1);
                  }, "云端设置已保存")
                }
              >
                保存设置
              </button>
              <button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api("/webdav/test", "POST", writeBody({}));
                  }, "连接成功，云端目录已就绪")
                }
              >
                测试连接
              </button>
              <button disabled={action.busy} onClick={() => void loadFiles()}>
                刷新云端列表
              </button>
            </div>
          </div>
        )}
        {files && (
          <div className="card-list">
            {files.length ? (
              files.map((file) => (
                <div className="list-row" key={file.name}>
                  <div>
                    <strong>{file.name}</strong>
                    <small>
                      {(file.size / 1024 / 1024).toFixed(2)} MiB ·{" "}
                      {new Date(file.modified_at).toLocaleString("zh-CN")}
                    </small>
                  </div>
                  <div className="row-actions">
                    <button
                      disabled={action.busy}
                      onClick={() => startRestore(file.name)}
                    >
                      检测并恢复…
                    </button>
                    <button
                      className="danger"
                      disabled={action.busy}
                      onClick={() => setCloudRemoving(file)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="hint">云端目录里还没有备份，点上方“上传到云端”。</p>
            )}
          </div>
        )}
      </section>
      {subject ? (
        <Transfer key={subject} subject={subject} />
      ) : (
        <section className="panel padded">
          <h2>账户数据导入导出</h2>
          <p>请先在顶部选择一个账户，再导出或导入该账户的记忆。</p>
        </section>
      )}
      {cloudRemoving && (
        <CloudDeleteDialog
          file={cloudRemoving}
          onClose={() => setCloudRemoving(null)}
          onDeleted={() => void loadFiles()}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="删除这份本地备份？"
          confirmLabel="删除备份"
          disabled={action.busy}
          onClose={() => {
            setRemoving(null);
            setVersion((v) => v + 1);
          }}
          onConfirm={async () => {
            await api(
              "/backups/delete",
              "POST",
              writeBody({ backup_id: removing.id }),
            );
          }}
        >
          <p>
            {removing.label || date(removing.created_at)} 会连同备份文件一起删除，
            删除后无法找回这份快照。
          </p>
          <p className="hint">存放位置：{removing.path || "—"}</p>
        </ConfirmDialog>
      )}
      {job && (
        <ConfirmDialog
          title="云端备份检测与恢复"
          confirmLabel="确认恢复"
          disabled={job.status !== "done"}
          onClose={() => {
            setJob(null);
            setJobId(null);
          }}
          onConfirm={async () => {
            if (!job.result) throw new Error("预检尚未完成");
            await api(
              "/restores/execute",
              "POST",
              writeBody({
                backup_id: job.result.backup_id,
                preview_token: job.result.preview.preview_token,
              }),
            );
            window.dispatchEvent(new Event("session-expired"));
          }}
        >
          <div className="job-log">
            {job.logs.map((line, index) => (
              <p key={index} className={"log-" + line.level}>
                {new Date(line.at).toLocaleTimeString("zh-CN")} · {line.text}
              </p>
            ))}
            {job.status === "running" && <p className="hint">正在处理，请稍候…</p>}
            {job.status === "failed" && <p className="log-error">失败：{job.error}</p>}
            {job.status === "done" && (
              <p className="hint">
                校验通过。确认恢复后，所有旧访问凭据都会失效，需要重新登录。
              </p>
            )}
          </div>
        </ConfirmDialog>
      )}
      {pending && (
        <PreviewDialog
          title="确认恢复整个数据库"
          preview={pending.value}
          busy={action.busy}
          error={action.error}
          onClose={() => setPending(null)}
          onConfirm={() =>
            void action.run(async () => {
              await api(
                "/restores/execute",
                "POST",
                writeBody({
                  backup_id: pending.backup_id,
                  preview_token: pending.value.preview_token,
                }),
              );
              setPending(null);
              window.dispatchEvent(new Event("session-expired"));
            }, "恢复已完成，请重新登录")
          }
        />
      )}
    </>
  );
}

const ENCODER_FIELD_KEYS = new Set<keyof Config>([
  "embeddingBaseUrl",
  "embeddingModel",
  "embeddingDimension",
]);

/**
 * 向量编码器设置块：预设下拉 → 地址/Key/模型/维度 → 拉取模型列表 → 测试连接。
 * 只改 draft（表单草稿），所有探测请求都不写库、不改当前配置。
 * 维度可以留空：测试会回填服务真实返回的维度，避免「填错维度 → 每条记忆编码失败」。
 */
function EncoderSettings({
  draft,
  setDraft,
}: {
  draft: Config;
  setDraft: (next: Config) => void;
}) {
  const presets = useResource<EncoderPresetsResponse>(
    "/config/embedding-presets",
    0,
  );
  const [selected, setSelected] = useState("");
  const [result, setResult] = useState<EncoderTestResult | null>(null);
  const [models, setModels] = useState<string[]>([]);
  /** 真实能出向量的模型（逐个探测得出）；列表非空时优先只显示这些。 */
  const [embeddable, setEmbeddable] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [keyState, setKeyState] = useState<EncoderKeyStatus | null>(null);
  const [busy, setBusy] = useState<"none" | "test" | "models" | "key">("none");
  const [error, setError] = useState("");

  // 预设下拉要与服务端已保存的配置保持一致：之前只在首次加载时赋值一次，
  // 保存后（active 变化）或刷新页面回来时不会同步，看起来像「配置没读回来」。
  useEffect(() => {
    if (presets.data) setSelected(presets.data.active);
  }, [presets.data]);

  useEffect(() => {
    if (presets.data?.key) setKeyState(presets.data.key);
  }, [presets.data]);

  const items = presets.data?.items ?? [];
  // 有实测结论时只列真正能出向量的模型；否则退回完整列表（用户可手填）。
  const choices =
    embeddable && embeddable.length > 0 ? embeddable : models;
  const preset = items.find((item) => item.key === selected);
  const configured = Boolean(draft.embeddingModel);
  const addressAndModel =
    Boolean(draft.embeddingBaseUrl.trim()) && Boolean(draft.embeddingModel.trim());
  const dimension = Number(draft.embeddingDimension) || 0;
  const canStoreKey = presets.data?.can_store_key !== false;
  const keyReady =
    keyState?.has_key ?? Boolean(presets.data?.key_from_env);

  const applyPreset = (key: string) => {
    setSelected(key);
    setResult(null);
    setModels([]);
    setError("");
    const target = items.find((item) => item.key === key);
    if (!target || key === "custom") return;
    setDraft({
      ...draft,
      embeddingBaseUrl: target.baseUrl,
      embeddingModel: target.model,
      embeddingDimension: target.dimension,
    });
  };

  const saveKey = (value: string) => {
    setBusy("key");
    setError("");
    void api<EncoderKeyStatus>("/config/embedding-key", "POST", value ? { api_key: value } : {})
      .then((status) => {
        setKeyState(status);
        setKeyInput("");
        setResult(null);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "保存密钥失败"),
      )
      .finally(() => setBusy("none"));
  };

  const loadModels = () => {
    if (!draft.embeddingBaseUrl.trim()) {
      setModelsError("请先填写服务地址。");
      return;
    }
    setBusy("models");
    setModelsError("");
    setEmbeddable(null);
    // probe=true：网关的 /models 常把聊天模型与向量模型混列（有的甚至列不出真正的
    // 向量模型），逐个试一次 /embeddings 才能知道哪个能用，避免「选了就测试失败」。
    void api<EncoderModelsResult>("/config/embedding-models", "POST", {
      baseUrl: draft.embeddingBaseUrl.trim(),
      probe: true,
      ...(keyInput.trim() ? { api_key: keyInput.trim() } : {}),
    })
      .then((data) => {
        if (!data.ok) {
          setModels([]);
          setModelsError(data.error ?? "服务未返回模型列表。");
          return;
        }
        setModels(data.models);
        setEmbeddable(data.embeddable ?? null);
        if (!data.models.length)
          setModelsError("服务返回了空的模型列表，请手动填写模型名。");
        else if (Array.isArray(data.embeddable)) {
          setModelsError(
            data.embeddable.length
              ? ""
              : "该服务的模型列表里没有能出向量的模型，请手动填写向量模型名（例如 bge-m3）。",
          );
        } else setModelsError("");
      })
      .catch((e: unknown) =>
        setModelsError(e instanceof Error ? e.message : "拉取模型失败"),
      )
      .finally(() => setBusy("none"));
  };

  const test = () => {
    if (!addressAndModel) {
      setError("请先填写服务地址和模型名，向量维度可以留空由测试自动识别。");
      return;
    }
    setBusy("test");
    setError("");
    setResult(null);
    void api<EncoderTestResult>("/config/embedding-test", "POST", {
      baseUrl: draft.embeddingBaseUrl.trim(),
      model: draft.embeddingModel.trim(),
      ...(dimension > 0 ? { dimension } : {}),
      ...(keyInput.trim() ? { api_key: keyInput.trim() } : {}),
    })
      .then((data) => {
        setResult(data);
        // 真实维度回填：用户不必猜，也不会因维度写错而让所有检索退回词法。
        if (data.ok && data.dimension > 0 && data.dimension !== dimension)
          setDraft({ ...draft, embeddingDimension: data.dimension });
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "测试请求失败"),
      )
      .finally(() => setBusy("none"));
  };

  return (
    <div className="encoder-settings">
      <h3>向量编码器（语义检索）</h3>
      <p className="encoder-intro">
        {configured
          ? "已启用语义检索：新写入与检索会调用该服务生成向量，结果标记 scoring_mode=semantic。"
          : "当前未启用语义检索，检索只做词法匹配。配置并通过测试后，语义召回会明显提升，但记忆正文会发送到下面填写的服务。"}
      </p>
      <div className="settings-grid">
        <label className="setting">
          <span>选择服务预设</span>
          <select
            value={selected}
            onChange={(e) => applyPreset(e.target.value)}
          >
            <option value="">请选择…</option>
            {items.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
          <small>{preset?.summary ?? "选择预设会自动填入地址、模型与维度，仍可手动修改。"}</small>
        </label>
        <label className="setting">
          <span>服务地址（baseUrl）</span>
          <input
            type="text"
            value={draft.embeddingBaseUrl}
            placeholder="https://api.openai.com/v1"
            onChange={(e) => {
              setResult(null);
              setModels([]);
              setDraft({ ...draft, embeddingBaseUrl: e.target.value });
            }}
          />
          <small>
            填到 <code>/v1</code> 这一层即可，程序会自动追加
            <code>/embeddings</code> 与 <code>/models</code>；写成
            <code>.../v1/embeddings</code> 会 404。
          </small>
        </label>
        <label className="setting">
          <span>服务密钥（API Key）</span>
          <input
            type="password"
            value={keyInput}
            disabled={!canStoreKey}
            autoComplete="off"
            placeholder={
              keyState?.source === "file"
                ? "已保存（输入新值可覆盖，留空不修改）"
                : keyState?.source === "env"
                  ? "当前来自服务端环境变量 EMBEDDING_API_KEY"
                  : "粘贴该服务的 API Key"
            }
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <small>
            {canStoreKey
              ? "加密保存在本机 data 目录，不会回显、不写日志；留空保存表示保持现状，点「清除密钥」才会删除。"
              : "当前部署未启用界面保存密钥，只能由服务端环境变量 EMBEDDING_API_KEY 提供。"}
          </small>
          {canStoreKey && (
            <small className="encoder-warn">
              {keyReady
                ? "已检测到可用密钥（来源：" +
                  (keyState?.source === "file" ? "本机加密文件" : "环境变量") +
                  "）。"
                : "尚未配置密钥；需要鉴权的服务会返回 401。"}
            </small>
          )}
          {canStoreKey && (
            <span className="encoder-actions">
              <button
                type="button"
                disabled={busy !== "none" || !keyInput.trim()}
                onClick={() => saveKey(keyInput)}
              >
                {busy === "key" ? "保存中…" : "保存密钥"}
              </button>
              {keyState?.source === "file" && (
                <button
                  type="button"
                  disabled={busy !== "none"}
                  onClick={() => saveKey("")}
                >
                  清除密钥
                </button>
              )}
            </span>
          )}
        </label>
        <label className="setting">
          <span>模型名（model）</span>
          <span className="encoder-actions">
            <input
              type="text"
              value={draft.embeddingModel}
              placeholder="text-embedding-3-small"
              onChange={(e) => {
                setResult(null);
                setDraft({ ...draft, embeddingModel: e.target.value });
              }}
            />
            <button
              type="button"
              disabled={busy !== "none"}
              onClick={loadModels}
              title="调用 {baseUrl}/models 拉取该服务可用的模型"
            >
              {busy === "models" ? "拉取中…" : "拉取模型"}
            </button>
          </span>
          {choices.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                setResult(null);
                setDraft({ ...draft, embeddingModel: e.target.value });
              }}
            >
              <option value="">
                从 {choices.length} 个可用模型中选择…
                {embeddable && embeddable.length > 0 ? "（已实测能出向量）" : ""}
              </option>
              {choices.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <small>
            必须与服务端返回的 model 字段一致，否则写入向量会被拒绝。模型名可手填，也可从服务列表选择。
          </small>
          {modelsError && <small className="encoder-warn">{modelsError}</small>}
        </label>
        <label className="setting">
          <span>向量维度（dimension）</span>
          <input
            type="number"
            min={1}
            max={8192}
            value={dimension > 0 ? String(dimension) : ""}
            placeholder="留空则由测试自动识别"
            onChange={(e) => {
              setResult(null);
              setDraft({ ...draft, embeddingDimension: Number(e.target.value) });
            }}
          />
          <small>
            可留空：点「测试连接」会读回服务真实输出的维度并自动填入。
            维度决定精度与存储（每条记忆 4 字节×维度），改维度会清空已有向量并触发重建。
          </small>
        </label>
      </div>
      <div className="encoder-actions">
        <button type="button" disabled={busy !== "none"} onClick={test}>
          {busy === "test" ? "测试中…" : "测试连接"}
        </button>
        {!addressAndModel && (
          <span className="encoder-warn">
            地址与模型必填；维度可留空。三项全部留空表示不使用语义检索。
          </span>
        )}
      </div>
      {error && <div className="notice warning">{error}</div>}
      {result && (
        <div className={"notice " + (result.ok ? "" : "warning")}>
          {result.ok ? (
            <>
              <strong>连接成功</strong>
              <p>
                服务返回 {result.dimension} 维向量，耗时 {result.elapsed_ms} ms
                {result.dimension_matched
                  ? "，维度已对齐并填入上方输入框。"
                  : "，维度与填写值不一致，请使用回填后的维度再保存。"}
              </p>
            </>
          ) : (
            <>
              <strong>连接失败</strong>
              <p>{result.error ?? "未知错误"}</p>
            </>
          )}
        </div>
      )}
      <div className="notice">
        <strong>启用后会发生什么</strong>
        <p>
          写入时对新记忆调用一次编码；检索时对查询编码并做向量相似度排序，
          与词法结果合并（<code>scoring_mode=semantic</code>）。
        </p>
        <p>
          模型或维度变化会清空已有向量并触发后台重建，重建完成前这些记忆退回词法；
          统计页的「索引失败」「词法降级率」可用来确认是否真的生效。
        </p>
      </div>
    </div>
  );
}

const fields: {
  key: keyof Config;
  label: string;
  help: string;
  min?: number;
  max?: number;
  step?: number;
  defaultValue: string;
  advanced?: boolean;
  type?: "text" | "boolean" | "select";
  options?: { value: string; label: string }[];
}[] = [
  {
    key: "defaultLimit",
    label: "每次带回几条",
    help: "直接记忆与关联记忆共用额度，实际可为 0 条。",
    min: 1,
    max: 5,
    defaultValue: "3",
  },
  {
    key: "tokenBudget",
    label: "最多带回多少内容",
    help: "与 estimated_tokens 同为响应 data 的 UTF-8 字节数；不会截断事实限定词。",
    min: 128,
    max: 1200,
    defaultValue: "1200",
  },
  {
    key: "halfLifeDays",
    label: "旧记忆淡出速度（天）",
    help: "按事实确认时间计算，不会自动删除内容。",
    min: 1,
    max: 36500,
    defaultValue: "180",
  },
  {
    key: "agentArchiveEnabled",
    label: "允许助手整理归档",
    help: "默认关闭；仍需预览并遵守保护规则。",
    type: "boolean",
    defaultValue: "关闭",
  },
  {
    key: "allowInferredProfiles",
    label: "使用待确认的画像",
    help: "开启后，助手可使用推断画像进行检索。",
    type: "boolean",
    defaultValue: "关闭",
  },
  {
    key: "importanceFactor",
    label: "重要程度权重",
    help: "三项权重非负，合计必须为 1。",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: "0.70",
    advanced: true,
  },
  {
    key: "frequencyFactor",
    label: "使用频率权重",
    help: "次数不等于独立会话数量。",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: "0.20",
    advanced: true,
  },
  {
    key: "recencyFactor",
    label: "新近程度权重",
    help: "以最近确认时间为依据。",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: "0.10",
    advanced: true,
  },
  {
    key: "frequencyCap",
    label: "频率饱和值",
    help: "达到此次数后频率分数不再增长。",
    min: 1,
    max: 100000,
    defaultValue: "100",
    advanced: true,
  },
  {
    key: "semanticThreshold",
    label: "语义相关门槛",
    help: "需针对真实编码器校准。",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: "0.65",
    advanced: true,
  },
  {
    key: "lexicalThreshold",
    label: "词法相关门槛",
    help: "编码器不可用时的独立门槛；完整命中为 1.0，部分命中约 0.37~0.70。",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: "0.5",
    advanced: true,
  },
  {
    key: "similarityThreshold",
    label: "近似内容提示门槛",
    help: "只提示，绝不据此自动合并。",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: "0.92",
    advanced: true,
  },
  {
    key: "similarityBuildThreshold",
    label: "相似关系构建阈值",
    help: "重建相似关系时，内容相似度达到此值才生成自动关系；0.3～0.95。",
    min: 0.3,
    max: 0.95,
    step: 0.01,
    defaultValue: "0.55",
    advanced: true,
  },
  {
    key: "similarityBasis",
    label: "相似关系依据",
    help: "重建相似关系时用词法字面还是向量语义。语义能认出「换了说法」的同义记忆，但 5000 条约需 11 秒。",
    defaultValue: "lexical",
    type: "select",
    options: [
      { value: "lexical", label: "词法（字面 bigram，快，认不出同义）" },
      { value: "semantic", label: "语义（向量余弦，认同义）" },
      { value: "hybrid", label: "混合（两者取较高者）" },
    ],
    advanced: true,
  },
  {
    key: "similaritySemanticThreshold",
    label: "向量相似度阈值",
    help: "语义/混合模式下，余弦相似度达到此值才建立自动关系；0.5～0.99。",
    min: 0.5,
    max: 0.99,
    step: 0.01,
    defaultValue: "0.8",
    advanced: true,
  },
  {
    key: "similarityFoldThreshold",
    label: "检索折叠阈值",
    help: "检索时把相似度达到此值的候选折叠成一条代表，避免重复内容占满预算；0.5～1。",
    min: 0.5,
    max: 1,
    step: 0.01,
    defaultValue: "0.8",
    advanced: true,
  },
  {
    key: "protectedImportance",
    label: "受保护的重要程度",
    help: "达到此值或画像类型的记忆不允许助手普通归档。",
    min: 1,
    max: 99,
    defaultValue: "80",
    advanced: true,
  },
  {
    key: "minArchivedDays",
    label: "永久清除前保留天数",
    help: "归档后至少保留这些天数（不得少于 30），永久清除仍需预览确认。",
    min: 30,
    max: 36500,
    defaultValue: "30",
    advanced: true,
  },
  {
    key: "purgeEnabled",
    label: "允许永久清除",
    help: "不可恢复；仍需备份、保留期和预览校验。",
    type: "boolean",
    defaultValue: "关闭",
    advanced: true,
  },
  {
    key: "embeddingBaseUrl",
    label: "编码器服务地址",
    help: "OpenAI 兼容服务。远程服务会收到记忆正文；本地服务需另行启动。",
    type: "text",
    defaultValue: "未配置",
    advanced: true,
  },
  {
    key: "embeddingModel",
    label: "编码器模型",
    help: "切换模型需重建索引，重建完成前不能混用不同模型向量。",
    type: "text",
    defaultValue: "未配置",
    advanced: true,
  },
  {
    key: "embeddingDimension",
    label: "向量维度",
    help: "必须与模型输出一致，可在上方编码器块点「测试连接」自动识别。",
    min: 1,
    max: 8192,
    defaultValue: "以服务配置为准",
    advanced: true,
  },
];
export function Settings({ refresh }: { refresh: number }) {
  const [version, setVersion] = useState(0);
  const config = useResource<Config>("/config", `${refresh}:${version}`);
  const [draft, setDraft] = useState<Config | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<{
    value: Preview;
    patch: Record<string, unknown>;
  } | null>(null);
  const action = useAction();
  useEffect(() => setDraft(config.data), [config.data]);
  return (
    <>
      <Heading
        eyebrow="PREFERENCES"
        title="设置"
        description="先预览修改影响，再发布新配置。新请求使用已发布的规则。"
      />
      <Feedback error={action.error} notice={action.notice} />
      <section className="panel padded">
        <div className="filters">
          <input
            aria-label="搜索设置"
            placeholder="搜索设置…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={advanced}
              onChange={(e) => setAdvanced(e.target.checked)}
            />
            高级设置
          </label>
        </div>
        {advanced && (
          <div className="notice">
            <strong>模型配置如何生效</strong>
            <p>
              发布后的模型服务配置动态用于新请求，无需重启。模型或维度变化会触发后台索引重建；保存成功只代表配置已发布，不代表全部记忆已完成编码。
            </p>
            <p>
              不同模型的向量不会混用。未配置编码器、编码失败或缺少有效向量时，检索会明确使用词法降级；请结合记忆详情的索引状态与统计中的索引失败、降级率检查，不能将词法结果视为语义检索已就绪。
            </p>
          </div>
        )}
        <State loading={config.loading} error={config.error}>
          {draft && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(async () => {
                  const patch = Object.fromEntries(
                    Object.entries(draft).filter(
                      ([k, v]) => k !== "revision" && v !== config.data?.[k],
                    ),
                  );
                  if (!Object.keys(patch).length)
                    throw new Error("尚未修改设置。");
                  setPending({
                    patch,
                    value: await api<Preview>(
                      "/config/preview",
                      "POST",
                      writeBody({ expected_revision: draft.revision, patch }),
                    ),
                  });
                }, "");
              }}
            >
              <div className="settings-grid">
                {fields
                  .filter(
                    (f) =>
                      !ENCODER_FIELD_KEYS.has(f.key) &&
                      (advanced || !f.advanced) &&
                      (!search || (f.label + f.help).includes(search)),
                  )
                  .map((f) => (
                    <label className="setting" key={f.key}>
                      <span>{f.label}</span>
                      {f.type === "select" ? (
                        <select
                          value={String(draft[f.key] ?? "")}
                          onChange={(e) =>
                            setDraft({ ...draft, [f.key]: e.target.value })
                          }
                        >
                          {(f.options ?? []).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : f.type === "boolean" ? (
                        <select
                          value={String(draft[f.key] ?? false)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              [f.key]: e.target.value === "true",
                            })
                          }
                        >
                          <option value="false">关闭</option>
                          <option value="true">开启</option>
                        </select>
                      ) : (
                        <input
                          type={f.type === "text" ? "text" : "number"}
                          min={f.min}
                          max={f.max}
                          step={f.step || 1}
                          value={String(draft[f.key] ?? "")}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              [f.key]:
                                f.type === "text"
                                  ? e.target.value
                                  : Number(e.target.value),
                            })
                          }
                        />
                      )}
                      <small>{f.help}</small>
                      <small>
                        默认：{f.defaultValue}
                        {f.min !== undefined
                          ? " · 范围 " + f.min + "～" + f.max
                          : ""}
                      </small>
                    </label>
                  ))}
              </div>
              {/* 编码器是核心功能，不能藏在「高级设置」后面：折叠时刷新页面会看起来
                  「已保存的配置丢失」（输入框根本没渲染）。任何模式下都必须显示。 */}
              <EncoderSettings draft={draft} setDraft={setDraft} />
              <footer>
                <span>配置版本 {draft.revision}</span>
                <button
                  type="button"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      const patch = Object.fromEntries(
                        fields
                          .filter(
                            (f) =>
                              f.type !== "text" &&
                              f.key !== "embeddingDimension",
                          )
                          .map((f) => [
                            f.key,
                            f.type === "boolean"
                              ? false
                              : Number(f.defaultValue),
                          ]),
                      );
                      setPending({
                        patch,
                        value: await api<Preview>(
                          "/config/preview",
                          "POST",
                          writeBody({
                            expected_revision: draft.revision,
                            patch,
                          }),
                        ),
                      });
                    }, "")
                  }
                >
                  预览恢复默认…
                </button>
                <button className="primary" disabled={action.busy}>
                  预览修改…
                </button>
              </footer>
            </form>
          )}
        </State>
      </section>
      <SecuritySettings />
      {pending && (
        <PreviewDialog
          title="发布配置修改"
          preview={pending.value}
          busy={action.busy}
          error={action.error}
          onClose={() => setPending(null)}
          onConfirm={() =>
            void action.run(async () => {
              await api(
                "/config",
                "PATCH",
                writeBody({
                  expected_revision: draft?.revision,
                  patch: pending.patch,
                  preview_token: pending.value.preview_token,
                }),
              );
              setPending(null);
              setVersion((v) => v + 1);
            }, "配置已发布")
          }
        />
      )}
    </>
  );
}
type AuditFilters = {
  action: string;
  actor: string;
  from: string;
  to: string;
};
const emptyAuditFilters: AuditFilters = {
  action: "",
  actor: "",
  from: "",
  to: "",
};
export function AuditLog({ refresh }: { refresh: number }) {
  const [cursor, setCursor] = useState("");
  const [draft, setDraft] = useState<AuditFilters>(emptyAuditFilters);
  const [applied, setApplied] = useState<AuditFilters>(emptyAuditFilters);
  const from = applied.from ? new Date(applied.from).getTime() : undefined;
  const to = applied.to ? new Date(applied.to).getTime() + 59999 : undefined;
  const logs = useResource<Page<Audit>>(
    "/audit" +
      query({
        cursor,
        limit: 50,
        action: applied.action,
        actor: applied.actor,
        from,
        to,
      }),
    refresh,
  );
  const update = (key: keyof AuditFilters, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  return (
    <>
      <Heading
        eyebrow="HISTORY"
        title="操作记录"
        description="按操作、操作者或时间筛选修改历史。审计记录不展示访问密钥。"
      />
      <section className="panel padded">
        <form
          className="filters audit-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setCursor("");
            setApplied(draft);
          }}
        >
          <label>
            操作
            <input
              aria-label="筛选操作"
              placeholder="例如 memory_add"
              value={draft.action}
              onChange={(event) => update("action", event.target.value)}
            />
          </label>
          <label>
            操作者
            <input
              aria-label="筛选操作者"
              placeholder="例如 admin"
              value={draft.actor}
              onChange={(event) => update("actor", event.target.value)}
            />
          </label>
          <label>
            开始时间
            <input
              type="datetime-local"
              value={draft.from}
              onChange={(event) => update("from", event.target.value)}
            />
          </label>
          <label>
            结束时间
            <input
              type="datetime-local"
              value={draft.to}
              onChange={(event) => update("to", event.target.value)}
            />
          </label>
          <button className="primary" type="submit">
            查询
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(emptyAuditFilters);
              setApplied(emptyAuditFilters);
              setCursor("");
            }}
          >
            清除筛选
          </button>
        </form>
        <State
          loading={logs.loading}
          error={logs.error}
          empty={!logs.data?.items.length}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作</th>
                  <th>操作者</th>
                  <th>结果 / 原因</th>
                </tr>
              </thead>
              <tbody>
                {logs.data?.items.map((l) => (
                  <tr key={l.id}>
                    <td>{date(l.created_at)}</td>
                    <td>{l.action}</td>
                    <td>{l.actor_id}</td>
                    <td>
                      {l.result}
                      <small>{l.reason}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button disabled={!cursor} onClick={() => setCursor("")}>
              第一页
            </button>
            <button
              disabled={!logs.data?.next_cursor}
              onClick={() => setCursor(logs.data?.next_cursor || "")}
            >
              下一页
            </button>
          </div>
        </State>
      </section>
    </>
  );
}

function CloudDeleteDialog({
  file,
  onClose,
  onDeleted,
}: {
  file: CloudFile;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [stage, setStage] = useState<"loading" | "ready" | "error" | "done">(
    "loading",
  );
  const [code, setCode] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errorText = (e: unknown) =>
    e instanceof Error ? e.message : String(e);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await api<{ code: string; expires_at: number }>(
          "/webdav/delete-preview",
          "POST",
          writeBody({ name: file.name }),
        );
        if (!alive) return;
        setCode(result.code);
        setStage("ready");
      } catch (e) {
        if (!alive) return;
        setError(errorText(e));
        setStage("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [file.name]);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api(
        "/webdav/delete",
        "POST",
        writeBody({ name: file.name, code: input }),
      );
      setStage("done");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="彻底删除云端备份" onClose={onClose} locked>
      {stage === "loading" && <p>正在生成验证码…</p>}
      {stage === "error" && (
        <>
          <div className="notice error" role="alert">
            {error}
          </div>
          <footer>
            <button onClick={onClose}>关闭</button>
          </footer>
        </>
      )}
      {stage === "done" ? (
        <>
          <div className="notice success" role="status">
            云端备份已删除。
          </div>
          <footer>
            <button
              className="primary"
              onClick={() => {
                onDeleted();
                onClose();
              }}
            >
              完成
            </button>
          </footer>
        </>
      ) : (
        stage === "ready" && (
          <>
            <p>
              将从云端删除 <strong>{file.name}</strong>，
              <strong>不可恢复</strong>。本地备份不受影响。
            </p>
            <label>
              本次验证码（5 分钟内有效）
              <code
                aria-label="删除验证码"
                style={{
                  display: "inline-block",
                  padding: "6px 14px",
                  fontSize: 22,
                  letterSpacing: 6,
                  fontWeight: 700,
                  alignSelf: "flex-start",
                }}
              >
                {code}
              </code>
            </label>
            <label>
              输入验证码
              <input
                inputMode="numeric"
                maxLength={6}
                value={input}
                autoFocus
                placeholder="输入上方 6 位数字"
                onChange={(e) =>
                  setInput(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
              />
            </label>
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <footer>
              <button onClick={onClose} disabled={busy}>
                取消
              </button>
              <button
                className="danger"
                disabled={busy || input.length !== 6}
                onClick={() => void submit()}
              >
                确认删除
              </button>
            </footer>
          </>
        )
      )}
    </Modal>
  );
}

function SecuritySettings() {
  const action = useAction();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const weak = next.length > 0 && (next.length < 8 || next.length > 1024);
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready =
    current.length > 0 &&
    next.length > 0 &&
    next === confirm &&
    !weak &&
    !action.busy;
  return (
    <section className="panel padded" id="security">
      <h2>安全</h2>
      <p className="hint">
        修改管理员密码，长度 8–1024 个字符。修改成功后所有登录会话立即失效，需要用新密码重新登录。
      </p>
      <Feedback error={action.error} notice={action.notice} />
      {done ? (
        <div className="notice success" role="status">
          <p>密码已修改，请用新密码重新登录。</p>
          <button className="primary" onClick={() => window.location.reload()}>
            重新登录
          </button>
        </div>
      ) : (
        <form
          className="editor-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api(
                "/auth/password",
                "POST",
                writeBody({
                  current_password: current,
                  new_password: next,
                }),
              );
              setCurrent("");
              setNext("");
              setConfirm("");
              setDone(true);
            }, "密码已修改");
          }}
        >
          <label>
            当前密码
            <input
              type="password"
              aria-label="当前密码"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label>
            新密码
            <input
              type="password"
              aria-label="新密码"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <label>
            确认新密码
            <input
              type="password"
              aria-label="确认新密码"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          {weak && <small className="hint">新密码需 8–1024 个字符。</small>}
          {mismatch && (
            <small className="hint">两次输入的新密码不一致。</small>
          )}
          <footer>
            <button className="primary" disabled={!ready}>
              {action.busy ? "正在修改…" : "修改密码"}
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}

