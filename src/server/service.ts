import { createHash, randomUUID } from "node:crypto";
import type { DatabasePool } from "./database.js";
import {
  DomainError,
  type Context,
  type Envelope,
  type PreparedSearch,
  type SearchData,
  type SearchInput,
  type Config,
} from "../core/types.js";
import {
  OpenAIEmbedding,
  type EmbeddingDescriptor,
} from "../embedding/openai.js";
import { toolSchemas, type ToolName } from "../mcp/schemas.js";
import type { McpService } from "../mcp/http.js";
import { EmbeddingSecret } from "./embedding-secret.js";

export interface EmbeddingProvider {
  readonly descriptor: EmbeddingDescriptor;
  embed(text: string): Promise<number[]>;
}
export type ServiceDatabase = Pick<DatabasePool, "read" | "write">;
interface IndexInput {
  id: string;
  revision: number;
  content: string;
  status: string;
  embedding_state: string;
}
const codeOf = (error: unknown): unknown =>
  error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;

/** Domain orchestration only: encoders never run inside SQLite transactions. */
export class MemoryService implements McpService<Context> {
  /** 供测试注入的 fetch；生产走全局 fetch。 */
  fetchImpl?: typeof fetch;
  private reindexCursor = "";
  private reindexRunning = false;
  private adapterCache?: { key: string; provider: EmbeddingProvider };
  constructor(
    private readonly database: ServiceDatabase,
    private readonly fallback: EmbeddingProvider | null = null,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly secret: EmbeddingSecret | null = null,
  ) {}
  /** 生效中的 Key：界面保存的加密文件优先，其次是环境变量。 */
  private apiKey(): string {
    if (this.secret) {
      const { apiKey } = this.secret.resolve();
      if (apiKey) return apiKey;
    }
    return (this.env.EMBEDDING_API_KEY ?? "").trim();
  }
  keyStatus() {
    if (this.secret) {
      const status = this.secret.status();
      if (!status.has_key && this.env.EMBEDDING_API_KEY) {
        return { has_key: true, source: "env" as const };
      }
      return status;
    }
    const fromEnv = Boolean(this.env.EMBEDDING_API_KEY);
    return { has_key: fromEnv, source: fromEnv ? ("env" as const) : ("none" as const) };
  }
  saveKey(apiKey: string) {
    if (!this.secret) throw new DomainError("FEATURE_DISABLED");
    this.secret.save(apiKey);
    this.adapterCache = undefined;
    return this.keyStatus();
  }
  async effectiveEmbeddingConfig(): Promise<{
    enabled: boolean;
    baseUrl: string;
    model: string;
    dimension: number;
    version: string;
    normalization: "l2";
  }> {
    const config = await this.database.read<Config>(
      "embedding-config",
      "getConfig",
    );
    const configured = !!config?.embeddingModel;
    return {
      enabled: configured || !!this.fallback,
      baseUrl: configured
        ? config.embeddingBaseUrl
        : (this.env.EMBEDDING_BASE_URL ?? ""),
      model: configured
        ? config.embeddingModel
        : (this.fallback?.descriptor.model ?? ""),
      dimension: configured
        ? config.embeddingDimension
        : (this.fallback?.descriptor.dimension ?? 0),
      version:
        this.env.EMBEDDING_VERSION ??
        (configured
          ? config.embeddingModel
          : (this.fallback?.descriptor.version ?? "")),
      normalization: "l2",
    };
  }
  /** 最近一次编码器构造失败的原因；供检索给出可读降级警告，而不是抛 500。 */
  private encoderFailure = "";
  private async encoder(): Promise<EmbeddingProvider | null> {
    const config = await this.effectiveEmbeddingConfig();
    if (!config.enabled) return null;
    if (!config.baseUrl && this.fallback) return this.fallback;
    const key = JSON.stringify(config);
    if (this.adapterCache?.key === key) return this.adapterCache.provider;
    // D-26: 构造期异常（地址非法、维度为 0、并发参数非法）此前直接冒泡到 MCP 层
    // 被压成 INTERNAL_ERROR，导致「配置写错 → 每次检索都 500」。这里收敛成
    // 「本次不可用」，由调用方降级为词法检索并给出原因。
    let provider: EmbeddingProvider;
    try {
      provider = this.buildEncoder(config);
    } catch (error) {
      this.encoderFailure =
        error instanceof Error && error.message ? error.message : "encoder unavailable";
      this.adapterCache = undefined;
      return null;
    }
    this.encoderFailure = "";
    this.adapterCache = { key, provider };
    return provider;
  }
  private buildEncoder(config: {
    baseUrl: string;
    model: string;
    dimension: number;
    version: string;
  }): EmbeddingProvider {
    return new OpenAIEmbedding({
      baseUrl: config.baseUrl,
      model: config.model,
      dimension: config.dimension,
      version:
        config.version +
        ":endpoint:" +
        createHash("sha256").update(config.baseUrl).digest("hex"),
      apiKey: this.apiKey() || undefined,
      timeoutMs: Number(this.env.EMBEDDING_TIMEOUT_MS ?? 15000),
      concurrency: Number(this.env.EMBEDDING_CONCURRENCY ?? 4),
      maxQueue: Number(this.env.EMBEDDING_MAX_QUEUE ?? 64),
    });
  }
  private identity(embedding: EmbeddingProvider): string {
    const d = embedding.descriptor;
    return JSON.stringify({
      provider: d.provider,
      model: d.model,
      version: d.version,
      dimension: d.dimension,
      normalization: d.normalization,
    });
  }
  async reindexBatch(
    max = 10,
  ): Promise<{
    attempted: number;
    stored: number;
    failed: number;
    skipped: boolean;
  }> {
    if (!Number.isInteger(max) || max < 1 || max > 100)
      throw new DomainError("VALIDATION_ERROR");
    if (this.reindexRunning)
      return { attempted: 0, stored: 0, failed: 0, skipped: true };
    this.reindexRunning = true;
    try {
      const embedding = await this.encoder();
      if (!embedding)
        return { attempted: 0, stored: 0, failed: 0, skipped: true };
      const model = this.identity(embedding);
      const items = await this.database.read<
        Array<{
          subject_id: string;
          id: string;
          revision: number;
          content: string;
        }>
      >("reindex", "pendingEmbeddings", max, model, this.reindexCursor);
      if (!items.length) {
        this.reindexCursor = "";
        return { attempted: 0, stored: 0, failed: 0, skipped: false };
      }
      let stored = 0;
      let failed = 0;
      for (const item of items) {
        this.reindexCursor = item.id;
        try {
          const ctx = await this.database.read<Context>(
            "reindex",
            "adminFor",
            item.subject_id,
          );
          const vector = await embedding.embed(item.content);
          const current = await this.encoder();
          if (!current || this.identity(current) !== model) break; // Model changed while encoding.
          await this.validate(ctx);
          const result = await this.database.write<{ stored: boolean }>(
            "reindex",
            "setEmbedding",
            ctx,
            item.id,
            item.revision,
            model,
            vector,
          );
          if (result.stored) stored++;
        } catch {
          failed++;
        }
      }
      return { attempted: items.length, stored, failed, skipped: false };
    } finally {
      this.reindexRunning = false;
    }
  }
  async authenticate(token: string): Promise<Context> {
    // Admission keys cannot contain a bearer secret, even transiently in scheduler diagnostics.
    const key = "auth:" + createHash("sha256").update(token).digest("hex");
    return this.database.read<Context>(key, "authenticate", token);
  }
  async validate(ctx: Context): Promise<void> {
    await this.database.read<void>(ctx.tokenId, "validateContext", ctx);
  }
  async call(
    ctx: Context,
    tool: ToolName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!Object.prototype.hasOwnProperty.call(toolSchemas, tool))
      throw new DomainError("VALIDATION_ERROR", "Unknown tool");
    // request_id is optional on every tool. When omitted, fill a fresh UUID so
    // weak models cannot fail input validation just because they did not invent one.
    if (typeof args.request_id !== "string" || !args.request_id.trim())
      args = { ...args, request_id: randomUUID() };
    const parsed = toolSchemas[tool].safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => {
          const field = issue.path.join(".") || "(root)";
          return field + ": " + issue.message;
        })
        .slice(0, 6)
        .join("; ");
      throw new DomainError(
        "VALIDATION_ERROR",
        "Invalid tool arguments — " + issues,
      );
    }
    await this.validate(ctx);
    const input = parsed.data;
    const embedding = [
      "memory_search",
      "memory_add",
      "memory_update",
      "memory_merge",
    ].includes(tool)
      ? await this.encoder()
      : null;
    const modelIdentity = embedding ? this.identity(embedding) : null;
    let result: unknown;
    if (tool === "memory_search")
      result = await this.search(ctx, input as SearchInput, embedding);
    else if (
      tool === "memory_get" ||
      tool === "memory_config_get" ||
      tool === "memory_bootstrap"
    )
      result = await this.database.read(
        ctx.tokenId,
        "execute",
        ctx,
        tool,
        input,
      );
    else {
      const replay = await this.database.read<unknown>(
        ctx.tokenId,
        "replayWrite",
        ctx,
        tool,
        input,
      );
      if (replay) return replay;
      let encoded: { text: string; vector: number[] } | undefined;
      if (
        tool === "memory_add" &&
        embedding &&
        modelIdentity &&
        "content" in input &&
        typeof input.content === "string"
      ) {
        try {
          encoded = {
            text: input.content,
            vector: await embedding.embed(input.content),
          };
        } catch {
          /* Exact dedup remains available. */
        }
        await this.validate(ctx);
      }
      const internal = encoded
        ? {
            ...input,
            embedding: { model: modelIdentity, vector: encoded.vector },
          }
        : input;
      result = await this.database.write(
        ctx.tokenId,
        "execute",
        ctx,
        tool,
        internal,
      );
      if (
        tool === "memory_add" ||
        tool === "memory_update" ||
        tool === "memory_merge"
      )
        await this.indexResult(ctx, result, embedding, encoded);
    }
    // store.execute/embeddingInput/setEmbedding each re-authorize internally;
    // the post-write validate() here only added another cross-thread read.
    return result;
  }
  private async search(
    ctx: Context,
    input: SearchInput,
    embedding: EmbeddingProvider | null,
  ): Promise<Envelope<SearchData>> {
    const modelIdentity = embedding ? this.identity(embedding) : null;
    // Replay first: an old snapshot must be rejected, not silently replaced by a fresh search.
    const replay = await this.database.read<Envelope<SearchData> | undefined>(
      ctx.tokenId,
      "replaySearch",
      ctx,
      input,
    );
    if (replay) return replay;
    let enriched = input;
    let warning: string | undefined;
    if (embedding && modelIdentity) {
      try {
        enriched = {
          ...input,
          embedding: {
            model: modelIdentity,
            vector: await embedding.embed(input.query),
          },
        };
      } catch (error) {
        // 把编码失败的真实原因带出来（模型名不匹配 / 维度不符 / HTTP 401…），
        // 否则用户只看到「语义编码失败」，无从判断该改哪一个设置。
        const reason =
          error instanceof Error && error.message ? error.message : "unknown error";
        warning =
          "EMBEDDING_UNAVAILABLE: semantic encoding failed (" +
          reason.slice(0, 200) +
          "); lexical fallback only.";
      }
    } else if (this.encoderFailure)
      // 配置有值但编码器无法构造（地址非法/维度为 0）：必须说明真实原因，
      // 否则用户只会看到「未配置」，去设置页也看不出哪里填错了。
      warning =
        "EMBEDDING_UNAVAILABLE: encoder configuration is invalid (" +
        this.encoderFailure +
        "); lexical fallback only.";
    else
      warning =
        "EMBEDDING_NOT_CONFIGURED: semantic search is disabled; lexical fallback only.";
    for (let attempt = 0; ; attempt++) {
      await this.validate(ctx);
      const prepared = await this.database.read<PreparedSearch>(
        ctx.tokenId,
        "prepareSearch",
        ctx,
        enriched,
      );
      if (warning)
        prepared.warnings = [
          warning,
          ...(!input.keywords?.length
            ? ["KEYWORDS_REQUIRED: provide keywords for lexical fallback."]
            : []),
        ];
      try {
        return await this.database.write<Envelope<SearchData>>(
          ctx.tokenId,
          "commitSearch",
          prepared,
        );
      } catch (error) {
        if (codeOf(error) !== "SNAPSHOT_STALE" || attempt >= 2) throw error;
        // If another caller committed this logical request, validate its snapshot before continuing.
        const concurrent = await this.database.read<
          Envelope<SearchData> | undefined
        >(ctx.tokenId, "replaySearch", ctx, input);
        if (concurrent) return concurrent;
      }
    }
  }
  private async indexResult(
    ctx: Context,
    result: unknown,
    embedding: EmbeddingProvider | null,
    encoded?: { text: string; vector: number[] },
  ): Promise<void> {
    const modelIdentity = embedding ? this.identity(embedding) : null;
    if (
      !embedding ||
      !modelIdentity ||
      !result ||
      typeof result !== "object" ||
      !("data" in result)
    )
      return;
    const data = result.data as {
      id?: unknown;
      target_id?: unknown;
      revision?: unknown;
      index_state?: unknown;
      status?: unknown;
    };
    const id = data.id ?? data.target_id;
    if (
      typeof id !== "string" ||
      typeof data.revision !== "number" ||
      data.index_state === "ready" ||
      data.status === "existing_archived"
    )
      return;
    // Keep the committed response unchanged: its idempotency snapshot describes the write, not a later index job.
    const record = await this.database.read<IndexInput | null>(
      ctx.tokenId,
      "embeddingInput",
      ctx,
      id,
    );
    if (
      !record ||
      record.revision !== data.revision ||
      record.status !== "active" ||
      record.embedding_state === "ready"
    )
      return;
    let vector: number[];
    try {
      vector =
        encoded?.text === record.content
          ? encoded.vector
          : await embedding.embed(record.content);
    } catch {
      return;
    } // Persisted pending state remains accurate and retryable.
    const current = await this.encoder();
    if (!current || this.identity(current) !== modelIdentity) return;
    await this.database.write(
      ctx.tokenId,
      "setEmbedding",
      ctx,
      id,
      record.revision,
      modelIdentity,
      vector,
    );
  }
  /**
   * 用给定配置（通常是设置页尚未发布的草稿）真实调用一次编码服务。
   * 不写数据库、不改动当前配置；维度可留空，此时由服务端返回的向量长度确定真实维度，
   * 避免「维度填错 → 每条记忆编码失败 → 检索永远退回词法」。
   */
  async testEncoder(input: {
    baseUrl: string;
    model: string;
    dimension?: number;
    apiKey?: string;
  }): Promise<{
    ok: boolean;
    model: string;
    dimension: number;
    declared_dimension: number;
    dimension_matched: boolean;
    elapsed_ms: number;
    error?: string;
  }> {
    const started = Date.now();
    const declared = input.dimension ?? 0;
    const probe = await this.probeEmbedding({
      baseUrl: input.baseUrl,
      model: input.model,
      dimension: declared > 0 ? declared : undefined,
      apiKey: input.apiKey?.trim() || this.apiKey() || undefined,
    });
    if (!probe.ok)
      return {
        ok: false,
        model: input.model,
        dimension: 0,
        declared_dimension: declared,
        dimension_matched: declared > 0,
        elapsed_ms: Date.now() - started,
        error: probe.error,
      };
    return {
      ok: declared === 0 || declared === probe.dimension,
      model: probe.model,
      dimension: probe.dimension,
      declared_dimension: declared,
      dimension_matched: declared === 0 || declared === probe.dimension,
      elapsed_ms: Date.now() - started,
      error:
        declared > 0 && declared !== probe.dimension
          ? "服务实际返回 " +
            probe.dimension +
            " 维，与填写的 " +
            declared +
            " 维不一致；请把向量维度改为 " +
            probe.dimension +
            " 后保存。"
          : undefined,
    };
  }
  /** 直接打 /embeddings 探测真实维度；不经过适配器的维度强校验。 */
  private async probeEmbedding(input: {
    baseUrl: string;
    model: string;
    dimension?: number;
    apiKey?: string;
  }): Promise<
    { ok: true; model: string; dimension: number } | { ok: false; error: string }
  > {
    let endpoint: URL;
    try {
      const url = new URL(input.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid URL");
      url.pathname = url.pathname.replace(/\/$/, "") + "/embeddings";
      endpoint = url;
    } catch {
      return { ok: false, error: "服务地址不是合法的 http(s) 地址，或缺少 /v1 前缀。" };
    }
    try {
      const send = (withDimensions: boolean) =>
        (this.fetchImpl ?? fetch)(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(
            Number(this.env.EMBEDDING_TIMEOUT_MS ?? 15000),
          ),
          headers: {
            "Content-Type": "application/json",
            ...(input.apiKey ? { Authorization: "Bearer " + input.apiKey } : {}),
          },
          body: JSON.stringify({
            model: input.model,
            input: "向量编码器连通性测试",
            encoding_format: "float",
            ...(withDimensions && input.dimension ? { dimensions: input.dimension } : {}),
          }),
        });
      let response = await send(Boolean(input.dimension));
      // 不支持 dimensions 的服务回 400/422：退回默认维度重试，让用户看到真实维度。
      if (input.dimension && (response.status === 400 || response.status === 422))
        response = await send(false);
      if (!response.ok) {
        // 网关常把真实原因放在响应体里（例如「embedding model [hy3] not found」），
        // 只报 HTTP 500 用户无法判断是模型名错、维度错还是服务端故障。
        const body = await response.text().catch(() => "");
        let reason = body.slice(0, 300).replace(/\s+/g, " ").trim();
        try {
          const parsed = JSON.parse(body) as {
            error?: { message?: unknown } | string;
            message?: unknown;
          };
          const nested =
            parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string"
              ? parsed.error.message
              : typeof parsed.message === "string"
                ? parsed.message
                : typeof parsed.error === "string"
                  ? parsed.error
                  : "";
          if (nested) reason = nested.replace(/\s+/g, " ").trim().slice(0, 300);
        } catch {
          /* keep raw text */
        }
        const detail =
          response.status === 401 || response.status === 403
            ? "鉴权失败：API Key 无效或未设置。"
            : response.status === 404
              ? "接口不存在：确认地址是 OpenAI 兼容基址，且不要包含 /embeddings 后缀。"
              : "服务拒绝请求（HTTP " +
                response.status +
                "）" +
                (reason ? "：" + reason : "。");
        return { ok: false, error: detail };
      }
      const payload: unknown = await response.json();
      const data =
        payload && typeof payload === "object"
          ? (payload as { data?: Array<{ embedding?: unknown }>; model?: unknown })
          : {};
      const vector = data.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length < 1)
        return { ok: false, error: "服务返回内容不是合法向量，无法确认维度。" };
      return {
        ok: true,
        model: typeof data.model === "string" ? data.model : input.model,
        dimension: vector.length,
      };
    } catch (error) {
      return { ok: false, error: this.readableEncoderError(error) };
    }
  }
  /** 拉取该服务提供的模型列表（OpenAI 兼容 GET /models）。 */
  async listModels(input: {
    baseUrl: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; models: string[]; error?: string }> {
    let endpoint: URL;
    try {
      const url = new URL(input.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid URL");
      url.pathname = url.pathname.replace(/\/$/, "") + "/models";
      endpoint = url;
    } catch {
      return { ok: false, models: [], error: "服务地址不是合法的 http(s) 地址。" };
    }
    try {
      const response = await (this.fetchImpl ?? fetch)(endpoint, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(Number(this.env.EMBEDDING_TIMEOUT_MS ?? 15000)),
        headers: {
          ...(input.apiKey?.trim()
            ? { Authorization: "Bearer " + input.apiKey.trim() }
            : this.apiKey()
              ? { Authorization: "Bearer " + this.apiKey() }
              : {}),
        },
      });
      if (!response.ok)
        return {
          ok: false,
          models: [],
          error:
            response.status === 401 || response.status === 403
              ? "鉴权失败：API Key 无效或未设置。"
              : "服务不支持 /models（HTTP " + response.status + "），请手动填写模型名。",
        };
      const payload: unknown = await response.json();
      const rows =
        payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
          ? ((payload as { data: Array<{ id?: unknown }> }).data)
          : [];
      const models = rows
        .map((row) => (typeof row?.id === "string" ? row.id : ""))
        .filter((id) => Boolean(id))
        .sort();
      return { ok: true, models };
    } catch (error) {
      return { ok: false, models: [], error: this.readableEncoderError(error) };
    }
  }
  private readableEncoderError(error: unknown): string {
    const message =
      error instanceof Error && error.message ? error.message : "unknown error";
    if (/Invalid URL/i.test(message))
      return "服务地址不是合法的 http(s) 地址，或缺少 /v1 前缀。";
    if (/dimension or values invalid/i.test(message))
      return "返回向量长度与填写的向量维度不一致，请按模型真实输出维度填写。";
    if (/model mismatch/i.test(message))
      return "服务返回的 model 与填写的模型名不一致，请核对模型名。";
    if (/HTTP 401|HTTP 403/i.test(message))
      return "鉴权失败：请确认服务端环境变量 EMBEDDING_API_KEY 已设置且有效。";
    if (/HTTP 404/i.test(message))
      return "接口不存在：确认地址是 OpenAI 兼容基址，且不要包含 /embeddings 后缀。";
    if (/HTTP/i.test(message)) return message + "（服务端拒绝请求）。";
    if (/timed out|timeout/i.test(message))
      return "连接超时：确认服务已启动、地址与端口可达。";
    return message;
  }
}
