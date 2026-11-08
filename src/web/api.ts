export type RestoreLevel = "green" | "orange" | "red";
export interface TrashItemSummary {
  id: string;
  kind: "memory" | "token";
  source_subject_id: string;
  source_label: string;
  target_id: string;
  label: string;
  deleted_at: number;
  actor: string;
  size_bytes: number;
  state: "pending" | "committed";
}
export interface TrashItemDetail extends TrashItemSummary {
  payload: unknown;
  schema_version: number;
}
export interface RestoreIssue {
  level: RestoreLevel;
  code: string;
  message: string;
}
export interface RestoreCheck {
  trash_id: string;
  target_id: string;
  kind: string;
  label: string;
  level: RestoreLevel;
  issues: RestoreIssue[];
  summary?: string;
}
export interface TrashCompat {
  preview_token: string;
  expires_at: number;
  target_subject_id: string;
  target_label: string;
  items: RestoreCheck[];
  summary: { green: number; orange: number; red: number; total: number };
  restorable: boolean;
}
export interface AccountStats {
  subject_id: string;
  label: string;
  memory_total: number;
  memory_total_tokens: number;
  search_requests: number;
  extraction_total_tokens: number;
  hit_effective_rate: number | null;
  result_rate?: number | null;
  labeled_search_requests?: number;
  labeled_hit_at_1?: number | null;
  labeled_hit_at_3?: number | null;
  active: number;
  archived: number;
  merged: number;
  total: number;
}
/** Public, unauthenticated service identity: used by the About page so the
 * version never depends on an admin session or a hardcoded fallback. */
export interface HealthInfo {
  ok: boolean;
  version: string;
}
export async function health(): Promise<HealthInfo> {
  const response = await fetch("/health", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return (await response.json()) as HealthInfo;
}
export function dataChanged() {
  window.dispatchEvent(new Event("memory-data-changed"));
}
export type { EncoderPreset } from "../core/embedding-presets";
export interface EncoderPresetsResponse {
  items: {
    key: string;
    label: string;
    baseUrl: string;
    model: string;
    dimension: number;
    needsKey: boolean;
    summary: string;
  }[];
  /** 当前已发布配置命中的预设 key；三项不完全一致时为 custom。 */
  active: string;
  /** 服务端是否设置了 EMBEDDING_API_KEY（只回布尔，不回密钥）。 */
  key_from_env: boolean;
  /** 生效中的 Key 状态：来自加密文件还是环境变量，只回布尔结论。 */
  key?: { has_key: boolean; source: "file" | "env" | "none" };
  /** 是否支持在界面里保存 Key（文件路径未配置时为 false）。 */
  can_store_key?: boolean;
}
export interface ModelTestResult {
  ok: boolean;
  model: string;
  elapsed_ms: number;
  error?: string;
}
export interface EncoderTestResult {
  ok: boolean;
  model: string;
  /** 服务实际返回的向量维度；探测失败时为 0。 */
  dimension: number;
  /** 界面填写的维度（留空为 0）。 */
  declared_dimension?: number;
  dimension_matched?: boolean;
  elapsed_ms: number;
  error?: string;
}
export interface EncoderModelsResult {
  ok: boolean;
  models: string[];
  /** 逐个真实调用 /embeddings 后确认能出向量的模型（probe=true 时返回）。 */
  embeddable?: string[];
  error?: string;
}
export interface EncoderKeyStatus {
  has_key: boolean;
  source: "file" | "env" | "none";
}
export type { AccountKind, BotPreset, BotProfile, BotSettings, MemoryType } from "../core/types";
import type { AccountKind, MemoryType } from "../core/types";
export interface Profile {
  profile_key: string;
  basis: "explicit" | "inferred";
  confidence?: number;
  evidence?: string[];
}
export interface Memory {
  id: string;
  subject_id: string;
  title: string;
  content: string;
  type: MemoryType;
  keywords: string[];
  importance: number;
  weight: number;
  retrieval_count: string;
  revision: number;
  status: "active" | "archived";
  sensitivity: "normal" | "private";
  embedding_state: string;
  created_at: number;
  updated_at: number;
  confirmed_at: number;
  valid_from: number | null;
  valid_until: number | null;
  profile?: Profile | null;
  sources?: unknown[];
  provenance?: unknown[];
  merged_into?: string | null;
}
export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  status?: string;
  active_token_id?: string | null;
  memory_count?: number;
}
export interface Token {
  id: string;
  label: string;
  subject_id: string;
  status: string;
  created_at: number;
  last_used_at: number | null;
  /** 是否保存了可再次查看的令牌明文。 */
  viewable?: boolean;
}
export interface Page<T> {
  items: T[];
  next_cursor?: string | null;
  total?: number;
}
export interface Preview {
  preview_token: string;
  summary?: string;
  [key: string]: unknown;
}
export interface Link {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  strength: number;
  revision: number;
  created_at: number;
  updated_at?: number;
  /** link = 手动关系链；similarity = memory_similarity 自动相似边（只读）。 */
  kind?: "link" | "similarity";
  similarity?: number;
}
export interface Graph {
  nodes: Memory[];
  edges: Link[];
  truncated: boolean;
}
export interface Bootstrap {
  profile: import("../core/types").BotProfile;
  persona: unknown | null;
  memories: unknown[];
  estimated_tokens: number;
  budget_exhausted: boolean;
  warnings: string[];
}

