import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  HTTPMethods,
} from "fastify";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { WebdavCloud } from "./webdav.js";
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
  },
): Promise<void> {
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
    if (header === undefined || header === origin) return header !== undefined;
    let parsed: URL;
    try {
      parsed = new URL(header);
    } catch {
      return false;
    }
    if (parsed.origin === origin) return true;
    if (!loopback(parsed.hostname)) return false;
    if (!host) return true;
    return parsed.host.toLowerCase() === host.toLowerCase();
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
  const issue = (reply: FastifyReply, authenticated: boolean) => {
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
      secure: options.secureCookie,
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
    const s = current(req) ?? issue(reply, false);
    return { authenticated: s.authenticated, csrf_token: s.csrf };
  });
  route(
    "POST",
    "/auth/login",
    async (req, reply) => {
      if (!(await verify(body(req).password, options.passwordHash)))
        throw new DomainError("UNAUTHENTICATED");
      const prior = current(req);
      if (prior) sessions.delete(prior.id);
      const s = issue(reply, true);
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
      secure: options.secureCookie,
    });
    return { authenticated: false };
  });
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
  route("POST", "/memories/delete-preview", async (req) => {
    const b = body(req);
    return write("deletePreview", subject(b), versionRefs(b.items), text(b.reason));
  });
  route("POST", "/memories/delete", async (req) => {
    const b = body(req);
    return write("deleteToTrash", subject(b), {
      items: versionRefs(b.items),
      reason: text(b.reason),
      preview_token: text(b.preview_token),
    });
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
  route("POST", "/tokens", async (req) => {
    const b = body(req);
    return write(
      "createToken",
      text(b.label),
      b.subject_id === undefined ? undefined : subject(b),
      {
        request_id: text(b.request_id),
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
      q.token_budget === undefined
        ? undefined
        : integer(q.token_budget, 600, 1200),
    );
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
          status: q.status || undefined,
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
    text(input.request_id);
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
      node_limit: integer(q.node_limit, 500, 500),
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
  route("POST", "/config/preview", async (req) => {
    const b = body(req),
      config = await read<{ revision: number }>("getConfig");
    if (config.revision !== b.expected_revision)
      throw new DomainError("REVISION_CONFLICT");
    return write("previewConfig", object(b.patch));
  });
  route("PATCH", "/config", async (req) => {
    const b = body(req);
    return write("updateConfig", {
      expected_revision: b.expected_revision,
      preview_token: b.preview_token,
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
    const allowed = [resolve(options.backupDir), resolve(tmpdir())].some((dir) =>
      path.startsWith(dir),
    );
    let removed = false;
    if (allowed && existsSync(path)) {
      unlinkSync(path);
      removed = true;
    }
    return { deleted: true, file_removed: removed, path };
  });
  route("POST", "/backups/inspect", async (req) =>
    write("inspectBackup", resolve(text(body(req).path))),
  );
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
  route("POST", "/webdav/delete", async (req) => {
    const name = text(body(req).name);
    if (!safeName(name)) throw new DomainError("VALIDATION_ERROR");
    try {
      await cloud.remove(name);
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
    const rows = await read<RecordData[]>("operationLogs", limit + 1, start);
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
}
