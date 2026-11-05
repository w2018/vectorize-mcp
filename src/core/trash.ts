import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { trashSchema } from "./trash-schema.js";
import type { TrashItemSummary, TrashKind } from "./types.js";

export interface TrashInsert {
  id: string;
  kind: TrashKind;
  source_subject_id: string;
  source_label: string;
  target_id: string;
  label: string;
  payload: unknown;
  schema_version: number;
  deleted_at: number;
  actor: string;
}

/** Independent SQLite file that stores deleted records as unowned snapshots. */
export class TrashVault {
  private db: Database.Database;
  constructor(
    public readonly path: string,
    private readonly readonlyMode = false,
  ) {
    if (!readonlyMode && path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path, { readonly: readonlyMode });
    if (!readonlyMode) {
      this.db.pragma("journal_mode=WAL");
      this.db.pragma("synchronous=FULL");
      this.db.exec(trashSchema);
      this.db
        .prepare("INSERT OR IGNORE INTO metadata VALUES (?,?)")
        .run("schema_version", "1");
    }
  }
  insert(record: TrashInsert): TrashItemSummary {
    const payload = JSON.stringify(record.payload);
    const size = Buffer.byteLength(payload);
    this.db
      .prepare(
        "INSERT INTO trash(id,kind,source_subject_id,source_label,target_id,label,payload,schema_version,size_bytes,deleted_at,actor,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        record.id,
        record.kind,
        record.source_subject_id,
        record.source_label,
        record.target_id,
        record.label,
        payload,
        record.schema_version,
        size,
        record.deleted_at,
        record.actor,
        "pending",
      );
    return this.summary(this.db.prepare("SELECT * FROM trash WHERE id=?").get(record.id));
  }
  markCommitted(id: string) {
    this.db.prepare("UPDATE trash SET state='committed' WHERE id=?").run(id);
  }
  remove(id: string) {
    this.db.prepare("DELETE FROM trash WHERE id=?").run(id);
  }
  list(filters: { kind?: string; offset?: number; limit?: number } = {}) {
    const where = filters.kind ? " WHERE kind=?" : "";
    const args = filters.kind ? [filters.kind] : [];
    const total = Number(
      (this.db.prepare("SELECT count(*) n FROM trash" + where).get(...args) as { n: number }).n,
    );
    const limit = Math.max(1, Math.min(100, filters.limit ?? 20));
    const offset = Math.max(0, filters.offset ?? 0);
    const rows = this.db
      .prepare(
        "SELECT * FROM trash" + where + " ORDER BY deleted_at DESC,id LIMIT ? OFFSET ?",
      )
      .all(...args, limit, offset);
    return { items: rows.map((r) => this.summary(r)), total, offset, limit };
  }
  get(id: string) {
    const row = this.db.prepare("SELECT * FROM trash WHERE id=?").get(id);
    if (!row) return undefined;
    return {
      ...this.summary(row),
      payload: JSON.parse(String((row as Record<string, unknown>).payload)),
      schema_version: Number((row as Record<string, unknown>).schema_version),
    };
  }
  delete(ids: string[]) {
    const missing: string[] = [];
    let deleted = 0;
    const remove = this.db.prepare("DELETE FROM trash WHERE id=?");
    const tx = this.db.transaction((list: string[]) => {
      for (const id of list) {
        if (remove.run(id).changes) deleted++;
        else missing.push(id);
      }
    });
    tx(ids);
    return { deleted, missing };
  }
  /** Remove every snapshot that belonged to a permanently deleted account. */
  purgeSubject(subjectId: string) {
    return this.db
      .prepare("DELETE FROM trash WHERE source_subject_id=?")
      .run(subjectId).changes;
  }
  reconcile(sourceExists: (kind: TrashKind, targetId: string) => boolean) {
    const rows = this.db
      .prepare("SELECT id,kind,target_id,state FROM trash")
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      const exists = sourceExists(
        String(row.kind) as TrashKind,
        String(row.target_id),
      );
      if (row.state === "pending") {
        if (exists) this.remove(String(row.id));
        else this.markCommitted(String(row.id));
      } else if (row.kind === "memory" && exists) {
        // A committed snapshot whose memory exists again was restored but its
        // cleanup was interrupted; drop the stale snapshot.
        this.remove(String(row.id));
      }
    }
  }
  private summary(row: unknown): TrashItemSummary {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      kind: String(r.kind) as TrashKind,
      source_subject_id: String(r.source_subject_id),
      source_label: String(r.source_label),
      target_id: String(r.target_id),
      label: String(r.label),
      deleted_at: Number(r.deleted_at),
      actor: String(r.actor),
      size_bytes: Number(r.size_bytes),
      state: String(r.state) as "pending" | "committed",
    };
  }
  close() {
    this.db.close();
  }
}
