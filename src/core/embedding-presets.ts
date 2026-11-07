/**
 * 向量编码器预设目录。
 *
 * 设置页的「向量编码器」下拉直接读这里；选择预设只是把 baseUrl / model / dimension
 * 三个字段填进表单，保存时仍走 store.validatedConfig 的同一套校验，不存在旁路。
 * dimension 必须是所选模型的真实输出维度：填错时「测试连接」会返回明确原因，
 * 而不是等到真实检索才发现。
 */
export interface EncoderPreset {
  /** 稳定标识，用于前端 selected 值与测试断言。 */
  key: string;
  label: string;
  /** 服务基址；程序会在其后追加 /embeddings，因此这里不要带该路径。 */
  baseUrl: string;
  model: string;
  /** 模型默认输出维度。 */
  dimension: number;
  /** 是否需要 API Key（Key 只能由服务端环境变量 EMBEDDING_API_KEY 提供）。 */
  needsKey: boolean;
  /** 一句话说明：适用场景与代价。 */
  summary: string;
}

export const ENCODER_PRESETS: EncoderPreset[] = [
  {
    key: "openai",
    label: "OpenAI 官方",
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dimension: 1536,
    needsKey: true,
    summary: "通用效果好、按量计费；记忆正文会发送到 OpenAI。需要 EMBEDDING_API_KEY。",
  },
  {
    key: "dashscope",
    label: "阿里云百炼 DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "text-embedding-v3",
    dimension: 1024,
    needsKey: true,
    summary: "国内网络稳定、中文表现好；走 OpenAI 兼容模式。需要 EMBEDDING_API_KEY。",
  },
  {
    key: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "embedding-3",
    dimension: 2048,
    needsKey: true,
    summary: "国内可直连，embedding-3 默认 2048 维；自定义维度时以测试结果为准。需要 EMBEDDING_API_KEY。",
  },
  {
    key: "ollama",
    label: "本地 Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "nomic-embed-text",
    dimension: 768,
    needsKey: false,
    summary: "完全本地、不联网、免密钥；首次需 ollama pull nomic-embed-text。速度取决于本机。",
  },
  {
    key: "lmstudio",
    label: "本地 LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "text-embedding-nomic-embed-text-v1.5",
    dimension: 768,
    needsKey: false,
    summary: "图形化本地服务、免密钥；需在 LM Studio 内先加载对应 embedding 模型。",
  },
  {
    key: "custom",
    label: "自定义（手动填写）",
    baseUrl: "",
    model: "",
    dimension: 0,
    needsKey: false,
    summary: "任何 OpenAI 兼容的 /embeddings 服务；三个字段都需自行填写并测试通过。",
  },
];

/** 预设查找：按 key 精确命中，未知 key 返回 undefined。 */
export const findEncoderPreset = (key: string) =>
  ENCODER_PRESETS.find((preset) => preset.key === key);

/**
 * 反查当前配置对应的预设：三项完全一致才算命中，否则视为自定义。
 * 前端用它给下拉框选初始值。
 */
export const matchEncoderPreset = (config: {
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
}): EncoderPreset | undefined =>
  ENCODER_PRESETS.find(
    (preset) =>
      preset.key !== "custom" &&
      preset.baseUrl === (config.embeddingBaseUrl ?? "") &&
      preset.model === (config.embeddingModel ?? "") &&
      preset.dimension === (config.embeddingDimension ?? 0),
  );
