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
  active: number;
  archived: number;
  merged: number;
  total: number;
}
export function dataChanged() {
  window.dispatchEvent(new Event("memory-data-changed"));
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
  space_id: string;
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
export interface Space {
  id: string;
  name: string;
}
export interface Token {
  id: string;
  label: string;
  subject_id: string;
  status: string;
  created_at: number;
  last_used_at: number | null;
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
  embeddingModel: string;
  embeddingBaseUrl: string;
  embeddingDimension: number;
  [key: string]: unknown;
}
export interface Backup {
  id: string;
  created_at: number;
  size: number;
  sha256: string;
  verified_at?: number;
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
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
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
    if (response.status === 401 && !path.startsWith("/auth/"))
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      result.error?.message || "操作未完成，请稍后重试。",
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
export function writeBody(data: Record<string, unknown>) {
  return { ...data, request_id: crypto.randomUUID() };
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