export interface UpdateRelease {
  version: string;
  tag: string;
  published_at: string | null;
  notes: string;
  html_url: string | null;
  tarball: string | null;
  prerelease: boolean;
}
export interface UpdateCheck {
  current: string;
  latest: UpdateRelease | null;
  has_update: boolean;
  error: string | null;
}
export interface UpdateJob {
  id: string;
  status: "running" | "done" | "failed";
  logs: { at: number; level: "info" | "warn" | "error"; text: string }[];
  result?: { version?: string; received?: number; total?: number } | null;
  error?: string | null;
  started_at: number;
}
export interface Config {
  revision: number;
  importanceFactor: number;
  frequencyFactor: number;
  recencyFactor: number;
  halfLifeDays: number;
  frequencyCap: number;
  defaultLimit: number;
  tokenBudget: number;
  semanticThreshold: number;
  lexicalThreshold: number;
  agentArchiveEnabled: boolean;
  protectedImportance: number;
  purgeEnabled: boolean;
  minArchivedDays: number;
  allowInferredProfiles: boolean;
  similarityThreshold: number;
  similarityBuildThreshold: number;
  similarityFoldThreshold: number;
  similarityBasis: "lexical" | "semantic" | "hybrid" | "llm";
  similaritySemanticThreshold: number;
  embeddingModel: string;
  embeddingBaseUrl: string;
  embeddingDimension: number;
  llmBaseUrl: string;
  llmModel: string;
  [key: string]: unknown;
}
export interface SimilarityGroupMember {
  memory_id: string;
  revision: number;
  score: number;
  role: string;
  title?: string;
  content?: string;
  type?: string;
  importance?: number;
  status?: string;
}
export interface SimilarityGroup {
  id: string;
  subject_id: string;
  basis: string;
  model: string;
  threshold: number;
  min_score: number;
  member_count: number;
  state_token: string;
  status: string;
  risk: string;
  created_at: number;
  updated_at: number;
  members?: SimilarityGroupMember[];
}
export interface MaintenanceJob {
  id: string;
  subject_id: string;
  kind: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";
  total: number;
  done: number;
  options: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string;
}
export interface MergeJobResult {
  merged?: number;
  groups?: number;
  batch_id?: string;
  skipped?: { group_id: string; reason: string }[];
}
export interface MergeBatchDetail {
  group_id: string;
  target_id: string;
  new_revision: number;
  archived: { id: string; revision: number }[];
  before?: { id: string; title?: string; content: string; score: number; type?: string }[];
  after?: { title?: string; content: string; type: string; reason: string };
}
export interface MergeBatch {
  id: string;
  subject_id: string;
  job_id: string;
  status: string;
  groups: number;
  detail: MergeBatchDetail[];
  created_at: number;
  undone_at: number | null;
  finalized_at: number | null;
}
export interface MergeDraft {
  group_id: string;
  title?: string;
  content: string;
  type: string;
  keywords: string[];
  importance?: number;
  reason: string;
}
export interface Backup {
  id: string;
  created_at: number;
  size: number;
  sha256: string;
  label?: string;
  path?: string;
  kind?: string;
  verified_at?: number;
}
export interface WebdavPreset {
  key: "jianguoyun" | "custom";
  label: string;
  url: string;
}
export interface WebdavStatus {
  configured: boolean;
  provider: "jianguoyun" | "custom";
  url: string;
  username: string;
  root: string;
  has_password: boolean;
  presets: WebdavPreset[];
}
export interface CloudFile {
  name: string;
  size: number;
  modified_at: string;
  path: string;
}
export interface CloudJobLog {
  at: number;
  level: "info" | "warn" | "error";
  text: string;
}
export interface CloudJob {
  id: string;
  status: "running" | "done" | "failed";
  logs: CloudJobLog[];
  result: {
    backup_id: string;
    backup_name: string;
    path: string;
    report: {
      integrity: boolean;
      schema_version: string | null;
      foreign_key_violations: number;
      counts: { accounts: number; memories: number; links: number; tokens: number };
    };
    preview: Preview;
  } | null;
  error: string | null;
  started_at: number;
}
export interface Audit {
  id: string;
  action: string;
  actor_id: string;
  result: string;
  reason?: string;
  created_at: number;
  target_ids?: string[];
}
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
async function refreshCsrf(): Promise<boolean> {
  try {
    const response = await fetch("/api/v1/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const result = (await response.json()) as {
      data?: { csrf_token?: string };
    };
    const token = result.data?.csrf_token;
    if (!response.ok || !token) return false;
    csrf = token;
    return true;
  } catch {
    return false;
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>(path, method, body, signal, true);
}
async function request<T>(
  path: string,
  method: string,
  body: unknown,
  signal: AbortSignal | undefined,
  retry: boolean,
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["x-csrf-token"] = csrf;
  const response = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  let result: {
    ok?: boolean;
    data?: T;
    error?: { message?: string; code?: string };
  };
  try {
    result = await response.json();
  } catch {
    throw new ApiError(
      "服务器返回了无法读取的响应，请检查服务状态。",
      "INVALID_RESPONSE",
      response.status,
    );
  }
  if (!response.ok || result.ok === false) {
    if (
      retry &&
      response.status === 403 &&
      result.error?.code === "FORBIDDEN" &&
      path !== "/auth/session" &&
      (await refreshCsrf())
    )
      return request<T>(path, method, body, signal, false);
    if (response.status === 401 && !path.startsWith("/auth/"))
      window.dispatchEvent(new Event("session-expired"));
    const messages: Record<string, string> = {
      UNAUTHENTICATED: "密码不正确，请重新输入。",
      FORBIDDEN: "请求被安全校验拦截，请刷新页面后重试。",
      NOT_FOUND: "接口不存在，请刷新页面。",
      RATE_LIMITED: "尝试过于频繁，请一分钟后再试。",
      SERVER_BUSY: "服务器繁忙，请稍后重试。",
      OVERLOADED: "服务繁忙，请稍后重试。",
      DATABASE_UNAVAILABLE: "数据库暂时不可用，请稍后重试。",
      BACKUP_INCOMPATIBLE: "备份的数据结构版本不兼容，请选择 v0.2.3 及之后生成的备份。",
      SCHEMA_UNSUPPORTED: "数据结构版本不兼容。",
    };
    throw new ApiError(
      messages[result.error?.code ?? ""] ||
        result.error?.message ||
        "操作未完成，请稍后重试。",
      result.error?.code || "REQUEST_FAILED",
      response.status,
    );
  }
  return result.data as T;
}
export function query(
  values: Record<string, string | number | boolean | undefined>,
) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(values))
    if (v !== undefined && v !== "") p.set(k, String(v));
  return "?" + p;
}
function randomId(): string {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (source && typeof source.getRandomValues === "function") source.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function writeBody(data: Record<string, unknown>) {
  return { ...data, request_id: randomId() };
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
