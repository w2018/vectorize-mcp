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
  type SimilarityGroup,
  type MaintenanceJob,
} from "../core/types.js";
import {
  OpenAIEmbedding,
  type EmbeddingDescriptor,
} from "../embedding/openai.js";
import { toolSchemas, type ToolName } from "../mcp/schemas.js";
import type { McpService } from "../mcp/http.js";
import { EmbeddingSecret } from "./embedding-secret.js";
import { ChatModel } from "./llm.js";

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
    semanticSearch: boolean;
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
      // 语义检索默认关闭：编码器只服务于「记忆整理 → 重建相似关系」的批量向量计算。
      semanticSearch: config?.semanticSearch === true,
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
  private async encoder(force = false): Promise<EmbeddingProvider | null> {
    const config = await this.effectiveEmbeddingConfig();
    // force 用于「重建相似关系」这类显式需要向量的场景；普通检索与写入在
    // semanticSearch 关闭时一律不触碰编码器（不配置也能正常写入与检索）。
    if (!force && !config.semanticSearch) return null;
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
    force = false,
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
      const embedding = await this.encoder(force);
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
          const current = await this.encoder(force);
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
  /**
   * 为「重建相似关系」批量补齐向量。与后台 reindexBatch 不同：这里无视 semanticSearch
   * 开关、一次性把全部缺失/过期的向量编码完，并在无可用的向量编码器时给出明确错误。
   */
  async ensureVectors(): Promise<{
    attempted: number;
    stored: number;
    failed: number;
  }> {
    const embedding = await this.encoder(true);
    if (!embedding)
      throw new DomainError(
        "VALIDATION_ERROR",
        "未配置可用的向量编码器，无法按语义重建相似关系。请先在「记忆整理」页填写服务地址、模型和维度，或改用词法依据。",
      );
    if (this.reindexRunning)
      throw new DomainError("OVERLOADED", "向量回填正在进行，请稍后再试。");
    this.reindexRunning = true;
    try {
      const model = this.identity(embedding);
      let attempted = 0;
      let stored = 0;
      let failed = 0;
      let cursor = "";
      for (;;) {
        const items = await this.database.read<
          Array<{
            subject_id: string;
            id: string;
            revision: number;
            content: string;
          }>
        >("reindex", "pendingEmbeddings", 50, model, cursor);
        if (!items.length) break;
        for (const item of items) {
          cursor = item.id;
          attempted++;
          try {
            const ctx = await this.database.read<Context>(
              "reindex",
              "adminFor",
              item.subject_id,
            );
            const vector = await embedding.embed(item.content);
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
      }
      return { attempted, stored, failed };
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
    if (tool === "memory_search") {
      const semanticDisabled = !(await this.effectiveEmbeddingConfig())
        .semanticSearch;
      result = await this.search(
        ctx,
        input as SearchInput,
        embedding,
        semanticDisabled,
      );
    }
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
    semanticDisabled = false,
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
    } else if (semanticDisabled)
      // 语义检索是可选的「记忆整理」能力：关闭时检索就是纯词法，属于正常状态，
      // 不能报「未配置/降级」这类让用户以为出错的警告。
      warning = undefined;
    else if (this.encoderFailure)
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
  /** 通用对话模型配置：只用于「记忆整理」，与向量编码无关。 */
  async effectiveModelConfig(): Promise<{
    enabled: boolean;
    baseUrl: string;
    model: string;
  }> {
    const config = await this.database.read<Config>("model-config", "getConfig");
    const baseUrl = (config?.llmBaseUrl ?? "").trim() || (this.env.EMBEDDING_BASE_URL ?? "");
    const model = (config?.llmModel ?? "").trim() || (this.env.EMBEDDING_MODEL ?? "");
    return { enabled: Boolean(baseUrl && model), baseUrl, model };
  }
  private chatModel(baseUrl: string, model: string, apiKey?: string): ChatModel {
    return new ChatModel({
      baseUrl,
      model,
      apiKey: apiKey?.trim() || this.apiKey() || undefined,
      timeoutMs: Number(this.env.EMBEDDING_TIMEOUT_MS ?? 60000),
    });
  }
  /** 设置页「测试连接」：用草稿配置真实发一条 chat，验证地址、模型名与密钥。 */
  async testModel(input: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; model: string; elapsed_ms: number; error?: string }> {
    const started = Date.now();
    try {
      const model = this.chatModel(input.baseUrl, input.model, input.apiKey);
      const reply = await model.chat(
        [{ role: "user", content: "请只回复两个字：正常" }],
        256,
      );
      return {
        ok: true,
        model: input.model,
        elapsed_ms: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        model: input.model,
        elapsed_ms: Date.now() - started,
        error: this.readableModelError(error),
      };
    }
  }
  /**
   * 拉取该服务提供的模型列表（OpenAI 兼容 GET /models）。
   * 通用对话模型不需要能力探测：列表里的模型都可以直接用于记忆整理。
   */
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
      return { ok: false, models: [], error: this.readableModelError(error) };
    }
  }
  /**
   * 用通用对话模型判断候选记忆是否相似，并据此重建相似关系（basis=llm）。
   * 只做「文本相关性判断」，不计算任何向量。
   */
  async rebuildSimilarityWithModel(subjectId: string): Promise<{
    memories: number;
    candidates: number;
    judged: number;
    similar: number;
    truncated: boolean;
    basis: "llm";
  }> {
    const config = await this.effectiveModelConfig();
    if (!config.enabled)
      throw new DomainError(
        "FEATURE_DISABLED",
        "尚未配置通用模型；请在「记忆整理」页填写模型服务地址与模型名后再重建。",
      );
    const model = this.chatModel(config.baseUrl, config.model);
    const candidates = await this.database.read<{
      memories: number;
      candidates: number;
      truncated: boolean;
      pairs: { a: string; b: string; similarity: number; aText: string; bText: string }[];
    }>("similarity-candidates", "similarityCandidates", subjectId);
    const accepted: { a: string; b: string; similarity: number }[] = [];
    const batchSize = 10;
    for (let i = 0; i < candidates.pairs.length; i += batchSize) {
      const batch = candidates.pairs.slice(i, i + batchSize);
      const listing = batch
        .map(
          (pair, index) =>
            "[" +
            index +
            "] A:" +
            pair.aText.replace(/\s+/g, " ").slice(0, 200) +
            "\n    B:" +
            pair.bText.replace(/\s+/g, " ").slice(0, 200),
        )
        .join("\n");
      const prompt =
        "下面是从记忆库中召回的可能相关的记忆对。请判断每一对是否在讲同一件事或高度相关（例如同一个人、同一个项目、同一偏好）。" +
        "只输出一个 JSON 数组，不要解释。数组元素形如 {\"i\":序号,\"similar\":true或false,\"score\":0到1的小数}。\n" +
        listing;
      let verdicts: { i?: unknown; similar?: unknown; score?: unknown }[] = [];
      try {
        const reply = await model.chat(
          [
            { role: "system", content: "你是严谨的记忆库整理助手，只输出 JSON。" },
            { role: "user", content: prompt },
          ],
          2048,
        );
        const first = reply.indexOf("[");
        const last = reply.lastIndexOf("]");
        if (first >= 0 && last > first) {
          const parsed: unknown = JSON.parse(reply.slice(first, last + 1));
          if (Array.isArray(parsed))
            verdicts = parsed as { i?: unknown; similar?: unknown; score?: unknown }[];
        }
      } catch {
        // 单批失败不影响其它批：这一批视为「无法判定」，不生成关系。
        continue;
      }
      for (const verdict of verdicts) {
        const index = Number(verdict.i);
        if (!Number.isInteger(index) || index < 0 || index >= batch.length) continue;
        if (verdict.similar !== true) continue;
        const score = Number(verdict.score);
        const pair = batch[index]!;
        accepted.push({
          a: pair.a,
          b: pair.b,
          similarity: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0.8,
        });
      }
    }
    const applied = await this.database.write<{ pairs: number }>(
      "similarity-apply",
      "applySimilarityPairs",
      subjectId,
      accepted,
      "similarity-llm-v1",
    );
    return {
      memories: candidates.memories,
      candidates: candidates.candidates,
      judged: candidates.pairs.length,
      similar: applied.pairs,
      truncated: candidates.truncated,
      basis: "llm",
    };
  }
  /** 启动时把上次残留的 queued/running 任务标记为 interrupted。 */
  async interruptStaleJobs(): Promise<number> {
    return this.database.write<number>("jobs", "markStaleJobsInterrupted");
  }
  async listSimilarityGroups(
    subjectId: string,
    filters: { status?: string; limit?: number; offset?: number },
  ) {
    return this.database.read("groups", "listSimilarityGroups", subjectId, filters);
  }
  async getSimilarityGroup(subjectId: string, id: string) {
    return this.database.read("groups", "getSimilarityGroup", subjectId, id);
  }
  async ignoreSimilarityGroups(subjectId: string, ids: string[]) {
    return this.database.write("groups", "ignoreSimilarityGroups", subjectId, ids);
  }
  async getMaintenanceJob(jobId: string) {
    return this.database.read("jobs", "getMaintenanceJob", jobId);
  }
  async startRebuildGroupsJob(
    subjectId: string,
    options: { limit?: number; groupThreshold?: number } = {},
  ) {
    const job = await this.database.write<MaintenanceJob>(
      "jobs",
      "createMaintenanceJob",
      subjectId,
      "rebuild_groups",
      options,
    );
    void this.runRebuildGroupsJob(job.id, subjectId, options);
    return job;
  }
  private async runRebuildGroupsJob(
    jobId: string,
    subjectId: string,
    options: { limit?: number; groupThreshold?: number },
  ): Promise<void> {
    try {
      await this.database.write("jobs", "updateMaintenanceJob", jobId, {
        status: "running",
        total: 1,
      });
      const result = await this.database.write<{
        memories: number;
        candidates: number;
        groups: number;
        truncated: boolean;
      }>("groups", "rebuildSimilarityGroups", subjectId, options);
      await this.database.write("jobs", "updateMaintenanceJob", jobId, {
        status: "done",
        done: 1,
        result,
      });
    } catch (error) {
      await this.database
        .write("jobs", "updateMaintenanceJob", jobId, {
          status: "failed",
          error: error instanceof Error ? error.message : "建组任务失败",
        })
        .catch(() => {});
    }
  }
  /** 生成一个分组的合并稿（不写库）。 */
  async previewMergeGroup(subjectId: string, groupId: string): Promise<{
    group_id: string;
    title?: string;
    content: string;
    type: string;
    keywords: string[];
    importance?: number;
    reason: string;
  }> {
    const group = await this.database.read<SimilarityGroup | null>(
      "groups",
      "getSimilarityGroup",
      subjectId,
      groupId,
    );
    if (!group) throw new DomainError("NOT_FOUND");
    return this.buildMergeDraft(subjectId, group);
  }
  private async buildMergeDraft(
    subjectId: string,
    group: SimilarityGroup,
  ): Promise<{
    group_id: string;
    title?: string;
    content: string;
    type: string;
    keywords: string[];
    importance?: number;
    reason: string;
  }> {
    const config = await this.effectiveModelConfig();
    if (!config.enabled)
      throw new DomainError(
        "FEATURE_DISABLED",
        "尚未配置通用模型；请先在「记忆整理」页填写模型服务地址与模型名。",
      );
    const members = group.members ?? [];
    if (members.length < 2) throw new DomainError("GROUP_TOO_SMALL");
    const model = this.chatModel(config.baseUrl, config.model);
    const listing = members
      .map(
        (m, index) =>
          "[" +
          index +
          "] id=" +
          m.memory_id +
          "\n    标题:" +
          (m.title ?? "(无)") +
          "\n    类型:" +
          (m.type ?? "") +
          "\n    正文:" +
          String(m.content ?? "").slice(0, 500),
      )
      .join("\n");
    const prompt =
      "下面是同一账户下被判定为高度相似的一组记忆。请把它们压缩合并成一条更精炼、信息完整的记忆。" +
      "只能使用给出的记忆内容，不要编造新事实；如果不同记忆之间存在矛盾（如不同数字、日期），请在 reason 中说明并保留更可信的一条。" +
      "只输出 JSON，不要解释，格式：{\"title\":\"\",\"content\":\"\",\"type\":\"\",\"keywords\":[\"\"],\"importance\":1到99,\"reason\":\"\"}。" +
      "type 必须与组内类型一致。\n" +
      listing;
    const reply = await model.chat(
      [
        { role: "system", content: "你是严谨的记忆库整理助手，只输出 JSON。" },
        { role: "user", content: prompt },
      ],
      2048,
    );
    const first = reply.indexOf("{");
    const last = reply.lastIndexOf("}");
    if (first < 0 || last <= first) throw new DomainError("MODEL_INVALID", "模型没有返回合法 JSON。");
    let parsed: {
      title?: unknown;
      content?: unknown;
      type?: unknown;
      keywords?: unknown;
      importance?: unknown;
      reason?: unknown;
    };
    try {
      parsed = JSON.parse(reply.slice(first, last + 1));
    } catch {
      throw new DomainError("MODEL_INVALID", "模型返回的 JSON 无法解析。");
    }
    const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
    if (!content) throw new DomainError("MODEL_INVALID", "模型没有返回合并后的正文。");
    const type = typeof parsed.type === "string" ? parsed.type : (members[0]?.type ?? "fact");
    if (!["fact", "preference", "project", "lesson"].includes(type))
      throw new DomainError("MODEL_INVALID", "模型返回的类型不在允许合并的范围内。");
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.filter((k): k is string => typeof k === "string").slice(0, 12)
      : [];
    const importance = Number(parsed.importance);
    void subjectId;
    return {
      group_id: group.id,
      title: typeof parsed.title === "string" ? parsed.title.slice(0, 200) : undefined,
      content,
      type,
      keywords,
      importance: Number.isFinite(importance) ? Math.max(1, Math.min(99, importance)) : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : "",
    };
  }
  async startMergeGroupsJob(
    subjectId: string,
    groupIds: string[],
  ): Promise<MaintenanceJob> {
    const job = await this.database.write<MaintenanceJob>(
      "jobs",
      "createMaintenanceJob",
      subjectId,
      "merge_groups",
      { group_ids: groupIds },
    );
    void this.runMergeGroupsJob(job.id, subjectId, groupIds);
    return job;
  }
  private async runMergeGroupsJob(
    jobId: string,
    subjectId: string,
    groupIds: string[],
  ): Promise<void> {
    const detail: {
      group_id: string;
      target_id: string;
      new_revision: number;
      archived: { id: string; revision: number }[];
    }[] = [];
    const skipped: { group_id: string; reason: string }[] = [];
    try {
      await this.database.write("jobs", "updateMaintenanceJob", jobId, {
        status: "running",
        total: groupIds.length,
      });
      const ctx = await this.database.read<Context>("ctx", "adminFor", subjectId);
      for (let i = 0; i < groupIds.length; i++) {
        const groupId = groupIds[i]!;
        const job = await this.database.read<MaintenanceJob | null>(
          "jobs",
          "getMaintenanceJob",
          jobId,
        );
        if (job?.status === "cancelled") break;
        const group = await this.database.read<SimilarityGroup | null>(
          "groups",
          "getSimilarityGroup",
          subjectId,
          groupId,
        );
        if (!group || (group.status !== "proposed" && group.status !== "ignored")) {
          skipped.push({ group_id: groupId, reason: "分组状态已变化" });
        } else {
          try {
            const draft = await this.buildMergeDraft(subjectId, group);
            const merged = await this.database.write<{
              group_id: string;
              target_id: string;
              archived: { id: string; revision: number }[];
              revision: number;
            }>("groups", "mergeSimilarityGroup", ctx, groupId, draft.content);
            detail.push({
              group_id: merged.group_id,
              target_id: merged.target_id,
              new_revision: merged.revision,
              archived: merged.archived,
            });
          } catch (error) {
            skipped.push({
              group_id: groupId,
              reason: error instanceof Error ? error.message : "合并失败",
            });
          }
        }
        await this.database.write("jobs", "updateMaintenanceJob", jobId, {
          done: i + 1,
          total: groupIds.length,
        });
      }
      let batchId: string | undefined;
      if (detail.length)
        batchId = (
          await this.database.write<{ id: string }>(
            "batches",
            "createMergeBatch",
            subjectId,
            jobId,
            detail,
          )
        ).id;
      const finalJob = await this.database.read<MaintenanceJob | null>(
        "jobs",
        "getMaintenanceJob",
        jobId,
      );
      if (finalJob?.status !== "cancelled")
        await this.database.write("jobs", "updateMaintenanceJob", jobId, {
          status: "done",
          done: groupIds.length,
          total: groupIds.length,
          result: { batch_id: batchId, merged: detail.length, skipped },
        });
    } catch (error) {
      await this.database
        .write("jobs", "updateMaintenanceJob", jobId, {
          status: "failed",
          error: error instanceof Error ? error.message : "合并任务失败",
          result: { batch_id: undefined, merged: detail.length, skipped },
        })
        .catch(() => {});
    }
  }
  async cancelMaintenanceJob(jobId: string) {
    const job = await this.database.read<MaintenanceJob | null>("jobs", "getMaintenanceJob", jobId);
    if (!job) throw new DomainError("NOT_FOUND");
    if (job.status !== "queued" && job.status !== "running")
      throw new DomainError("JOB_STATUS", "该任务已结束，无法取消。");
    return this.database.write("jobs", "updateMaintenanceJob", jobId, { status: "cancelled" });
  }
  async undoMergeBatch(subjectId: string, batchId: string) {
    return this.database.write("undo", "undoMergeBatch", subjectId, batchId);
  }
  async compactPreview(subjectId: string) {
    return this.database.read("compact", "compactPreview", subjectId);
  }
  async compactArchivedVersions(subjectId: string) {
    return this.database.write("compact", "compactArchivedVersions", subjectId);
  }
  private readableModelError(error: unknown): string {
    const message =
      error instanceof Error && error.message ? error.message : "unknown error";
    if (/Invalid URL/i.test(message))
      return "服务地址不是合法的 http(s) 地址，或缺少 /v1 前缀。";
    if (/HTTP 401|HTTP 403/i.test(message))
      return "鉴权失败：请确认密钥已填写（界面保存或 EMBEDDING_API_KEY），且对该服务有效。";
    if (/HTTP 404/i.test(message))
      return "接口不存在：确认地址是 OpenAI 兼容基址，且不要包含 /chat/completions 后缀。";
    if (/HTTP/i.test(message)) return message + "（服务端拒绝请求）。";
    if (/timed out|timeout|abort/i.test(message))
      return "连接超时：确认服务已启动、地址与端口可达。";
    return message;
  }
}

