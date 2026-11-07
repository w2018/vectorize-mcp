import { useEffect, useState } from "react";
import {
  api,
  dataChanged,
  writeBody,
  type Config,
  type EncoderKeyStatus,
  type EncoderModelsResult,
  type EncoderPresetsResponse,
  type EncoderTestResult,
  type Preview,
} from "./api";
import { Feedback, PreviewDialog, State, useAction, useResource } from "./ui";

/**
 * 向量编码器设置块：预设下拉 → 地址/Key/模型/维度 → 拉取模型列表 → 测试连接。
 * 只改 draft（表单草稿），所有探测请求都不写库、不改当前配置。
 * 注意：这里的编码器只服务于「记忆整理 → 重建相似关系」，不改变检索方式——
 * 检索始终按词法匹配（见 semanticSearch 默认关闭）。
 */
export function EncoderSettings({
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

  useEffect(() => {
    if (presets.data) setSelected(presets.data.active);
  }, [presets.data]);

  useEffect(() => {
    if (presets.data?.key) setKeyState(presets.data.key);
  }, [presets.data]);

  const items = presets.data?.items ?? [];
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
      <h3>向量编码器（仅用于重建相似关系）</h3>
      <p className="encoder-intro">
        {configured
          ? "已配置向量编码器：它只在下方「重建相似关系」时按语义批量计算向量，不改变检索方式（检索始终按词法匹配）。"
          : "尚未配置向量编码器：重建相似关系只能按词法匹配。配置并通过测试后，可按语义计算相似关系；记忆正文会发送到下面填写的服务。"}
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
            维度决定精度与存储（每条记忆 4 字节×维度），改维度会清空已有向量。
          </small>
        </label>
      </div>
      <div className="encoder-actions">
        <button type="button" disabled={busy !== "none"} onClick={test}>
          {busy === "test" ? "测试中…" : "测试连接"}
        </button>
        {!addressAndModel && (
          <span className="encoder-warn">
            地址与模型必填；维度可留空。三项全部留空表示不使用向量编码器。
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
    </div>
  );
}

/**
 * 自包含的编码器配置卡：自己加载 /config、只编辑三个向量字段、预览后发布。
 * 放在「记忆整理」页，与重建相似关系放在一起，避免分散在两个页面。
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
    (draft.embeddingBaseUrl !== config.data.embeddingBaseUrl ||
      draft.embeddingModel !== config.data.embeddingModel ||
      draft.embeddingDimension !== config.data.embeddingDimension);
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
                  embeddingBaseUrl: draft.embeddingBaseUrl.trim(),
                  embeddingModel: draft.embeddingModel.trim(),
                  embeddingDimension: Number(draft.embeddingDimension) || 0,
                };
                if (
                  !Object.entries(patch).some(
                    ([k, v]) => v !== (config.data as unknown as Record<string, unknown>)[k],
                  )
                )
                  throw new Error("尚未修改编码器配置。");
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
            <EncoderSettings draft={draft} setDraft={setDraft} />
            <footer>
              <span>发布后只影响「重建相似关系」，不会改变检索方式。</span>
              <button className="primary" disabled={!dirty || action.busy}>
                保存编码器配置…
              </button>
            </footer>
          </form>
        )}
      </State>
      {pending && (
        <PreviewDialog
          title="发布编码器配置"
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
            }, "编码器配置已发布")
          }
        />
      )}
    </>
  );
}
