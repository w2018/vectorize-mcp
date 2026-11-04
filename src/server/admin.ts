import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  HTTPMethods,
} from "fastify";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabasePool } from "./database.js";
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
          if (req.headers.origin !== origin) throw new DomainError("FORBIDDEN");
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
      { request_id: text(b.request_id), preview_token: b.preview_token },
    );
  });
  route("POST", "/tokens/:id/revoke-preview", async (req) =>
    write("revokePreview", param(req)),
  );
  route("POST", "/tokens/:id/revoke", async (req) =>
    write("revokeToken", param(req), text(body(req).preview_token)),
  );
  route("POST", "/accounts/:id/enable-preview", async (req) =>
    write("enablePreview", param(req)),
  );
  route("GET", "/spaces", async (req) => ({
    items: await read("spaces", subject(query(req))),
  }));
  route("POST", "/spaces", async (req) =>
    write("createSpace", subject(body(req)), text(body(req).name)),
  );
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
          space_id: q.space_id || undefined,
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
    const spaces = await read<{ id: string }[]>("spaces", id);
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
      scope: { space_ids: spaces.map((s) => s.id) },
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
      space_id: q.space_id || undefined,
      type: q.type || undefined,
      focus_id: q.focus_id || undefined,
      node_limit: integer(q.node_limit, 200, 200),
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
  const publicBackup = async (b: RecordData) => ({
    id: b.id,
    created_at: b.created_at,
    sha256: b.sha256,
    size: (await stat(text(b.path))).size,
  });
  route("GET", "/backups", async (req) => {
    const rows = await read<RecordData[]>("listBackups");
    return paged(await Promise.all(rows.map(publicBackup)), query(req));
  });
  route("POST", "/backups", async () =>
    publicBackup(
      await write<RecordData>(
        "backup",
        join(options.backupDir, randomUUID() + ".sqlite"),
      ),
    ),
  );
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
      items: rows
        .slice(0, limit)
        .map((r) => ({
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
