export const schema = `
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subjects(id TEXT PRIMARY KEY,label TEXT NOT NULL,access_state TEXT NOT NULL DEFAULT 'unbound',auth_epoch INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES subjects(id),name TEXT NOT NULL,UNIQUE(subject_id,name));
CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES subjects(id),label TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,status TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_token ON tokens(subject_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES subjects(id),space_id TEXT NOT NULL REFERENCES spaces(id),content_hash TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,merged_into TEXT REFERENCES memories(id),data TEXT NOT NULL,UNIQUE(subject_id,space_id,content_hash));
CREATE INDEX IF NOT EXISTS memory_scope ON memories(subject_id,space_id,status);
CREATE TABLE IF NOT EXISTS versions(memory_id TEXT NOT NULL REFERENCES memories(id),revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(memory_id,revision));
CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES subjects(id),source_id TEXT NOT NULL REFERENCES memories(id),target_id TEXT NOT NULL REFERENCES memories(id),type TEXT NOT NULL,strength REAL NOT NULL CHECK(strength BETWEEN 0 AND 1),revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,CHECK(source_id<>target_id),UNIQUE(source_id,target_id,type));
CREATE TABLE IF NOT EXISTS vectors(memory_id TEXT PRIMARY KEY REFERENCES memories(id),revision INTEGER NOT NULL,model TEXT NOT NULL,vector BLOB NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,subject_id UNINDEXED,terms);
CREATE TABLE IF NOT EXISTS dedup(actor TEXT NOT NULL,tool TEXT NOT NULL,request_id TEXT NOT NULL,args_hash TEXT NOT NULL,response TEXT NOT NULL,snapshots TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(actor,tool,request_id));
CREATE TABLE IF NOT EXISTS previews(digest TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,config_revision INTEGER NOT NULL,expires_at INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,event TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS query_terms(memory_id TEXT NOT NULL REFERENCES memories(id),term TEXT NOT NULL,count INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,PRIMARY KEY(memory_id,term));
CREATE TABLE IF NOT EXISTS imports(subject_id TEXT NOT NULL,dataset_id TEXT NOT NULL,export_id TEXT NOT NULL,report TEXT NOT NULL,PRIMARY KEY(subject_id,dataset_id,export_id));
CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY,path TEXT NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS memories_scope_insert BEFORE INSERT ON memories BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM spaces WHERE id=NEW.space_id AND subject_id=NEW.subject_id) THEN RAISE(ABORT,'SCOPE_VIOLATION') END;
END;
CREATE TRIGGER IF NOT EXISTS memories_scope_update BEFORE UPDATE OF subject_id,space_id ON memories BEGIN
 SELECT CASE WHEN NEW.subject_id<>OLD.subject_id OR NEW.space_id<>OLD.space_id THEN RAISE(ABORT,'SCOPE_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS spaces_scope_update BEFORE UPDATE OF subject_id ON spaces BEGIN
 SELECT CASE WHEN NEW.subject_id<>OLD.subject_id THEN RAISE(ABORT,'SCOPE_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS links_scope_insert BEFORE INSERT ON links BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM memories a JOIN memories b ON a.space_id=b.space_id AND a.subject_id=b.subject_id WHERE a.id=NEW.source_id AND b.id=NEW.target_id AND a.subject_id=NEW.subject_id) THEN RAISE(ABORT,'SCOPE_VIOLATION') END;
END;
CREATE TRIGGER IF NOT EXISTS links_scope_update BEFORE UPDATE OF source_id,target_id,subject_id ON links BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM memories a JOIN memories b ON a.space_id=b.space_id AND a.subject_id=b.subject_id WHERE a.id=NEW.source_id AND b.id=NEW.target_id AND a.subject_id=NEW.subject_id) THEN RAISE(ABORT,'SCOPE_VIOLATION') END;
END;
CREATE TRIGGER IF NOT EXISTS vectors_revision_insert BEFORE INSERT ON vectors BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM memories WHERE id=NEW.memory_id AND revision=NEW.revision) THEN RAISE(ABORT,'VECTOR_REVISION_MISMATCH') END;
END;
CREATE TRIGGER IF NOT EXISTS vectors_revision_update BEFORE UPDATE ON vectors BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM memories WHERE id=NEW.memory_id AND revision=NEW.revision) THEN RAISE(ABORT,'VECTOR_REVISION_MISMATCH') END;
END;
CREATE TRIGGER IF NOT EXISTS query_terms_count_insert BEFORE INSERT ON query_terms BEGIN
 SELECT CASE WHEN typeof(NEW.count)<>'integer' OR NEW.count<0 THEN RAISE(ABORT,'COUNTER_OVERFLOW') END;
END;
CREATE TRIGGER IF NOT EXISTS query_terms_count_update BEFORE UPDATE OF count ON query_terms BEGIN
 SELECT CASE WHEN typeof(NEW.count)<>'integer' OR NEW.count<0 THEN RAISE(ABORT,'COUNTER_OVERFLOW') END;
END;
`;
