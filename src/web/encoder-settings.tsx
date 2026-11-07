import { useEffect, useState } from "react";
import {
  api,
  dataChanged,
  writeBody,
  type Config,
  type EncoderKeyStatus,
  type EncoderModelsResult,
  type ModelTestResult,
  type Preview,
} from "./api";
import { Feedback, PreviewDialog, State, useAction, useResource } from "./ui";

/**
 * 通用模型设置块（默认折叠）：只用于「记忆整理 → 相似分组」，
 * 让大模型判断两条记忆是否讲同一件事。检索始终是词法匹配，与这里无关。
 */
export function ModelSettings({
  draft,
  setDraft,
}: {
  draft: Config;
  setDraft: (next: Config) => void;
}) {
  const meta = useResource<{ key?: EncoderKeyStatus; can_store_key?: boolean }>(
    "/config/model-settings",
    0,
  );
  const [result, setResult] = useState<ModelTestResult | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [keyState, setKeyState] = useState<EncoderKeyStatus | null>(null);
  const [busy, setBusy] = useState<"none" | "test" | "models" | "key">("none");
  const [error, setError] = useState("");

  useEffect(() => {
    if (meta.data?.key) setKeyState(meta.data.key);
  }, [meta.data]);

  const baseUrl = draft.llmBaseUrl ?? "";
  const model = draft.llmModel ?? "";
  const configured = Boolean(baseUrl.trim() && model.trim());
  const canStoreKey = meta.data?.can_store_key !== false;
  const keyReady = keyState?.has_key ?? false;

  const saveKey = (value: string) => {
    setBusy("key");
    setError("");
    void api<EncoderKeyStatus>("/config/embedding-key", "POST", value ? { api_key: value } : {})
      .then((status) => {
        setKeyState(status);
        setKeyInput("");
        setResult(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "保存密钥失败"))
      .finally(() => setBusy("none"));
  };

  const loadModels = () => {
    if (!baseUrl.trim()) {
      setModelsError("请先填写服务地址。");
      return;
    }
    setBusy("models");
    setModelsError("");
    void api<EncoderModelsResult>("/config/embedding-models", "POST", {
      baseUrl: baseUrl.trim(),
      ...(keyInput.trim() ? { api_key: keyInput.trim() } : {}),
    })
      .then((data) => {
        if (!data.ok) {
          setModels([]);
          setModelsError(data.error ?? "服务未返回模型列表。");
          return;
        }
        setModels(data.models);
        setModelsError(data.models.length ? "" : "服务返回了空的模型列表，请手动填写模型名。");
      })
      .catch((e: unknown) =>
        setModelsError(e instanceof Error ? e.message : "拉取模型失败"),
      )
      .finally(() => setBusy("none"));
  };

  const test = () => {
    if (!configured) {
      setError("请先填写服务地址和模型名。");
      return;
    }
    setBusy("test");
    setError("");
    setResult(null);
    void api<ModelTestResult>("/config/embedding-test", "POST", {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(keyInput.trim() ? { api_key: keyInput.trim() } : {}),
    })
      .then((data) => setResult(data))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "测试请求失败"))
      .finally(() => setBusy("none"));
  };

  return (
    <details className="model-settings-details">
      <summary>
        <span className="model-settings-title">模型设置</span>
        <span className="model-settings-hint">
          {configured ? "已配置 · " + model : "未配置（只能按词法生成分组）"}
        </span>
      </summary>
      <div className="encoder-settings">
        <p className="encoder-intro">
          {configured
            ? "已配置通用模型：生成相似分组时，由它判断两条记忆是否讲同一件事。它不参与检索排序。"
            : "尚未配置通用模型：只能按词法字面匹配生成分组。配置并测试通过后，可让模型判断语义相似；记忆正文会发送到下面填写的服务。"}
        </p>
        <div className="settings-grid">
          <label className="setting">
            <span>服务地址（baseUrl）</span>
            <input
              type="text"
              value={baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => {
                setResult(null);
                setModels([]);
                setDraft({ ...draft, llmBaseUrl: e.target.value });
              }}
            />
            <small>
              填到 <code>/v1</code> 这一层即可，程序会自动追加 <code>/chat/completions</code> 与 <code>/models</code>。
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
                    ? "当前来自服务端环境变量"
                    : "粘贴该服务的 API Key（如无需鉴权可留空）"
              }
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <small>
              {canStoreKey
                ? "加密保存在本机 data 目录，不会回显、不写日志；留空保存表示保持现状，点「清除密钥」才会删除。"
                : "当前部署未启用界面保存密钥，只能由服务端环境变量提供。"}
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
                  {busy === "key" ? "保存中" : "保存密钥"}
                </button>
                {keyState?.source === "file" && (
                  <button type="button" disabled={busy !== "none"} onClick={() => saveKey("")}>
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
                value={model}
                placeholder="gpt-4o-mini / deepseek-chat 等"
                onChange={(e) => {
                  setResult(null);
                  setDraft({ ...draft, llmModel: e.target.value });
                }}
              />
              <button
                type="button"
                disabled={busy !== "none"}
                onClick={loadModels}
                title="调用 {baseUrl}/models 拉取该服务可用的模型"
              >
                {busy === "models" ? "拉取中" : "拉取模型"}
              </button>
            </span>
            {models.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  setResult(null);
                  setDraft({ ...draft, llmModel: e.target.value });
                }}
              >
                <option value="">从 {models.length} 个可用模型中选择</option>
                {models.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <small>可与服务列表里的任一对话模型对应；若用于相似判断，建议选质量较好的对话模型。</small>
            {modelsError && <small className="encoder-warn">{modelsError}</small>}
          </label>
        </div>
        <div className="encoder-actions">
          <button type="button" disabled={busy !== "none"} onClick={test}>
            {busy === "test" ? "测试中" : "测试连接"}
          </button>
          {!configured && (
            <span className="encoder-warn">地址与模型必填；两项全部留空表示不启用模型整理。</span>
          )}
        </div>
        {error && <div className="notice warning">{error}</div>}
        {result && (
          <div className={"notice " + (result.ok ? "" : "warning")}>
            {result.ok ? (
              <>
                <strong>连接成功</strong>
                <p>
                  模型 {result.model} 正常响应，耗时 {result.elapsed_ms} ms。
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
      </div>
    </details>
  );
}

/**
 * 自包含的模型配置卡：自己加载 /config，只编辑模型服务地址与模型名，预览后发布。
 * 放在「记忆整理」页，与相似分组放在一起。
 */
export function EncoderConfigCard() {
  const [version, setVersion] = useState(0);
  const config = useResource<Config>("/config", version);
  const [draft, setDraft] = useState<Config | null>(null);
  const [pending, setPending] = useState<{
    value: Preview;
    patch: Record<string, unknown>;
  } | null>(null);
  const action = useAction();
  useEffect(() => setDraft(config.data), [config.data]);
  const dirty =
    !!draft &&
    !!config.data &&
    ((draft.llmBaseUrl ?? "") !== (config.data.llmBaseUrl ?? "") ||
      (draft.llmModel ?? "") !== (config.data.llmModel ?? ""));
  return (
    <>
      <Feedback error={action.error} notice={action.notice} />
      <State loading={config.loading} error={config.error}>
        {draft && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const patch = {
                  llmBaseUrl: (draft.llmBaseUrl ?? "").trim(),
                  llmModel: (draft.llmModel ?? "").trim(),
                };
                if (
                  !Object.entries(patch).some(
                    ([k, v]) => v !== (config.data as unknown as Record<string, unknown>)[k],
                  )
                )
                  throw new Error("尚未修改模型配置。");
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
            <ModelSettings draft={draft} setDraft={setDraft} />
            <footer>
              <span>发布后只影响「相似分组与合并」，不会改变检索方式。</span>
              <button className="primary" disabled={!dirty || action.busy}>
                保存模型配置
              </button>
            </footer>
          </form>
        )}
      </State>
      {pending && (
        <PreviewDialog
          title="发布模型配置"
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
              dataChanged();
            }, "模型配置已发布")
          }
        />
      )}
    </>
  );
}
