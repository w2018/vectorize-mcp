export const trashSchema = `
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trash(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('memory','token')),
 source_subject_id TEXT NOT NULL,
 source_label TEXT NOT NULL,
 target_id TEXT NOT NULL,
 label TEXT NOT NULL,
 payload TEXT NOT NULL,
 schema_version INTEGER NOT NULL,
 size_bytes INTEGER NOT NULL,
 deleted_at INTEGER NOT NULL,
 actor TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','committed'))
);
CREATE INDEX IF NOT EXISTS trash_created ON trash(deleted_at DESC);
CREATE INDEX IF NOT EXISTS trash_lookup ON trash(kind,target_id);
`;