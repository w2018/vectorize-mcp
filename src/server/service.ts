import { createHash } from "node:crypto";
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
  private reindexCursor = "";
  private reindexRunning = false;
  private adapterCache?: { key: string; provider: EmbeddingProvider };
  constructor(
    private readonly database: ServiceDatabase,
    private readonly fallback: EmbeddingProvider | null = null,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
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
  private async encoder(): Promise<EmbeddingProvider | null> {
    const config = await this.effectiveEmbeddingConfig();
    if (!config.enabled) return null;
    if (!config.baseUrl && this.fallback) return this.fallback;
    const key = JSON.stringify(config);
    if (this.adapterCache?.key === key) return this.adapterCache.provider;
    const provider = new OpenAIEmbedding({
      baseUrl: config.baseUrl,
      model: config.model,
      dimension: config.dimension,
      version:
        config.version +
        ":endpoint:" +
        createHash("sha256").update(config.baseUrl).digest("hex"),
      apiKey: this.env.EMBEDDING_API_KEY,
      timeoutMs: Number(this.env.EMBEDDING_TIMEOUT_MS ?? 15000),
      concurrency: Number(this.env.EMBEDDING_CONCURRENCY ?? 4),
      maxQueue: Number(this.env.EMBEDDING_MAX_QUEUE ?? 64),
    });
    this.adapterCache = { key, provider };
    return provider;
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
      throw new DomainError("VALIDATION_ERROR");
    const parsed = toolSchemas[tool].safeParse(args);
    if (!parsed.success)
      throw new DomainError("VALIDATION_ERROR", "Invalid tool arguments");
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
    else if (tool === "memory_get" || tool === "memory_config_get")
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
      if (replay) {
        await this.validate(ctx);
        return replay;
      }
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
    await this.validate(ctx);
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
      } catch {
        warning =
          "EMBEDDING_UNAVAILABLE: semantic encoding failed; lexical fallback only.";
      }
    } else
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
    await this.validate(ctx);
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
    await this.validate(ctx);
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
}
