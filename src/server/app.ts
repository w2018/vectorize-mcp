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
export interface ServerSettingsContext {
  path: string;
  bindHost: string;
  port: number;
  /** 环境变量 PUBLIC_ORIGIN 覆盖值（非空时后台改设置不会立即生效）。 */
  originOverride: string | null;
  /** 环境变量 HOST 覆盖值（非空时后台改设置不会立即生效）。 */
  hostOverride: string | null;
}
export interface AppOptions {
  databasePath: string;
  passwordHash: string;
  origin: string;
  backupDir: string;
  webRoot?: string;
  embeddingEnv?: NodeJS.ProcessEnv;
  /** 管理员密码哈希文件路径；提供后才能在线修改密码。 */
  passwordFile?: string;
  /** 监听地址设置上下文；提供后才能在线切换监听地址。 */
  serverSettings?: ServerSettingsContext;
  /** 安装根目录；在线更新在此覆盖程序文件。默认进程工作目录。 */
  updateRoot?: string;
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
      const code =
        e.code && /^[A-Z][A-Z_]{2,63}$/.test(e.code)
          ? e.code
          : "INTERNAL_ERROR";
      const status =
        code === "UNAUTHENTICATED"
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
      reply
        .code(status)
        .send({
          ok: false,
          error: {
            code,
            message: status === 500 ? "服务暂时无法完成操作" : code,
            retryable: e.retryable ?? false,
          },
          request_id: request.id,
        });
    });
    const env = options.embeddingEnv ?? process.env;
    const encoder = createEmbeddingFromEnv(env);
    const config = await db.read<import("../core/types.js").Config>(
      "startup",
      "getConfig",
    );
    if (
      encoder &&
      config.revision === 1 &&
      !config.embeddingModel &&
      !config.embeddingBaseUrl
    ) {
      const patch = {
        embeddingModel: encoder.descriptor.model,
        embeddingBaseUrl: env.EMBEDDING_BASE_URL!,
        embeddingDimension: encoder.descriptor.dimension,
      };
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
    }
    const service = new MemoryService(db, null, env);
    const mcp = createMcpHandler(service);
    app.route({
      method: ["GET", "POST", "DELETE"],
      url: "/mcp",
      bodyLimit: 65536,
      handler: async (request, reply) => {
        const origin = request.headers.origin;
        if (origin && origin !== options.origin)
          return reply.code(403).send({ error: "Origin not allowed" });
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
      serverSettings: options.serverSettings,
      updateRoot: options.updateRoot,
    });
    app.get("/health", async () => ({ ok: true }));
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
