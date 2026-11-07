export interface EmbeddingDescriptor {
  provider: "openai-compatible";
  model: string;
  version: string;
  dimension: number;
  normalization: "l2";
}
export interface EmbeddingOptions {
  baseUrl: string;
  model: string;
  dimension: number;
  apiKey?: string;
  version?: string;
  timeoutMs?: number;
  concurrency?: number;
  maxQueue?: number;
  fetch?: typeof fetch;
  /**
   * 是否在请求体里带 `dimensions`，让服务端按指定长度输出（OpenAI text-embedding-3、
   * DashScope v3/v4、智谱 embedding-3 等支持）。不支持该参数的服务会返回 400，
   * 此时自动退回不带 dimensions 的请求并记住结果，避免每条记忆都失败。
   */
  sendDimensions?: boolean;
}
export class EmbeddingError extends Error {
  readonly code = "EMBEDDING_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}
/** Real OpenAI-compatible encoder. No synthetic fallback or cross-account cache. */
export class OpenAIEmbedding {
  readonly descriptor: EmbeddingDescriptor;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly options: EmbeddingOptions;
  private readonly endpoint: URL;
  /** 服务是否接受 dimensions 参数；undefined 表示尚未探测。 */
  private dimensionsSupport: boolean | undefined;
  constructor(options: EmbeddingOptions) {
    const url = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid embedding base URL");
    if (
      !options.model.trim() ||
      !Number.isSafeInteger(options.dimension) ||
      options.dimension < 1 ||
      options.dimension > 65536
    )
      throw new Error("Invalid embedding model or dimension");
    for (const [name, value] of Object.entries({
      timeoutMs: options.timeoutMs ?? 15000,
      concurrency: options.concurrency ?? 4,
      maxQueue: options.maxQueue ?? 64,
    })) {
      if (!Number.isSafeInteger(value) || value < (name === "maxQueue" ? 0 : 1))
        throw new Error("Invalid embedding limit: " + name);
    }
    url.pathname = url.pathname.replace(/\/$/, "") + "/embeddings";
    this.endpoint = url;
    this.dimensionsSupport = options.sendDimensions === false ? false : undefined;
    this.options = { ...options };
    this.descriptor = Object.freeze({
      provider: "openai-compatible",
      model: options.model,
      version: options.version ?? options.model,
      dimension: options.dimension,
      normalization: "l2",
    });
  }
  private async acquire(): Promise<void> {
    if (this.active < (this.options.concurrency ?? 4)) {
      this.active++;
      return;
    }
    if (this.waiting.length >= (this.options.maxQueue ?? 64))
      throw new EmbeddingError("Embedding queue is full");
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(resume);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new EmbeddingError("Embedding queue timed out"));
      }, this.options.timeoutMs ?? 15000);
      this.waiting.push(resume);
    });
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
  async embed(text: string): Promise<number[]> {
    if (typeof text !== "string" || !text.trim())
      throw new EmbeddingError("Embedding input must not be empty");
    await this.acquire();
    try {
      const send = (withDimensions: boolean) =>
        (this.options.fetch ?? fetch)(this.endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
          headers: {
            "Content-Type": "application/json",
            ...(this.options.apiKey
              ? { Authorization: "Bearer " + this.options.apiKey }
              : {}),
          },
          body: JSON.stringify({
            model: this.descriptor.model,
            input: text,
            encoding_format: "float",
            // 显式指定输出维度：否则服务端只按模型默认维度返回，维度框填其他值会全量失败。
            ...(withDimensions && this.descriptor.dimension > 0
              ? { dimensions: this.descriptor.dimension }
              : {}),
          }),
        });
      const wantsDimensions =
        this.options.sendDimensions !== false && this.dimensionsSupport !== false;
      let response = await send(wantsDimensions);
      // 不支持 dimensions 的服务会回 400/422：退回不带该参数重试一次，并记住结论，
      // 避免此后每条记忆都先失败一次。仍失败则按原错误上报。
      if (wantsDimensions && (response.status === 400 || response.status === 422)) {
        const retry = await send(false);
        if (retry.ok) this.dimensionsSupport = false;
        response = retry;
      } else if (wantsDimensions && response.ok) {
        this.dimensionsSupport = true;
      }
      if (!response.ok)
        throw new EmbeddingError(
          "Embedding provider returned HTTP " + response.status,
        );
      const result: unknown = await response.json();
      if (!result || typeof result !== "object")
        throw new EmbeddingError("Invalid embedding response");
      const payload = result as {
        model?: unknown;
        data?: Array<{ embedding?: unknown; index?: unknown }>;
      };
      if (payload.model !== this.descriptor.model)
        throw new EmbeddingError("Embedding model mismatch");
      if (
        !Array.isArray(payload.data) ||
        payload.data.length !== 1 ||
        payload.data[0]?.index !== 0
      )
        throw new EmbeddingError("Invalid embedding response items");
      const vector = payload.data[0].embedding;
      if (
        !Array.isArray(vector) ||
        vector.length !== this.descriptor.dimension ||
        !vector.every((v) => typeof v === "number" && Number.isFinite(v))
      )
        throw new EmbeddingError("Embedding dimension or values invalid");
      // Scale first to avoid overflow/underflow in the norm of finite components.
      const scale = vector.reduce(
        (maximum, v: number) => Math.max(maximum, Math.abs(v)),
        0,
      );
      if (scale === 0)
        throw new EmbeddingError("Embedding vector must be nonzero");
      const scaled: number[] = vector.map((v: number) => v / scale);
      const norm = Math.sqrt(scaled.reduce((sum, v) => sum + v * v, 0));
      return scaled.map((v) => v / norm);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError("Embedding request failed or timed out");
    } finally {
      this.release();
    }
  }
}
export function createEmbeddingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIEmbedding | null {
  if (
    !env.EMBEDDING_BASE_URL &&
    !env.EMBEDDING_MODEL &&
    !env.EMBEDDING_DIMENSION
  )
    return null;
  if (
    !env.EMBEDDING_BASE_URL ||
    !env.EMBEDDING_MODEL ||
    !env.EMBEDDING_DIMENSION
  )
    throw new Error(
      "Set EMBEDDING_BASE_URL, EMBEDDING_MODEL and EMBEDDING_DIMENSION together",
    );
  return new OpenAIEmbedding({
    baseUrl: env.EMBEDDING_BASE_URL,
    model: env.EMBEDDING_MODEL,
    dimension: Number(env.EMBEDDING_DIMENSION),
    apiKey: env.EMBEDDING_API_KEY,
    version: env.EMBEDDING_VERSION,
    timeoutMs: Number(env.EMBEDDING_TIMEOUT_MS ?? 15000),
    concurrency: Number(env.EMBEDDING_CONCURRENCY ?? 4),
    maxQueue: Number(env.EMBEDDING_MAX_QUEUE ?? 64),
  });
}
