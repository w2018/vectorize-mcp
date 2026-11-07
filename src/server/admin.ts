import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  HTTPMethods,
} from "fastify";
import {
  randomBytes,
  randomInt,
  randomUUID,
  createHash,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { createWriteStream, existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { WebdavCloud } from "./webdav.js";
import { APP_VERSION } from "./version.js";
import { hashPassword } from "./password.js";
import type { DatabasePool } from "./database.js";
import { BOT_PRESETS } from "../core/catalog.js";
import {
  DomainError,
  type Context,
  type Memory,
  type Preview,
} from "../core/types.js";

type RecordData = Record<string, unknown>;
interface Session {
  id: string;
  csrf: string;
  authenticated: boolean;
  expires: number;
}
interface StagedImport {
  session: string;
  subject: string;
  payload: unknown;
  bytes: number;
  expires: number;
}
const COOKIE = "vmcp_admin";
const SESSION_MS = 8 * 60 * 60 * 1000;
const IMPORT_MAX = 100 * 1024 * 1024;
function object(value: unknown): RecordData {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError("VALIDATION_ERROR");
  return value as RecordData;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048)
    throw new DomainError("VALIDATION_ERROR");
  return value;
}
function optionalText(value: unknown, max = 200): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > max)
    throw new DomainError("VALIDATION_ERROR");
  return value.trim();
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new DomainError("VALIDATION_ERROR");
  return n;
}
/** MCP 路径把任意文本 request_id 确定性映射为合法 UUID；管理端保持一致，避免
 * 客户端传词而非 UUID 时被 store.ts:699 / :1835 的 uuid() 拒绝。 */
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requestId(value: unknown): string {
  const raw = text(value).trim();
  if (REQUEST_ID_PATTERN.test(raw)) return raw.toLowerCase();
  const bytes = [...createHash("sha256").update(raw).digest().subarray(0, 16)];
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function revision(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new DomainError("VALIDATION_ERROR");
  return n;
}
function tokenBudget(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 128 || n > 1200)
    throw new DomainError("VALIDATION_ERROR");
  return n;
}
function withinAllowed(target: string, backupDir: string): boolean {
  const path = resolve(target);
  return [resolve(backupDir), resolve(tmpdir())].some(
    (dir) => path === dir || path.startsWith(dir + sep),
  );
}
function offset(value: unknown): number {
  if (value === undefined || value === "") return 0;
  try {
    const s = Buffer.from(text(value), "base64url").toString();
    if (!/^\d+$/.test(s)) throw 0;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 0 || n > 10000000) throw 0;
    return n;
  } catch {
    throw new DomainError("VALIDATION_ERROR");
  }
}
const cursor = (n: number) => Buffer.from(String(n)).toString("base64url");
function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "ok" in value && "data" in value)
    return (value as { data: unknown }).data;
  return value;
}
async function verify(password: unknown, encoded: string): Promise<boolean> {
  if (typeof password !== "string" || password.length > 1024) return false;
  const [salt, hash] = encoded.split(":");
  if (
    !salt ||
    !hash ||
    !/^[a-f0-9]{32}$/i.test(salt) ||
    !/^[a-f0-9]{128}$/i.test(hash)
  )
    return false;
  const actual = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, Buffer.from(salt, "hex"), 64, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

export async function registerAdmin(
  app: FastifyInstance,
  db: DatabasePool,
  options: {
    passwordHash: string;
    secureCookie: boolean;
    backupDir: string;
    origin: string;
    passwordFile?: string;
    /** 安装根目录（源码与 dist 所在），在线更新会在此目录内覆盖程序文件。 */
    updateRoot?: string;
    /** 通用对话模型连通性测试；缺省时该路由返回 FEATURE_DISABLED。 */
    testModel?: (input: {
      baseUrl: string;
      model: string;
      apiKey?: string;
    }) => Promise<{ ok: boolean; model: string; elapsed_ms: number; error?: string }>;
    /** 拉取模型服务的模型列表（GET {baseUrl}/models）。 */
    listEncoderModels?: (input: {
      baseUrl: string;
      apiKey?: string;
    }) => Promise<{ ok: boolean; models: string[]; error?: string }>;
    /** 只返回 has_key / source，绝不回显明文。 */
    keyStatus?: () => { has_key: boolean; source: "file" | "env" | "none" };
    /** 保存或清除界面输入的 API Key（空串=清除）。 */
    saveKey?: (
      apiKey: string,
    ) => { has_key: boolean; source: "file" | "env" | "none" };
    /** 用通用对话模型判断相似关系并重建（basis=llm）。 */
    rebuildSimilarityWithModel?: (subjectId: string) => Promise<{
      memories: number;
      candidates: number;
      judged: number;
      similar: number;
      truncated: boolean;
      basis: "llm";
    }>;
    /** v0.6.2 相似分组 / 压缩去重合并 / 空间回收。 */
    maintenance?: {
      listGroups(subjectId: string, filters: { status?: string; limit?: number; offset?: number }): Promise<unknown>;
      getGroup(subjectId: string, id: string): Promise<unknown>;
      ignoreGroups(subjectId: string, ids: string[]): Promise<unknown>;
      rebuildGroups(
        subjectId: string,
        options: { limit?: number; groupThreshold?: number; basis?: "lexical" | "llm" },
      ): Promise<unknown>;
      previewMerge(subjectId: string, groupId: string): Promise<unknown>;
      startMerge(subjectId: string, groupIds: string[]): Promise<unknown>;
      getJob(jobId: string): Promise<unknown>;
      getActiveJob(subjectId: string): Promise<unknown>;
      cancelJob(jobId: string): Promise<unknown>;
      undoBatch(subjectId: string, batchId: string, groupIds?: string[]): Promise<unknown>;
      getBatch(subjectId: string, batchId: string): Promise<unknown>;
      listBatches(subjectId: string, limit?: number): Promise<unknown>;
      compactPreview(subjectId: string): Promise<unknown>;
      compact(subjectId: string): Promise<unknown>;
    };
  },
): Promise<void> {
  const installRoot = resolve(options.updateRoot ?? process.cwd());
  // 允许在线改密：内存中的哈希随修改更新，后续登录立即使用新密码。
  let passwordHash = options.passwordHash;
  const sessions = new Map<string, Session>();
  const imports = new Map<string, StagedImport>();
  let stagedBytes = 0;
  const origin = new URL(options.origin).origin;
  const loopback = (host: string) =>
    ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host.toLowerCase());
  // 浏览器用 localhost / [::1] / 不同端口访问本机服务时，Origin 与 PUBLIC_ORIGIN 不同，
  // 但请求 Host 与 Origin 主机一致即视为同源，避免误判为跨站请求。
  const originAllowed = (
    header: string | undefined,
    host: string | undefined,
  ) => {
    if (header === undefined) return false;
    if (header === origin) return true;
    let parsed: URL;
    try {
      parsed = new URL(header);
    } catch {
      return false;
    }
    if (parsed.origin === origin) return true;
    // 同 Host（含局域网 IP、内网域名、反代域名）即视为同源；不再限制回环地址。
    if (host) return parsed.host.toLowerCase() === host.toLowerCase();
    return loopback(parsed.hostname);
  };
  const dropImport = (key: string) => {
    const entry = imports.get(key);
    if (entry) {
      stagedBytes -= entry.bytes;
      imports.delete(key);
    }
  };
  const cleanup = () => {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.expires <= now) sessions.delete(id);
    for (const [key, p] of imports)
      if (p.expires <= now || !sessions.has(p.session)) dropImport(key);
  };
  const timer = setInterval(cleanup, 60000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    sessions.clear();
    imports.clear();
  });
  const current = (req: FastifyRequest) => {
    const id = req.cookies[COOKIE];
    const s = id ? sessions.get(id) : undefined;
    return s && s.expires > Date.now() ? s : undefined;
  };
  // R-02: app.ts 设 trustProxy:false，x-forwarded-proto 是客户端可伪造的裸头；
  // 用它决定 Secure 会让明文请求被浏览器丢弃会话 cookie（self-DoS）。
  // 只信服务端启动配置 options.origin 与实际 socket 协议。
  const secureCookieFor = (req: FastifyRequest) =>
    options.secureCookie || req.protocol === "https";
  const issue = (reply: FastifyReply, authenticated: boolean, req: FastifyRequest) => {
    cleanup();
    if (sessions.size >= 10000) throw new DomainError("SERVER_BUSY");
    const s = {
      id: randomBytes(32).toString("base64url"),
      csrf: randomBytes(32).toString("base64url"),
      authenticated,
      expires: Date.now() + SESSION_MS,
    };
    sessions.set(s.id, s);
    reply.setCookie(COOKIE, s.id, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookieFor(req),
      maxAge: SESSION_MS / 1000,
    });
    return s;
  };
  const read = <T = unknown>(method: string, ...args: unknown[]) =>
    db.read<T>("admin", method, ...args);
  const write = <T = unknown>(method: string, ...args: unknown[]) =>
    db.write<T>("admin", method, ...args);
  const query = (req: FastifyRequest) => object(req.query);
  const body = (req: FastifyRequest) => object(req.body);
  const param = (req: FastifyRequest) => text(object(req.params).id);
  const subject = (values: RecordData) => text(values.subject_id);
  const versionRefs = (value: unknown) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100)
      throw new DomainError("VALIDATION_ERROR");
    for (const item of value) {
      const ref = object(item);
      text(ref.id);
      if (!Number.isSafeInteger(ref.revision) || Number(ref.revision) < 1)
        throw new DomainError("VALIDATION_ERROR");
    }
    return value;
  };
  const trashIds = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 200)
      throw new DomainError("VALIDATION_ERROR");
    return value.map(text);
  };
  const route = (
    method: HTTPMethods,
    path: string,
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    extra: RecordData = {},
  ) => {
    app.route({
      method,
      url: "/api/v1" + path,
      ...extra,
      onRequest: async (req, reply) => {
        reply.header("Cache-Control", "no-store");
        const s = current(req);
        if (
          !["/auth/session", "/auth/login"].includes(path) &&
          !s?.authenticated
        )
          throw new DomainError("UNAUTHENTICATED");
        if (method !== "GET" && method !== "HEAD") {
          if (!originAllowed(req.headers.origin, req.headers.host)) {
            app.log.warn(
              { origin: req.headers.origin, host: req.headers.host, expected: origin },
              "rejected cross-origin write",
            );
            throw new DomainError("FORBIDDEN");
          }
          const token = req.headers["x-csrf-token"];
          if (
            !s ||
            typeof token !== "string" ||
            Buffer.byteLength(token) !== Buffer.byteLength(s.csrf) ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(s.csrf))
          )
            throw new DomainError("FORBIDDEN");
        }
      },
      handler: async (req, reply) => ({
        ok: true,
        data: unwrap(await handler(req, reply)),
      }),
    });
  };
  route("GET", "/auth/session", async (req, reply) => {
    const s = current(req) ?? issue(reply, false, req);
    return { authenticated: s.authenticated, csrf_token: s.csrf };
  });
  route(
    "POST",
    "/auth/login",
    async (req, reply) => {
      if (!(await verify(body(req).password, passwordHash)))
        throw new DomainError("UNAUTHENTICATED");
      const prior = current(req);
      if (prior) sessions.delete(prior.id);
      const s = issue(reply, true, req);
      return { authenticated: true, csrf_token: s.csrf };
    },
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
  );
  route("POST", "/auth/logout", async (req, reply) => {
    sessions.delete(current(req)!.id);
    cleanup();
    reply.clearCookie(COOKIE, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookieFor(req),
    });
    return { authenticated: false };
  });
  const writePasswordFile = async (file: string, hash: string) => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    await writeFile(tmp, JSON.stringify({ hash }), { mode: 0o600 });
    await rename(tmp, file);
  };
  route(
    "POST",
    "/auth/password",
    async (req, reply) => {
      if (!options.passwordFile) throw new DomainError("FEATURE_DISABLED");
      const b = body(req);
      const currentPassword = text(b.current_password);
      const newPassword = text(b.new_password);
      if (newPassword.length < 8 || newPassword.length > 1024)
        throw new DomainError("VALIDATION_ERROR");
      if (newPassword === currentPassword)
        throw new DomainError("VALIDATION_ERROR");
      if (!(await verify(currentPassword, passwordHash)))
        throw new DomainError("FORBIDDEN");
      const encoded = hashPassword(newPassword);
      await writePasswordFile(options.passwordFile, encoded);
      passwordHash = encoded;
      // 改密后立即吊销全部会话，旧会话不能再操作任何接口。
      sessions.clear();
      reply.clearCookie(COOKIE, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: options.secureCookie,
      });
      return { changed: true, reauthenticate: true };
    },
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
  );
  const paged = (items: unknown[], q: RecordData) => {
    const start = offset(q.cursor),
      limit = integer(q.limit, 100, 100);
    return {
      items: items.slice(start, start + limit),
      total: items.length,
      next_cursor: start + limit < items.length ? cursor(start + limit) : null,
    };
  };
  route("GET", "/trash", async (req) => {
    const q = query(req);
    const start = offset(q.cursor);
    const limit = integer(q.limit, 20, 100);
    const kind = q.kind === undefined || q.kind === "" ? undefined : text(q.kind);
    if (kind !== undefined && kind !== "memory" && kind !== "token")
      throw new DomainError("VALIDATION_ERROR");
    const page = await read<{ items: unknown[]; total: number }>("listTrash", {
      kind,
      offset: start,
      limit,
    });
    return {
      ...page,
      next_cursor: start + limit < page.total ? cursor(start + limit) : null,
    };
  });
  route("GET", "/trash/:id", async (req) => read("trashItem", param(req)));
  route("POST", "/trash/restore-compat", async (req) => {
    const b = body(req);
    return write("restoreTrashCompat", trashIds(b.ids), text(b.target_subject_id));
  });
  route("POST", "/trash/restore", async (req) => {
    const b = body(req);
    return write(
      "restoreTrash",
      trashIds(b.ids),
      text(b.target_subject_id),
      text(b.preview_token),
    );
  });
  route("POST", "/trash/delete", async (req) =>
    write("deleteTrash", trashIds(body(req).ids)),
  );
  const memoryDeletions = new Map<
    string,
    { code: string; session: string; expires: number; attempts: number }
  >();
  route("POST", "/memories/delete-preview", async (req) => {
    const b = body(req);
    const preview = await write<RecordData>(
      "deletePreview",
      subject(b),
      versionRefs(b.items),
      text(b.reason),
    );
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const expires = Date.now() + 300000;
    for (const [key, entry] of memoryDeletions)
      if (entry.expires < Date.now()) memoryDeletions.delete(key);
    memoryDeletions.set(String(preview.preview_token), {
      code,
      session: current(req)!.id,
      expires,
      attempts: 0,
    });
    return { ...preview, code, expires_at: expires };
  });
  route("POST", "/memories/delete", async (req) => {
    const b = body(req);
    const previewToken = text(b.preview_token);
    const entry = memoryDeletions.get(previewToken);
    if (
      !entry ||
      entry.session !== current(req)!.id ||
      entry.expires < Date.now() ||
      entry.attempts >= 5
    ) {
      memoryDeletions.delete(previewToken);
      throw new DomainError("PREVIEW_EXPIRED", "验证码已失效，请重新获取");
    }
    entry.attempts++;
    const given = Buffer.from(text(b.code));
    const expected = Buffer.from(entry.code);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new DomainError("FORBIDDEN", "验证码不正确");
    const result = await write("deleteToTrash", subject(b), {
      items: versionRefs(b.items),
      reason: text(b.reason),
      preview_token: previewToken,
    });
    memoryDeletions.delete(previewToken);
    return result;
  });
  route("POST", "/tokens/:id/delete-preview", async (req) =>
    write("deleteRevokedTokenPreview", param(req)),
  );
  route("POST", "/tokens/:id/delete", async (req) =>
    write("deleteRevokedToken", param(req), text(body(req).preview_token)),
  );
  route("GET", "/stats/accounts", async (req) =>
    read("statsByAccount", integer(query(req).days, 30, 3650)),
  );
  route("GET", "/accounts", async (req) =>
    paged(
      (await read<RecordData[]>("listAccounts")).map((a) => ({
        ...a,
        name: a.label,
        status: a.access_state,
      })),
      query(req),
    ),
  );
  route("GET", "/tokens", async (req) =>
    paged(await read<unknown[]>("listTokens"), query(req)),
  );
  route("POST", "/tokens/:id/reveal", async (req) => {
    const revealed = await write<RecordData | null>("revealToken", param(req));
    if (!revealed)
      throw new DomainError(
        "NOT_FOUND",
        "该凭据没有可查看的明文（旧版本创建），请重新签发后再查看。",
      );
    return revealed;
  });
  route("POST", "/tokens", async (req) => {
    const b = body(req);
    return write(
      "createToken",
      text(b.label),
      b.subject_id === undefined ? undefined : subject(b),
      {
        request_id: requestId(b.request_id),
        preview_token: b.preview_token,
        kind:
          b.kind === undefined
            ? undefined
            : (() => {
                if (b.kind !== "standard" && b.kind !== "qqbot")
                  throw new DomainError("VALIDATION_ERROR");
                return b.kind;
              })(),
        preset_id:
          b.preset_id === undefined ? undefined : text(b.preset_id),
      },
    );
  });
  route("POST", "/tokens/:id/revoke-preview", async (req) =>
    write("revokePreview", param(req)),
  );
  route("POST", "/tokens/:id/revoke", async (req) =>
    write("revokeToken", param(req), text(body(req).preview_token)),
  );
  route("POST", "/tokens/:id/rotate-preview", async (req) =>
    write("rotatePreview", param(req)),
  );
  route("POST", "/tokens/:id/rotate", async (req) =>
    write("rotateToken", param(req), text(body(req).preview_token)),
  );
  route("POST", "/accounts/:id/enable-preview", async (req) =>
    write("enablePreview", param(req)),
  );
  const deletions = new Map<
    string,
    { code: string; session: string; expires: number; attempts: number }
  >();
  route("POST", "/accounts/:id/delete-preview", async (req) => {
    const target = await read<RecordData>("unboundAccount", param(req));
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const expires = Date.now() + 300000;
    deletions.set(String(target.subject_id), {
      code,
      session: current(req)!.id,
      expires,
      attempts: 0,
    });
    return { ...target, code, expires_at: expires };
  });
  route("POST", "/accounts/:id/delete", async (req) => {
    const id = param(req);
    const input = text((req.body as RecordData)?.code);
    const entry = deletions.get(id);
    if (
      !entry ||
      entry.session !== current(req)!.id ||
      entry.expires < Date.now() ||
      entry.attempts >= 5
    ) {
      deletions.delete(id);
      throw new DomainError("PREVIEW_EXPIRED", "验证码已失效，请重新获取");
    }
    entry.attempts++;
    const given = Buffer.from(input);
    const expected = Buffer.from(entry.code);
    if (
      given.length !== expected.length ||
      !timingSafeEqual(given, expected)
    )
      throw new DomainError("FORBIDDEN", "验证码不正确");
    const result = await write<RecordData>("deleteAccount", id);
    deletions.delete(id);
    return result;
  });
  route("GET", "/qqbot/presets", async () => ({ items: BOT_PRESETS }));
  route("GET", "/qqbot", async (req) =>
    read("botProfile", subject(query(req))),
  );
  route("PUT", "/qqbot", async (req) => {
    const b = body(req);
    return write(
      "updateBotProfile",
      subject(b),
      object(b.patch),
      integer(b.expected_revision, 0, Number.MAX_SAFE_INTEGER),
      text(b.reason),
    );
  });
  route("POST", "/qqbot/apply-preset", async (req) => {
    const b = body(req);
    if (b.write_examples !== undefined && typeof b.write_examples !== "boolean")
      throw new DomainError("VALIDATION_ERROR");
    return write(
      "applyBotPreset",
      subject(b),
      text(b.preset_id),
      integer(b.expected_revision, 0, Number.MAX_SAFE_INTEGER),
      b.write_examples === true,
      text(b.reason),
    );
  });
  route("GET", "/qqbot/bootstrap", async (req) => {
    const q = query(req);
    return read(
      "bootstrap",
      subject(q),
      tokenBudget(q.token_budget),
    );
  });
  route("GET", "/memories/:id/similar", async (req) =>
    read("relatedSimilarity", subject(query(req)), param(req)),
  );
  route("POST", "/maintenance/similarity", async (req) => {
    const b = body(req);
    const subjectId = subject(b);
    let basis: "lexical" | "llm";
    if (b.basis === undefined || b.basis === "") {
      const cfg = await read<{ similarityBasis?: string }>("getConfig");
      basis = cfg.similarityBasis === "llm" ? "llm" : "lexical";
    } else if (b.basis === "lexical" || b.basis === "llm") {
      basis = b.basis;
    } else {
      throw new DomainError("VALIDATION_ERROR", "相似关系依据只能是 lexical（词法）或 llm（通用模型）。");
    }
    if (basis === "llm") {
      if (!options.rebuildSimilarityWithModel) throw new DomainError("FEATURE_DISABLED");
      const rebuilt = await options.rebuildSimilarityWithModel(subjectId);
      return { ...rebuilt, basis: "llm" as const };
    }
    let threshold: number | undefined;
    if (b.threshold !== undefined && b.threshold !== "") {
      threshold = Number(b.threshold);
      if (!Number.isFinite(threshold) || threshold < 0.3 || threshold > 0.95)
        throw new DomainError("VALIDATION_ERROR");
    }
    const rebuilt = (await write("rebuildSimilarity", subjectId, {
      threshold,
      basis: "lexical" as const,
      neighbors:
        b.neighbors === undefined ? undefined : integer(b.neighbors, 5, 20),
    })) as Record<string, unknown>;
    return { ...rebuilt, basis: "lexical" as const };
  });
  // ---- v0.6.2 相似分组与压缩去重合并 ----
  route("POST", "/maintenance/groups/rebuild", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    const b = body(req);
    const basis = b.basis === "llm" ? "llm" : "lexical";
    let groupThreshold: number | undefined;
    if (b.group_threshold !== undefined) {
      groupThreshold = Number(b.group_threshold);
      if (!Number.isFinite(groupThreshold) || groupThreshold < 0.3 || groupThreshold > 0.99)
        throw new DomainError("VALIDATION_ERROR", "合并阈值需在 0.30 到 0.99 之间。");
    }
    return m.rebuildGroups(subject(b), {
      limit: b.limit === undefined ? undefined : integer(b.limit, 10, 2000),
      groupThreshold,
      basis,
    });
  });
  route("GET", "/maintenance/groups", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    const q = query(req);
    const status = typeof q.status === "string" && q.status ? q.status : undefined;
    return m.listGroups(subject(q), {
      status,
      limit: integer(q.limit, 20, 200),
      offset: offset(q.cursor),
    });
  });
  route("GET", "/maintenance/groups/:id", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    return m.getGroup(subject(query(req)), param(req));
  });
  route("POST", "/maintenance/groups/ignore", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    const b = body(req);
    const ids = Array.isArray(b.group_ids)
      ? b.group_ids.filter((id: unknown): id is string => typeof id === "string")
      : [];
    return m.ignoreGroups(subject(b), ids);
  });
  route("POST", "/maintenance/merge/preview", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    const b = body(req);
    const groupId = typeof b.group_id === "string" ? b.group_id.trim() : "";
    if (!groupId) throw new DomainError("VALIDATION_ERROR", "请选择要预览的分组。");
    return m.previewMerge(subject(b), groupId);
  });
  route("POST", "/maintenance/merge", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    const b = body(req);
    const ids = Array.isArray(b.group_ids)
      ? b.group_ids.filter((id: unknown): id is string => typeof id === "string")
      : [];
    if (!ids.length) throw new DomainError("VALIDATION_ERROR", "请至少选择一个分组。");
    return m.startMerge(subject(b), ids);
  });
  route("GET", "/maintenance/jobs/active", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    const q = query(req);
    const subjectId = typeof q.subject_id === "string" ? q.subject_id.trim() : "";
    if (!subjectId) throw new DomainError("VALIDATION_ERROR", "缺少账户 ID，无法查询任务。");
    return m.getActiveJob(subjectId);
  });
  route("GET", "/maintenance/jobs/:id", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    return m.getJob(param(req));
  });
  route("POST", "/maintenance/jobs/:id/cancel", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    return m.cancelJob(param(req));
  });
  route("GET", "/maintenance/batches", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    const q = query(req);
    return m.listBatches(subject(q), q.limit === undefined ? undefined : integer(q.limit, 1, 100));
  });
  route("GET", "/maintenance/batches/:id", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    const q = query(req);
    const subjectId = typeof q.subject_id === "string" ? q.subject_id.trim() : "";
    if (!subjectId) throw new DomainError("VALIDATION_ERROR", "缺少账户 ID，无法读取合并批次。");
    return m.getBatch(subjectId, param(req));
  });
  route("POST", "/maintenance/merge/undo", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    const b = body(req);
    const ids = Array.isArray(b.group_ids)
      ? b.group_ids.filter((id: unknown): id is string => typeof id === "string")
      : undefined;
    return m.undoBatch(subject(b), text(b.batch_id), ids);
  });
  route("POST", "/maintenance/compact/preview", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    return m.compactPreview(subject(body(req)));
  });
  route("POST", "/maintenance/compact", async (req) => {
    const m = options.maintenance;
    if (!m) throw new DomainError("FEATURE_DISABLED");
    const b = body(req);
    if (b.confirm !== true)
      throw new DomainError("VALIDATION_ERROR", "空间回收需要明确确认。");
    return m.compact(subject(b));
  });
  for (const path of ["/memories", "/profiles"])
    route("GET", path, async (req) => {
      const q = query(req),
        start = offset(q.cursor),
        limit = integer(q.limit, 20, 100);
      const page = await read<{ items: Memory[]; total: number }>(
        "listMemories",
        subject(q),
        {
          status:
            q.status === "merged"
              ? "archived"
              : q.status || undefined,
          merged: q.status === "merged" ? true : undefined,
          type: path === "/profiles" ? "profile" : q.type || undefined,
          query: q.q || undefined,
          offset: start,
          limit,
        },
      );
      return {
        ...page,
        items: page.items.map((m) => ({ ...m, provenance: m.sources })),
        next_cursor: start + limit < page.total ? cursor(start + limit) : null,
      };
    });
  const memoryWrite = async (
    req: FastifyRequest,
    method: string,
    patch: RecordData = {},
  ) => {
    const b = body(req),
      id = subject(b),
      ctx = await read<Context>("adminFor", id);
    const { subject_id, ...input } = b;
    input.request_id = requestId(input.request_id);
    // 写入来源兜底：管理端新建记忆时没有来源字段，统一标注为 web-admin，
    // 避免详情页「来源记录」为空数组（v0.5.6 之前所有管理端写入都是空的）。
    if (method === "add" && input.source === undefined)
      input.source = { platform: "web-admin" };
    if (method === "update") object(input.patch);
    if (method === "archive") versionRefs(input.items);
    if (method === "merge") {
      versionRefs(input.sources);
      versionRefs([input.target]);
    }
    return write(method, ctx, {
      ...input,
      ...patch,
    });
  };
  route("POST", "/memories", async (req) => memoryWrite(req, "add"));
  route("PATCH", "/memories/:id", async (req) =>
    memoryWrite(req, "update", { id: param(req) }),
  );
  route("POST", "/memories/merge", async (req) => memoryWrite(req, "merge"));
  route("POST", "/memories/restore", async (req) =>
    memoryWrite(req, "restore"),
  );
  route("POST", "/links", async (req) => memoryWrite(req, "link"));
  route("POST", "/memories/archive-preview", async (req) =>
    memoryWrite(req, "archive", { action: "preview" }),
  );
  route("POST", "/memories/archive", async (req) =>
    memoryWrite(req, "archive", { action: "execute" }),
  );
  route("POST", "/memories/purge-preview", async (req) => {
    const b = body(req);
    return write(
      "purgePreview",
      subject(b),
      versionRefs(b.items),
      text(b.reason),
    );
  });
  route("POST", "/memories/purge", async (req) => {
    const b = body(req);
    return write("purge", subject(b), {
      items: versionRefs(b.items),
      reason: text(b.reason),
      preview_token: text(b.preview_token),
    });
  });
  route("GET", "/graph", async (req) => {
    const q = query(req);
    return read("graph", subject(q), {
      type: q.type || undefined,
      focus_id: q.focus_id || undefined,
      q: q.q === undefined ? undefined : optionalText(q.q, 200),
      node_limit: integer(q.node_limit, 500, 5000),
      edge_limit: integer(q.edge_limit, 500, 500),
    });
  });
  route("GET", "/stats", async (req) => {
    const q = query(req);
    const data = await read<RecordData>(
      "stats",
      subject(q),
      integer(q.days, 30, 3650),
    );
    return {
      empty_result_rate: null,
      degraded_rate: null,
      average_returned_tokens: null,
      ...data,
      queues: db.metrics,
    };
  });
  route("GET", "/suggestions", async (req) => {
    const q = query(req),
      id = subject(q);
    const data = await read<{
      expired: Memory[];
      low_weight: Memory[];
      conflicts: RecordData[];
    }>("suggestions", id);
    const items: unknown[] = [
      ...data.expired.map((m) => ({
        type: "expired",
        reason: "有效期已结束，请确认是否归档",
        items: [m],
      })),
      ...data.low_weight.map((m) => ({
        type: "low_weight",
        reason: "权重较低，请检查是否仍然有用",
        items: [m],
      })),
    ];
    if (data.conflicts.length) {
      const bundle = await read<{ memories: Memory[] }>("exportData", id, true);
      for (const edge of data.conflicts) {
        const memories = bundle.memories.filter(
          (m) => m.id === edge.source_id || m.id === edge.target_id,
        );
        if (memories.length === 2)
          items.push({
            type: "conflict",
            reason: "存在明确标记的矛盾关系，请确认内容",
            items: memories,
          });
      }
    }
    return paged(items, q);
  });
  route("GET", "/config", async () => read("getConfig"));
  // 通用模型设置的元信息：密钥是否已配置（从不回显明文）。
  route("GET", "/config/model-settings", async () => ({
    key: options.keyStatus
      ? options.keyStatus()
      : {
          has_key: Boolean(process.env.EMBEDDING_API_KEY),
          source: process.env.EMBEDDING_API_KEY ? ("env" as const) : ("none" as const),
        },
    can_store_key: Boolean(options.saveKey),
  }));
  // 保存/清除模型服务密钥：界面输入 → 加密落盘，返回值只有状态，不回显明文。
  route("POST", "/config/embedding-key", async (req) => {
    if (!options.saveKey) throw new DomainError("FEATURE_DISABLED");
    const b = body(req);
    if (b.api_key !== undefined && typeof b.api_key !== "string")
      throw new DomainError("VALIDATION_ERROR");
    const raw = typeof b.api_key === "string" ? b.api_key.trim() : "";
    if (raw.length > 512) throw new DomainError("VALIDATION_ERROR");
    return options.saveKey(raw);
  });
  // 拉取该服务提供的模型列表，供设置页下拉选择，避免手打模型名出错。
  route("POST", "/config/embedding-models", async (req) => {
    if (!options.listEncoderModels) throw new DomainError("FEATURE_DISABLED");
    const b = body(req);
    const baseUrl = text(b.baseUrl).trim();
    if (!baseUrl) throw new DomainError("VALIDATION_ERROR");
    const apiKey =
      typeof b.api_key === "string" && b.api_key.trim()
        ? b.api_key.trim()
        : undefined;
    return options.listEncoderModels({ baseUrl, apiKey });
  });
  route("POST", "/config/preview", async (req) => {
    const b = body(req),
      config = await read<{ revision: number }>("getConfig");
    if (config.revision !== revision(b.expected_revision))
      throw new DomainError("REVISION_CONFLICT");
    return write("previewConfig", object(b.patch));
  });
  // 设置页「测试连接」：用草稿配置真实发一条对话，只验证不落库。
  route("POST", "/config/embedding-test", async (req) => {
    if (!options.testModel) throw new DomainError("FEATURE_DISABLED");
    const b = body(req);
    const baseUrl = text(b.baseUrl).trim();
    const model = text(b.model).trim();
    if (!baseUrl || !model) throw new DomainError("VALIDATION_ERROR");
    const apiKey =
      typeof b.api_key === "string" && b.api_key.trim()
        ? b.api_key.trim()
        : undefined;
    return options.testModel({ baseUrl, model, apiKey });
  });
  route("PATCH", "/config", async (req) => {
    const b = body(req);
    return write("updateConfig", {
      expected_revision: revision(b.expected_revision),
      preview_token: text(b.preview_token),
      patch: object(b.patch),
    });
  });
  route("POST", "/exports", async (req) => {
    const b = body(req);
    if (
      b.include_private !== undefined &&
      typeof b.include_private !== "boolean"
    )
      throw new DomainError("VALIDATION_ERROR");
    return read("exportData", subject(b), b.include_private === true);
  });
  route(
    "POST",
    "/imports/preview",
    async (req) => {
      cleanup();
      const b = body(req),
        id = subject(b),
        payload = object(b.bundle),
        bytes = Buffer.byteLength(JSON.stringify(payload));
      if (
        bytes > IMPORT_MAX ||
        stagedBytes + bytes > 2 * IMPORT_MAX ||
        imports.size >= 32
      )
        throw new DomainError("SERVER_BUSY");
      stagedBytes += bytes;
      try {
        const preview = await write<Preview>("previewImport", id, payload);
        imports.set(preview.preview_token, {
          session: current(req)!.id,
          subject: id,
          payload,
          bytes,
          expires: Math.min(preview.expires_at, Date.now() + 300000),
        });
        return preview;
      } catch (error) {
        stagedBytes -= bytes;
        throw error;
      }
    },
    { bodyLimit: IMPORT_MAX + 65536 },
  );
  route("POST", "/imports/commit", async (req) => {
    cleanup();
    const b = body(req),
      key = text(b.preview_token),
      entry = imports.get(key);
    if (
      !entry ||
      entry.session !== current(req)!.id ||
      entry.subject !== subject(b)
    )
      throw new DomainError("PREVIEW_EXPIRED");
    const result = await write("importData", entry.subject, {
      payload: entry.payload,
      preview_token: key,
    });
    dropImport(key);
    return result;
  });
  const backup = async (id: string) => {
    const rows = await read<RecordData[]>("listBackups");
    const found = rows.find((row) => row.id === id);
    if (!found) throw new DomainError("NOT_FOUND");
    return found;
  };
  const publicBackup = async (b: RecordData) => {
    const path = text(b.path);
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch {
      size = 0;
    }
    return {
      id: b.id,
      created_at: b.created_at,
      sha256: b.sha256,
      size,
      label: typeof b.label === "string" ? b.label : "",
      path,
      kind: "local",
    };
  };
  const cloud = new WebdavCloud(
    join(dirname(options.backupDir), "webdav.json"),
    join(dirname(options.backupDir), "webdav.key"),
  );
  const cloudError = (error: unknown): never => {
    const status = (error as { status?: number }).status;
    const raw = error instanceof Error ? error.message : String(error);
    const code = raw.startsWith("WEBDAV_")
      ? raw.replace(/[^A-Z_]/g, "").slice(0, 60) || "WEBDAV_ERROR"
      : status === 401
        ? "WEBDAV_AUTH_FAILED"
        : "WEBDAV_ERROR";
    throw new DomainError(code, raw.slice(0, 300));
  };
  interface CloudJob {
    id: string;
    status: "running" | "done" | "failed";
    logs: { at: number; level: "info" | "warn" | "error"; text: string }[];
    result?: RecordData;
    error?: string;
    started_at: number;
  }
  const jobs = new Map<string, CloudJob>();
  const log = (job: CloudJob, level: "info" | "warn" | "error", text: string) => {
    job.logs.push({ at: Date.now(), level, text });
    if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
  };
  const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + " MB";
  const safeName = (value: string) =>
    /^[\w.\-\u4e00-\u9fa5 ()]{1,120}\.sqlite$/i.test(value);
  route("GET", "/backups", async (req) => {
    const rows = await read<RecordData[]>("listBackups");
    return paged(await Promise.all(rows.map(publicBackup)), query(req));
  });
  route("POST", "/backups", async (req) => {
    const label = optionalText(
      req.body && typeof req.body === "object"
        ? (req.body as RecordData).label
        : undefined,
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return publicBackup(
      await write<RecordData>(
        "backup",
        join(options.backupDir, stamp + ".sqlite"),
        label,
      ),
    );
  });
  route("POST", "/backups/label", async (req) => {
    const b = body(req);
    return publicBackup(
      await write<RecordData>(
        "updateBackupLabel",
        text(b.backup_id),
        optionalText(b.label),
      ),
    );
  });
  route("POST", "/backups/delete", async (req) => {
    const id = text(body(req).backup_id);
    const row = await write<RecordData>("deleteBackup", id);
    const path = resolve(text(row.path));
    const allowed = withinAllowed(path, options.backupDir);
    let removed = false;
    if (allowed && existsSync(path)) {
      unlinkSync(path);
      removed = true;
    }
    return { deleted: true, file_removed: removed, path };
  });
  route("POST", "/backups/inspect", async (req) => {
    const path = resolve(text(body(req).path));
    // R-01: inspectBackup 会以 readonly 打开任意 SQLite 文件并返回元数据/计数，
    // 必须与 /backups/delete 一样限制在 backups 与 tmpdir 内，且用 sep 感知的包含性校验。
    if (!withinAllowed(path, options.backupDir))
      throw new DomainError("VALIDATION_ERROR");
    return write("inspectBackup", path);
  });
  route("GET", "/webdav", async () => cloud.status());
  route("POST", "/webdav", async (req) => {
    try {
      return cloud.save(body(req));
    } catch (error) {
      return cloudError(error);
    }
  });
  route("POST", "/webdav/test", async () => {
    try {
      return { ...(await cloud.test()), ...cloud.status() };
    } catch (error) {
      return cloudError(error);
    }
  });
  route("GET", "/webdav/files", async () => {
    try {
      const items = await cloud.list();
      return { items, total: items.length };
    } catch (error) {
      return cloudError(error);
    }
  });
  route("POST", "/webdav/upload", async (req) => {
    const label = optionalText(body(req).label);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = stamp + ".sqlite";
    const local = join(options.backupDir, name);
    const row = await write<RecordData>("backup", local, label || "云端上传");
    try {
      const size = await cloud.upload(local, name);
      return { uploaded: true, name, size, backup_id: row.id };
    } catch (error) {
      return cloudError(error);
    }
  });
  const cloudDeletions = new Map<
    string,
    { code: string; session: string; expires: number; attempts: number }
  >();
  route("POST", "/webdav/delete-preview", async (req) => {
    const name = text(body(req).name);
    if (!safeName(name)) throw new DomainError("VALIDATION_ERROR");
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const expires = Date.now() + 300000;
    cloudDeletions.set(name, {
      code,
      session: current(req)!.id,
      expires,
      attempts: 0,
    });
    return { name, code, expires_at: expires };
  });
  route("POST", "/webdav/delete", async (req) => {
    const b = body(req);
    const name = text(b.name);
    if (!safeName(name)) throw new DomainError("VALIDATION_ERROR");
    const input = text(b.code);
    const entry = cloudDeletions.get(name);
    if (
      !entry ||
      entry.session !== current(req)!.id ||
      entry.expires < Date.now() ||
      entry.attempts >= 5
    ) {
      cloudDeletions.delete(name);
      throw new DomainError("PREVIEW_EXPIRED", "验证码已失效，请重新获取");
    }
    entry.attempts++;
    const given = Buffer.from(input);
    const expected = Buffer.from(entry.code);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new DomainError("FORBIDDEN", "验证码不正确");
    try {
      await cloud.remove(name);
      cloudDeletions.delete(name);
      return { deleted: true, name };
    } catch (error) {
      return cloudError(error);
    }
  });
  route("GET", "/webdav/jobs/:id", async (req) => {
    const job = jobs.get(param(req));
    if (!job) throw new DomainError("NOT_FOUND");
    return {
      id: job.id,
      status: job.status,
      logs: job.logs,
      result: job.result ?? null,
      error: job.error ?? null,
      started_at: job.started_at,
    };
  });
  route("POST", "/webdav/restore", async (req) => {
    const name = text(body(req).name);
    if (!safeName(name)) throw new DomainError("VALIDATION_ERROR");
    for (const [id, job] of jobs)
      if (job.status !== "running" && Date.now() - job.started_at > 30 * 60 * 1000)
        jobs.delete(id);
    const job: CloudJob = {
      id: randomUUID(),
      status: "running",
      logs: [],
      started_at: Date.now(),
    };
    jobs.set(job.id, job);
    void (async () => {
      const destination = join(
        tmpdir(),
        "vectorize-mcp-cloud-" + randomUUID() + ".sqlite",
      );
      try {
        log(job, "info", "正在连接云端目录…");
        await cloud.test();
        log(job, "info", "连接成功，开始下载 " + name);
        let lastPercent = -1;
        const size = await cloud.download(name, destination, (done, total) => {
          const percent = total ? Math.floor((done / total) * 100) : 0;
          if (percent === lastPercent || percent % 10 !== 0) return;
          lastPercent = percent;
          log(
            job,
            "info",
            "已下载 " + percent + "%（" + megabytes(done) + " / " + megabytes(total) + "）",
          );
        });
        log(job, "info", "下载完成，共 " + megabytes(size) + "，开始校验完整性…");
        const report = (await write<RecordData>(
          "inspectBackup",
          destination,
        )) as RecordData & { counts?: RecordData; schema_version?: string };
        log(
          job,
          report.integrity ? "info" : "error",
          "完整性检查：" + (report.integrity ? "通过" : "损坏"),
        );
        log(
          job,
          Number(report.foreign_key_violations) === 0 ? "info" : "warn",
          "外键一致性：" + String(report.foreign_key_violations) + " 处异常",
        );
        log(job, "info", "数据结构版本：" + String(report.schema_version ?? "未知"));
        log(
          job,
          "info",
          "内含 " +
            String(report.counts?.accounts ?? 0) +
            " 个账户、" +
            String(report.counts?.memories ?? 0) +
            " 条记忆、" +
            String(report.counts?.links ?? 0) +
            " 条关联",
        );
        if (!report.integrity) throw new Error("备份文件完整性校验失败");
        if (String(report.schema_version) !== "3")
          throw new Error("数据结构版本不匹配，请使用 v0.2.2 之后的备份");
        log(job, "info", "登记为可恢复快照并生成恢复预检…");
        const registered = await write<RecordData>(
          "registerBackup",
          destination,
          "云端：" + name,
        );
        const preview = (await write<RecordData>(
          "restorePreview",
          destination,
        )) as RecordData;
        log(job, "warn", "恢复会撤销全部访问凭据，需要重新签发 Token。");
        job.result = {
          backup_id: registered.id,
          backup_name: name,
          path: destination,
          report,
          preview,
        };
        job.status = "done";
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        log(job, "error", "恢复预检失败：" + job.error);
        if (existsSync(destination)) {
          try {
            unlinkSync(destination);
          } catch {
            /* 临时文件清理失败不影响预检结果 */
          }
        }
      }
    })();
    return { job_id: job.id, status: job.status };
  });
  route("POST", "/restores/preview", async (req) => {
    const b = await backup(text(body(req).backup_id));
    const { path, ...preview } = await write<RecordData>(
      "restorePreview",
      text(b.path),
    );
    return { ...preview, backup_id: b.id };
  });
  route("POST", "/restores/execute", async (req, reply) => {
    const b = body(req),
      registered = await backup(text(b.backup_id));
    await db.restore(text(registered.path), text(b.preview_token));
    sessions.clear();
    imports.clear();
    stagedBytes = 0;
    reply.clearCookie(COOKIE, { path: "/" });
    return { restored: true, all_tokens_revoked: true };
  });
  route("GET", "/audit", async (req) => {
    const q = query(req),
      start = offset(q.cursor),
      limit = integer(q.limit, 50, 100);
    const rows = await read<RecordData[]>("operationLogs", limit + 1, start, {
      action: q.action ? text(q.action) : undefined,
      actor: q.actor ? text(q.actor) : undefined,
      from:
        q.from === undefined || q.from === ""
          ? undefined
          : integer(q.from, 1, Number.MAX_SAFE_INTEGER),
      to:
        q.to === undefined || q.to === ""
          ? undefined
          : integer(q.to, 1, Number.MAX_SAFE_INTEGER),
    });
    return {
      items: rows.slice(0, limit).map((r) => ({
        ...r,
        actor_id: r.actor_id ?? r.actor,
        result: "ok",
        target_ids:
          typeof r.target === "string" ? JSON.parse(r.target) : r.target,
      })),
      next_cursor: rows.length > limit ? cursor(start + limit) : null,
    };
  });
  // ── 在线更新（下载 Release 源码 → 覆盖程序文件 → 重新编译 / 启动） ──
  const GITHUB_REPO = "w2018/vectorize-mcp";
  const dataRoot = dirname(options.backupDir);
  const updatesDir = join(dataRoot, "updates");
  const updateTmp = join(updatesDir, "tmp");
  const updateConfirms = new Map<
    string,
    { code: string; session: string; expires: number; attempts: number }
  >();
  const currentVersion = async () => {
    try {
      const raw = JSON.parse(
        await readFile(join(installRoot, "package.json"), "utf8"),
      );
      return String(raw.version ?? "0.0.0");
    } catch {
      // 单一版本真源 src/server/version.ts 读的是同一份 package.json；
      // 安装目录临时不可读时用它兜底，避免更新检查误报 0.0.0。
      return APP_VERSION;
    }
  };
  const compareVersions = (a: string, b: string) => {
    const pa = a.replace(/^v/, "").split(/[.-]/).map((x: string) => parseInt(x, 10) || 0);
    const pb = b.replace(/^v/, "").split(/[.-]/).map((x: string) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  let latestCache: { at: number; data: RecordData } | null = null;
  const fetchLatestRelease = async (force = false) => {
    if (!force && latestCache && Date.now() - latestCache.at < 600000)
      return latestCache.data;
    const res = await fetch(
      "https://api.github.com/repos/" + GITHUB_REPO + "/releases/latest",
      {
        headers: {
          "User-Agent": "vectorize-mcp",
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!res.ok)
      throw new DomainError(
        "UPDATE_CHECK_FAILED",
        "无法获取最新版本（HTTP " + res.status + "）",
      );
    const j = await res.json();
    const tag = String(j.tag_name ?? "");
    const tarball =
      typeof j.tarball_url === "string" ? String(j.tarball_url) : null;
    const data = {
      version: tag.replace(/^v/, ""),
      tag,
      published_at: j.published_at ?? null,
      notes: typeof j.body === "string" ? j.body : "",
      html_url: j.html_url ?? null,
      tarball,
      prerelease: Boolean(j.prerelease),
    };
    latestCache = { at: Date.now(), data };
    return data;
  };
  const allowedSource = (url: string) =>
    url.startsWith("https://codeload.github.com/" + GITHUB_REPO + "/") ||
    url.startsWith("https://api.github.com/repos/" + GITHUB_REPO + "/") ||
    url.startsWith("https://github.com/" + GITHUB_REPO + "/");
  const issueUpdateCode = (req: FastifyRequest, action: string) => {
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const expires = Date.now() + 300000;
    updateConfirms.set(action, {
      code,
      session: current(req)!.id,
      expires,
      attempts: 0,
    });
    return { action, code, expires_at: expires };
  };
  const verifyUpdateCode = (
    req: FastifyRequest,
    action: string,
    code: unknown,
  ) => {
    const entry = updateConfirms.get(action);
    if (
      !entry ||
      entry.session !== current(req)!.id ||
      entry.expires < Date.now() ||
      entry.attempts >= 5
    ) {
      updateConfirms.delete(action);
      throw new DomainError("PREVIEW_EXPIRED", "验证码已失效，请重新获取");
    }
    entry.attempts++;
    const given = Buffer.from(String(code ?? ""));
    const expected = Buffer.from(entry.code);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new DomainError("FORBIDDEN", "验证码不正确");
    updateConfirms.delete(action);
  };
  const runCommand = (cmd: string, args: string[]) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(cmd, args, {
        cwd: installRoot,
        windowsHide: true,
        shell: process.platform === "win32",
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (out += d.toString()));
      child.on("error", rejectPromise);
      child.on("close", (code) =>
        code === 0
          ? resolvePromise(out)
          : rejectPromise(new Error(out.trim() || "命令退出码 " + code)),
      );
    });
  const runJobCommand = (
    job: CloudJob,
    cmd: string,
    args: string[],
  ) =>
    new Promise<void>((resolvePromise, rejectPromise) => {
      log(job, "info", "$ " + cmd + " " + args.join(" "));
      const child = spawn(cmd, args, {
        cwd: installRoot,
        windowsHide: true,
        shell: process.platform === "win32",
      });
      const onData = (d: Buffer) => {
        for (const line of d.toString().split(/\r?\n/))
          if (line.trim()) log(job, "info", line.slice(0, 400));
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", rejectPromise);
      child.on("close", (code) =>
        code === 0
          ? resolvePromise()
          : rejectPromise(new Error("命令退出码 " + code)),
      );
    });
  const newJob = () => {
    for (const [id, job] of jobs)
      if (
        job.status !== "running" &&
        Date.now() - job.started_at > 30 * 60 * 1000
      )
        jobs.delete(id);
    const job: CloudJob = {
      id: randomUUID(),
      status: "running",
      logs: [],
      started_at: Date.now(),
    };
    jobs.set(job.id, job);
    return job;
  };
  route("GET", "/update/check", async (req) => {
    const current = await currentVersion();
    let latest = null;
    let error = null;
    try {
      latest = await fetchLatestRelease(query(req).refresh === "1");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return {
      current,
      latest,
      has_update: latest
        ? compareVersions(String(latest.version), current) > 0
        : false,
      error,
    };
  });
  route("GET", "/update/jobs/:id", async (req) => {
    const job = jobs.get(param(req));
    if (!job) throw new DomainError("NOT_FOUND");
    return {
      id: job.id,
      status: job.status,
      logs: job.logs,
      result: job.result ?? null,
      error: job.error ?? null,
      started_at: job.started_at,
    };
  });
  route("POST", "/update/confirm", async (req) => {
    const action = text(body(req).action);
    if (!["apply", "build", "start", "stop"].includes(action))
      throw new DomainError("VALIDATION_ERROR");
    return issueUpdateCode(req, action);
  });
  route("POST", "/update/download", async () => {
    const release = await fetchLatestRelease();
    const url = release.tarball ? String(release.tarball) : "";
    if (!url || !allowedSource(url))
      throw new DomainError("UPDATE_UNAVAILABLE", "暂无可用下载地址");
    const version = String(release.version);
    const job = newJob();
    log(job, "info", "准备下载 v" + version + " 源码包…");
    void (async () => {
      try {
        await mkdir(updateTmp, { recursive: true });
        const res = await fetch(url, {
          headers: { "User-Agent": "vectorize-mcp" },
          redirect: "follow",
        });
        if (!res.ok || !res.body)
          throw new Error("下载失败（HTTP " + res.status + "）");
        const total = Number(res.headers.get("content-length") ?? 0);
        const dest = join(updateTmp, "v" + version + ".tar.gz");
        const out = createWriteStream(dest);
        let received = 0;
        let lastPercent = -1;
        job.result = { version, received: 0, total };
        for await (const chunk of res.body) {
          received += chunk.length;
          out.write(chunk);
          job.result = { version, received, total };
          const percent = total ? Math.floor((received / total) * 100) : 0;
          if (percent >= lastPercent + 5) {
            lastPercent = percent;
            log(
              job,
              "info",
              "已下载 " +
                percent +
                "%（" +
                megabytes(received) +
                (total ? " / " + megabytes(total) : "") +
                "）",
            );
          }
        }
        await new Promise<void>((r) => out.end(() => r()));
        job.result = { version, received, total, archive: dest };
        log(job, "info", "下载完成，共 " + megabytes(received));
        job.status = "done";
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        log(job, "error", "下载失败：" + job.error);
      }
    })();
    return { job_id: job.id, version };
  });
  route("POST", "/update/apply", async (req) => {
    const b = body(req);
    verifyUpdateCode(req, "apply", b.code);
    const version = text(b.version).replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version))
      throw new DomainError("VALIDATION_ERROR");
    const archive = join(updateTmp, "v" + version + ".tar.gz");
    if (!existsSync(archive))
      throw new DomainError("NOT_FOUND", "请先下载该版本源码包");
    const extractDir = join(updateTmp, "extract-" + randomUUID());
    await mkdir(extractDir, { recursive: true });
    try {
      await runCommand("tar", ["-xzf", archive, "-C", extractDir]);
      const dirs = (await readdir(extractDir, { withFileTypes: true })).filter(
        (e) => e.isDirectory(),
      );
      if (dirs.length !== 1) throw new Error("源码包结构异常");
      const srcRoot = join(extractDir, dirs[0].name);
      const oldVersion = await currentVersion();
      const backupDir = join(
        updatesDir,
        "backup-" + oldVersion + "-" + Date.now(),
      );
      await mkdir(backupDir, { recursive: true });
      const skip = new Set(["data", ".git", "tmp", "node_modules", "dist"]);
      let files = 0;
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const abs = join(dir, entry.name);
          const rel = relative(srcRoot, abs);
          const top = rel.split(sep)[0];
          if (skip.has(top ?? "")) continue;
          if (entry.name === ".env" || entry.name.startsWith(".env."))
            continue;
          if (entry.isDirectory()) {
            await walk(abs);
            continue;
          }
          const dest = join(installRoot, rel);
          if (existsSync(dest)) {
            const backupPath = join(backupDir, rel);
            await mkdir(dirname(backupPath), { recursive: true });
            await cp(dest, backupPath);
          }
          await mkdir(dirname(dest), { recursive: true });
          await cp(abs, dest);
          files++;
        }
      };
      await walk(srcRoot);
      const historyPath = join(updatesDir, "history.json");
      let history = [];
      try {
        history = JSON.parse(await readFile(historyPath, "utf8"));
      } catch {
        history = [];
      }
      history.push({
        at: Date.now(),
        from: oldVersion,
        to: version,
        files,
        backup: backupDir,
      });
      await writeFile(
        historyPath,
        JSON.stringify(history.slice(-50), null, 2),
      );
      return { installed_version: version, backup_dir: backupDir, files };
    } finally {
      await rm(extractDir, { recursive: true, force: true });
    }
  });
  route("POST", "/update/build", async (req) => {
    verifyUpdateCode(req, "build", body(req).code);
    const job = newJob();
    void (async () => {
      try {
        log(job, "info", "开始安装依赖（npm install）…");
        await runJobCommand(job, "npm", ["install", "--no-audit", "--no-fund"]);
        log(job, "info", "依赖安装完成，开始编译（npm run build）…");
        await runJobCommand(job, "npm", ["run", "build"]);
        log(job, "info", "编译完成。");
        job.status = "done";
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        log(job, "error", "编译失败：" + job.error);
      }
    })();
    return { job_id: job.id };
  });
  route("POST", "/update/start", async (req) => {
    verifyUpdateCode(req, "start", body(req).code);
    const child = spawn("npm", ["start"], {
      cwd: installRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: process.platform === "win32",
    });
    child.unref();
    return { started: true, pid: child.pid ?? null };
  });
  route("POST", "/update/stop", async (req) => {
    verifyUpdateCode(req, "stop", body(req).code);
    setTimeout(() => {
      void app.close().finally(() => process.exit(0));
    }, 400);
    return { stopping: true };
  });
}
