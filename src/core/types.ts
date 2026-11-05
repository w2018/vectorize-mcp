export type MemoryType =
  | "fact"
  | "preference"
  | "profile"
  | "project"
  | "decision"
  | "lesson"
  | "task";
export type LinkType = "related_to" | "supports" | "contradicts" | "supersedes";
export interface Context {
  subjectId: string;
  tokenId: string;
  admin?: boolean;
  authEpoch?: number;
}
export interface Scope {
  space_ids?: string[];
}
export interface Source {
  platform?: string;
  agent?: string;
  conversation_id?: string;
  message_id?: string;
  reference?: string;
}
export interface Profile {
  profile_key: string;
  basis: "explicit" | "inferred";
  confidence?: number;
  evidence?: string[];
}
export interface MemoryFields {
  type: MemoryType;
  title?: string;
  content: string;
  keywords?: string[];
  importance?: number;
  sensitivity?: "normal" | "private";
  valid_from?: number | null;
  valid_until?: number | null;
  profile?: Profile | null;
}
export interface Request {
  request_id: string;
  scope?: Scope;
  space_id?: string;
}
export interface AddInput extends Request, MemoryFields {
  source?: Source;
  distinct_reason?: string;
  embedding?: Embedding;
}
export interface UpdateInput extends Request {
  id: string;
  expected_revision: number;
  patch: Partial<MemoryFields>;
  reason: string;
  source?: Source;
  confirm_current?: { evidence: string; source?: Source };
}
export interface VersionRef {
  id: string;
  revision: number;
}
export interface MergeInput extends Request {
  target: VersionRef;
  sources: VersionRef[];
  final_content: string;
  reason: string;
  source?: Source;
}
export interface LinkInput extends Request {
  action: "upsert" | "remove";
  source_id: string;
  target_id: string;
  type: LinkType;
  strength?: number;
  expected_revision?: number;
}
export interface ArchiveInput extends Request {
  action: "preview" | "execute";
  items: VersionRef[];
  reason: string;
  preview_token?: string;
}
export interface RestoreInput extends Request {
  id: string;
  expected_revision: number;
  reason: string;
}
export interface Embedding {
  model: string;
  vector: number[];
}
export interface SearchInput extends Request {
  query: string;
  keywords?: string[];
  limit?: number;
  token_budget?: number;
  types?: MemoryType[];
  embedding?: Embedding;
}
export interface GetInput {
  scope?: Scope;
  ids: string[];
  token_budget?: number;
  include_archived?: boolean;
}
export interface Config {
  revision: number;
  defaultLimit: number;
  tokenBudget: number;
  lexicalThreshold: number;
  semanticThreshold: number;
  similarityThreshold: number;
  importanceFactor: number;
  frequencyFactor: number;
  recencyFactor: number;
  halfLifeDays: number;
  frequencyCap: number;
  agentArchiveEnabled: boolean;
  allowInferredProfiles: boolean;
  purgeEnabled: boolean;
  protectedImportance: number;
  minArchivedDays: number;
  embeddingModel: string;
  embeddingBaseUrl: string;
  embeddingDimension: number;
}
export interface Memory extends Required<Omit<MemoryFields, "profile">> {
  id: string;
  subject_id: string;
  space_id: string;
  content_hash: string;
  revision: number;
  retrieval_count: string;
  created_at: number;
  updated_at: number;
  confirmed_at: number;
  last_retrieved_at: number | null;
  status: "active" | "archived";
  archived_at: number | null;
  archive_reason: string | null;
  merged_into: string | null;
  embedding_state: "pending" | "ready" | "failed";
  profile: Profile | null;
  sources: Source[];
  weight: number;
}
export interface SearchItem extends Memory {
  relevance: number;
  scoring_mode: "semantic" | "lexical";
  via: "direct" | "association" | "both";
}
export type ReturnedMemory = Pick<
  Memory,
  | "id"
  | "revision"
  | "content"
  | "type"
  | "importance"
  | "weight"
  | "retrieval_count"
  | "valid_until"
>;
export type ReturnedSearchItem = ReturnedMemory &
  Pick<SearchItem, "relevance" | "scoring_mode" | "via">;
export interface SearchData {
  items: ReturnedSearchItem[];
  mode: "semantic" | "lexical";
  estimated_tokens: number;
  estimated: true;
  budget_exhausted: boolean;
}
export interface Envelope<T> {
  ok: true;
  request_id?: string;
  data: T;
  meta: {
    config_revision: number;
    formula_version: number;
    as_of: number;
    warnings: string[];
  };
}
export interface MemoryFilters {
  status?: "active" | "archived";
  type?: MemoryType;
  space_id?: string;
  query?: string;
  limit?: number;
  offset?: number;
  min_importance?: number;
}
export interface TokenInfo {
  id: string;
  subject_id: string;
  label: string;
  status: "active" | "revoked";
  revision: number;
  created_at: number;
  revoked_at: number | null;
}
export interface TokenResult extends TokenInfo {
  token?: string;
  secret_available: boolean;
  default_space_id: string;
}
export interface Preview {
  preview_token: string;
  expires_at: number;
  [key: string]: unknown;
}
export type TrashKind = "memory" | "token";
export interface TrashItemSummary {
  id: string;
  kind: TrashKind;
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
export type RestoreLevel = "green" | "orange" | "red";
export interface RestoreIssue {
  level: RestoreLevel;
  code: string;
  message: string;
}
export interface RestoreCheck {
  trash_id: string;
  target_id: string;
  kind: TrashKind;
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

export interface ExportPayload {
  schema_version: 1;
  dataset_id: string;
  export_id: string;
  exported_at: number;
  subject_id: string;
  memories: Memory[];
  links: MemoryLink[];
  query_terms?: {
    memory_id: string;
    term: string;
    count: string;
    last_seen_at: number;
  }[];
  checksum: string;
}
export interface MemoryLink {
  id: string;
  subject_id: string;
  source_id: string;
  target_id: string;
  type: LinkType;
  strength: number;
  revision: number;
  created_at: number;
  updated_at: number;
}
export interface PreparedSearch {
  warnings?: string[];
  ctx: Context;
  input: SearchInput;
  items: SearchItem[];
  configRevision: number;
  asOf: number;
  mode: "semantic" | "lexical";
  budgetExhausted: boolean;
  estimatedTokens: number;
}
export class DomainError extends Error {
  constructor(
    public code: string,
    message = code,
    public retryable = false,
    public details: unknown = undefined,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
