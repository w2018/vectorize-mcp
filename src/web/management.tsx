import { useEffect, useState } from "react";
import {
  api,
  download,
  query,
  writeBody,
  type Account,
  type Audit,
  type Backup,
  type Config,
  type Page,
  type Preview,
  type Token,
} from "./api";
import {
  date,
  Feedback,
  Heading,
  Modal,
  PreviewDialog,
  State,
  useAction,
  useResource,
} from "./ui";
type Pending = {
  title: string;
  value: Preview;
  path: string;
  method?: string;
  body: Record<string, unknown>;
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
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  async function create(body: Record<string, unknown>) {
    const result = await api<{
      token?: string;
      secret?: string;
      secret_available?: boolean;
    }>("/tokens", "POST", writeBody(body));
    onChange();
    setLabel("");
    if (result.token || result.secret)
      setSecret(result.token || result.secret || null);
    else
      throw new Error("凭据已创建，但无法再次显示。请撤销该凭据后重新创建。");
  }
  return (
    <>
      <Heading
        eyebrow="ACCESS"
        title="账户与访问凭据"
        description="一枚有效 Token 对应一个独立账户。同一 Token 可在多个客户端使用。"
      />
      <Feedback error={action.error || accounts.error} notice={action.notice} />
      <section className="panel padded">
        <h2>创建新账户</h2>
        <p>凭据只展示一次，请在关闭弹窗前妥善保存。</p>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(() => create({ label }), "");
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
          <button className="primary" disabled={action.busy}>
            创建凭据
          </button>
        </form>
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
                      <small>{t.id}</small>
                    </td>
                    <td>{t.status === "active" ? "有效" : "已撤销"}</td>
                    <td>
                      {date(t.created_at)}
                      <small>{date(t.last_used_at)}</small>
                    </td>
                    <td>
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
                              body: {},
                            });
                          }, "")
                        }
                      >
                        撤销…
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </State>
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
                        body: { subject_id: a.id, label: a.name },
                      });
                    }, "")
                  }
                >
                  重新启用…
                </button>
              </div>
            ))}
        </State>
      </section>
      {pending && (
        <PreviewDialog
          title={pending.title}
          preview={pending.value}
          busy={action.busy}
          error={action.error}
          onClose={() => setPending(null)}
          onConfirm={() =>
            void action.run(async () => {
              const body = {
                ...pending.body,
                preview_token: pending.value.preview_token,
              };
              if (pending.path === "/tokens") await create(body);
              else {
                await api(pending.path, "POST", writeBody(body));
                onChange();
              }
              setPending(null);
            }, "操作已完成")
          }
        />
      )}
      {secret && (
        <Modal title="请保存你的访问凭据" onClose={() => setSecret(null)}>
          <div className="notice warning">
            关闭后无法再次查看。请勿将凭据放入 URL、公开仓库或聊天记录。
          </div>
          <label>
            仅此次可见
            <textarea readOnly rows={3} value={secret} spellCheck={false} />
          </label>
          <footer>
            <button
              onClick={() =>
                void action.run(async () => {
                  await navigator.clipboard.writeText(secret);
                }, "已复制，请妥善保存")
              }
            >
              复制凭据
            </button>
            <button className="primary" onClick={() => setSecret(null)}>
              已保存，关闭
            </button>
          </footer>
          <Feedback error={action.error} notice={action.notice} />
        </Modal>
      )}
    </>
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
      <Heading
        eyebrow="MOVE YOUR DATA"
        title="数据搬家"
        description="用版本化 JSON 保存和迁移记忆。导入先检查，不会直接覆盖现有内容。"
      />
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
export function Backups({ refresh }: { refresh: number }) {
  const [version, setVersion] = useState(0);
  const backups = useResource<Page<Backup>>("/backups", refresh + version);
  const action = useAction();
  const [pending, setPending] = useState<{
    backup_id: string;
    value: Preview;
  } | null>(null);
  return (
    <>
      <Heading
        eyebrow="RECOVERY"
        title="备份与恢复"
        description="备份是整个数据库的一致性快照，与单账户的数据导出不同。"
      >
        <button
          className="primary"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await api("/backups", "POST", writeBody({}));
              setVersion((v) => v + 1);
            }, "备份已创建并校验")
          }
        >
          创建备份
        </button>
      </Heading>
      <Feedback error={action.error} notice={action.notice} />
      <div className="notice warning">
        恢复会回退记忆、次数与配置，并撤销全部旧 MCP
        凭据。完成后需要重新登录，为账户签发新凭据。
      </div>
      <section className="panel padded">
        <State
          loading={backups.loading}
          error={backups.error}
          empty={!backups.data?.items.length}
        >
          {backups.data?.items.map((b) => (
            <div className="list-row" key={b.id}>
              <div>
                <strong>{date(b.created_at)}</strong>
                <small>
                  {b.id} · {(b.size / 1024 / 1024).toFixed(2)} MiB
                </small>
                <small>
                  校验：
                  {b.verified_at ? date(b.verified_at) : "以恢复预检结果为准"}
                </small>
              </div>
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
            </div>
          ))}
        </State>
      </section>
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
const fields: {
  key: keyof Config;
  label: string;
  help: string;
  min?: number;
  max?: number;
  step?: number;
  defaultValue: string;
  advanced?: boolean;
  type?: "text" | "boolean";
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
    help: "以估算 token 计；不会截断事实限定词。",
    min: 128,
    max: 1200,
    defaultValue: "600",
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
    help: "编码器不可用时的独立门槛。",
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
    help: "归档后至少保留这些天数，永久清除仍需预览确认。",
    min: 1,
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
    help: "必须与模型输出一致。",
    min: 1,
    max: 65536,
    defaultValue: "以服务配置为准",
    advanced: true,
  },
];
export function Settings({ refresh }: { refresh: number }) {
  const [version, setVersion] = useState(0);
  const config = useResource<Config>("/config", refresh + version);
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
                      (advanced || !f.advanced) &&
                      (!search || (f.label + f.help).includes(search)),
                  )
                  .map((f) => (
                    <label className="setting" key={f.key}>
                      <span>{f.label}</span>
                      {f.type === "boolean" ? (
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
export function AuditLog({ refresh }: { refresh: number }) {
  const [cursor, setCursor] = useState("");
  const logs = useResource<Page<Audit>>(
    "/audit" + query({ cursor, limit: 50 }),
    refresh,
  );
  return (
    <>
      <Heading
        eyebrow="HISTORY"
        title="操作记录"
        description="查看谁在什么时间进行了修改。审计记录不展示访问密钥。"
      />
      <section className="panel padded">
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
