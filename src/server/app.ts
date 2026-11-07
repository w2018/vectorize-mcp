import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabasePool } from "./database.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { MemoryService } from "./service.js";
import { registerAdmin } from "./admin.js";
import { createMcpHandler } from "../mcp/http.js";
import { createEmbeddingFromEnv } from "../embedding/openai.js";
import { EmbeddingSecret } from "./embedding-secret.js";
import { APP_VERSION } from "./version.js";
export interface AppOptions {
  databasePath: string;
  passwordHash: string;
  origin: string;
  backupDir: string;
  webRoot?: string;
  embeddingEnv?: NodeJS.ProcessEnv;
  /** 管理员密码哈希文件路径；提供后才能在线修改密码。 */
  passwordFile?: string;
  /** 安装根目录；在线更新在此覆盖程序文件。默认进程工作目录。 */
  updateRoot?: string;
  /**
   * 界面保存的编码器 API Key 落盘位置（加密文件 + 独立密钥）。
   * 缺省时退回环境变量 EMBEDDING_API_KEY，设置页不显示输入框。
   */
  embeddingSecretPaths?: { configPath: string; keyPath: string };
}
export async function buildApp(options: AppOptions) {
  const unlock = await acquireInstanceLock(options.databasePath);
  let db: DatabasePool;
  try {
    db = await DatabasePool.open(options.databasePath);
  } catch (error) {
    await unlock();
    throw error;
  }
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30000,
    connectionTimeout: 15000,
    trustProxy: false,
  });
  try {
    await app.register(cookie);
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: "1 minute",
    });
    app.addHook("onSend", async (_request, reply, payload) => {
      reply
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Frame-Options", "DENY")
        .header("Cache-Control", "no-store")
        .header(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
        );
      return payload;
    });
    app.setErrorHandler((error, request, reply) => {
      const e = error as Error & {
        code?: string;
        retryable?: boolean;
        statusCode?: number;
      };
      // @fastify/rate-limit throws a plain Error carrying only statusCode=429,
      // so it must be identified before the generic code derivation (D-09).
      const rateLimited = e.statusCode === 429;
      const code = rateLimited
        ? "RATE_LIMITED"
        : e.code && /^[A-Z][A-Z_]{2,63}$/.test(e.code)
          ? e.code
          : "INTERNAL_ERROR";
      const status = rateLimited
        ? 429
        : code === "UNAUTHENTICATED"
          ? 401
          : code === "FORBIDDEN"
            ? 403
            : code === "NOT_FOUND"
              ? 404
              : code === "OVERLOADED" ||
                  code === "SERVER_BUSY" ||
                  code === "DATABASE_UNAVAILABLE"
                ? 503
                : code.includes("CONFLICT") || code === "SNAPSHOT_STALE"
                  ? 409
                  : e.statusCode && e.statusCode < 500
                    ? e.statusCode
                    : code === "INTERNAL_ERROR"
                      ? 500
                      : 400;
      if (status === 503) reply.header("Retry-After", "1");
      if (rateLimited && !reply.hasHeader("Retry-After"))
        reply.header("Retry-After", "1");
      // db-worker preserves human-readable messages so clients can self-correct;
      // the HTTP layer must not replace them with a bare code (D-06).
      const raw = e.message || code;
      const message =
        status === 500
          ? "服务暂时无法完成操作"
          : rateLimited
            ? "请求过于频繁，请稍后重试"
            : raw.replace(/[\r\n]+/g, " ").slice(0, 300);
      const retryable = rateLimited ? true : (e.retryable ?? false);
      // /mcp is a JSON-RPC endpoint: pre-handler errors (limit, oversized body)
      // must also return a JSON-RPC envelope, not a REST error body (R-03).
      if (request.url.startsWith("/mcp")) {
        reply.code(status).send({
          jsonrpc: "2.0",
          id: null,
          error: {
            code:
              status === 401
                ? -32001
                : status === 403
                  ? -32003
                  : status === 404
                    ? -32601
                    : status === 413
                      ? -32600
                      : status === 429
                        ? -32029
                        : status === 503
                          ? -32000
                          : -32603,
            message,
            data: { code, retryable },
          },
        });
        return;
      }
      reply.code(status).send({
        ok: false,
        error: { code, message, retryable },
        request_id: request.id,
      });
    });
    const env = options.embeddingEnv ?? process.env;
    const encoder = createEmbeddingFromEnv(env);
    const config = await db.read<import("../core/types.js").Config>(
      "startup",
      "getConfig",
    );
    // v0.5.0 one-shot migration (report D-02): the legacy default
    // tokenBudget=600 is exhausted by a single memory, so limit=3 was
    // unreachable and hit@3 collapsed onto hit@1. Both migrations are keyed on
    // the CURRENT value (not on config.revision), so they are idempotent and do
    // not shadow each other; they share one updateConfig call.
    const patch: Record<string, string | number> = {};
    if (config.tokenBudget === 600) patch.tokenBudget = 1200;
    // v0.5.2: the lexical threshold used to be clamped by min(value, 0.2), so a
    // stored 0.5 behaved exactly like 0.2. Now that the clamp is gone, migrate
    // the legacy default so existing installs keep their observed recall.
    if (config.lexicalThreshold === 0.5) patch.lexicalThreshold = 0.2;
    // Encoder settings from the environment are filled in at any revision;
    // gating on revision===1 used to silently defeat this after any config edit.
    if (encoder && !config.embeddingModel && !config.embeddingBaseUrl) {
      patch.embeddingModel = encoder.descriptor.model;
      patch.embeddingBaseUrl = env.EMBEDDING_BASE_URL!;
      patch.embeddingDimension = encoder.descriptor.dimension;
    }
    if (Object.keys(patch).length) {
      try {
        const preview = await db.write<{ preview_token: string }>(
          "startup",
          "previewConfig",
          patch,
        );
        await db.write("startup", "updateConfig", {
          expected_revision: config.revision,
          preview_token: preview.preview_token,
          patch,
        });
      } catch (error) {
        // A failed migration must not prevent startup; it retries on next boot.
        console.warn("[startup] config migration skipped:", error);
      }
    }
    const secret = options.embeddingSecretPaths
      ? new EmbeddingSecret(
          options.embeddingSecretPaths.configPath,
          options.embeddingSecretPaths.keyPath,
          env,
        )
      : null;
    const service = new MemoryService(db, null, env, secret);
    const mcp = createMcpHandler(service);
    app.route({
      method: ["GET", "POST", "DELETE"],
      url: "/mcp",
      bodyLimit: 1024 * 1024,
      handler: async (request, reply) => {
        const origin = request.headers.origin;
        if (origin && origin !== options.origin) {
          // 允许本机回环地址访问（浏览器用 localhost/127.0.0.1 打开本服务时，
          // Origin 与外网 PUBLIC_ORIGIN 不同但仍是同源请求）。其余跨站一律拒绝。
          let allowed = false;
          try {
            const parsed = new URL(origin);
            const host = request.headers.host;
            // 同 Host 即同源：本机、局域网 IP、内网域名都放行；不再硬编码回环地址。
            allowed = host
              ? parsed.host.toLowerCase() === host.toLowerCase()
              : parsed.origin === options.origin;
          } catch {
            allowed = false;
          }
          if (!allowed)
            return reply.code(403).send({ error: "Origin not allowed" });
        }
        reply.hijack();
        await mcp(request.raw, reply.raw, request.body);
      },
    });
    await registerAdmin(app, db, {
      passwordHash: options.passwordHash,
      secureCookie: options.origin.startsWith("https:"),
      backupDir: options.backupDir,
      origin: options.origin,
      passwordFile: options.passwordFile,
      updateRoot: options.updateRoot,
      testEncoder: (input) => service.testEncoder(input),
      listEncoderModels: (input) => service.listModels(input),
      keyStatus: () => service.keyStatus(),
      saveKey: (apiKey) => service.saveKey(apiKey),
    });
    app.get("/health", async () => ({ ok: true, version: APP_VERSION }));
    const webRoot = resolve(options.webRoot ?? "dist/web");
    if (existsSync(webRoot)) {
      await app.register(staticFiles, { root: webRoot });
      app.setNotFoundHandler((req, reply) =>
        req.url.startsWith("/api/") || req.url.startsWith("/mcp")
          ? reply
              .code(404)
              .send({
                ok: false,
                error: { code: "NOT_FOUND", message: "接口不存在" },
              })
          : reply.sendFile("index.html"),
      );
    }
    let draining = false;
    const timer = setInterval(() => {
      if (draining) return;
      draining = true;
      void db
        .write("maintenance", "drainOutbox", 100)
        .catch(() => {})
        .finally(() => {
          draining = false;
        });
    }, 1000);
    timer.unref();
    let indexJob: Promise<unknown> | undefined;
    const indexTimer = setInterval(() => {
      if (indexJob) return;
      indexJob = service
        .reindexBatch(10)
        .catch(() => {})
        .finally(() => {
          indexJob = undefined;
        });
    }, 5000);
    indexTimer.unref();
    app.addHook("onClose", async () => {
      clearInterval(timer);
      clearInterval(indexTimer);
      try {
        await indexJob;
        await db.close();
      } finally {
        await unlock();
      }
    });
    await app.ready();
    return { app, db, service };
  } catch (e) {
    await app.close().catch(() => {});
    await db.close().catch(() => {});
    await unlock();
    throw e;
  }
}
