export const schema = `
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subjects(id TEXT PRIMARY KEY,label TEXT NOT NULL,access_state TEXT NOT NULL DEFAULT 'unbound',auth_epoch INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'standard' CHECK(kind IN ('standard','qqbot')));
CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES subjects(id),label TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,status TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_token ON tokens(subject_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES subjects(id),content_hash TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,merged_into TEXT REFERENCES memories(id),data TEXT NOT NULL,UNIQUE(subject_id,content_hash));
CREATE TABLE IF NOT EXISTS bot_profiles(subject_id TEXT PRIMARY KEY REFERENCES subjects(id),revision INTEGER NOT NULL,preset_id TEXT,persona_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS bot_persona_insert BEFORE INSERT ON bot_profiles WHEN NEW.persona_memory_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM memories WHERE id=NEW.persona_memory_id AND subject_id=NEW.subject_id AND status='active' AND json_extract(data,'$.type')='persona') THEN RAISE(ABORT,'PERSONA_REFERENCE_INVALID') END;
END;
CREATE TRIGGER IF NOT EXISTS bot_persona_update BEFORE UPDATE OF persona_memory_id ON bot_profiles WHEN NEW.persona_memory_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM memories WHERE id=NEW.persona_memory_id AND subject_id=NEW.subject_id AND status='active' AND json_extract(data,'$.type')='persona') THEN RAISE(ABORT,'PERSONA_REFERENCE_INVALID') END;
END;
CREATE TRIGGER IF NOT EXISTS detach_persona_delete BEFORE DELETE ON memories BEGIN
 UPDATE bot_profiles SET persona_memory_id=NULL,revision=revision+1,updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE persona_memory_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS detach_persona_type AFTER UPDATE OF data ON memories WHEN json_extract(NEW.data,'$.type')<>'persona' BEGIN
 UPDATE bot_profiles SET persona_memory_id=NULL,revision=revision+1 WHERE persona_memory_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS detach_persona_update AFTER UPDATE OF status ON memories WHEN NEW.status<>'active' BEGIN
 UPDATE bot_profiles SET persona_memory_id=NULL,revision=revision+1,updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE persona_memory_id=NEW.id;
END;
CREATE INDEX IF NOT EXISTS memory_scope ON memories(subject_id,status);
CREATE TRIGGER IF NOT EXISTS memories_subject_immutable BEFORE UPDATE OF subject_id ON memories BEGIN
 SELECT CASE WHEN NEW.subject_id<>OLD.subject_id THEN RAISE(ABORT,'SCOPE_IMMUTABLE') END;
END;
CREATE TABLE IF NOT EXISTS versions(memory_id TEXT NOT NULL REFERENCES memories(id),revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(memory_id,revision));
CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES subjects(id),source_id TEXT NOT NULL REFERENCES memories(id),target_id TEXT NOT NULL REFERENCES memories(id),type TEXT NOT NULL,strength REAL NOT NULL CHECK(strength BETWEEN 0 AND 1),revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,CHECK(source_id<>target_id),UNIQUE(source_id,target_id,type));
CREATE TABLE IF NOT EXISTS memory_similarity(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES subjects(id),source_id TEXT NOT NULL REFERENCES memories(id),target_id TEXT NOT NULL REFERENCES memories(id),similarity REAL NOT NULL CHECK(similarity BETWEEN 0 AND 1),basis TEXT NOT NULL CHECK(basis IN ('lexical','semantic','hybrid')),algorithm_version TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'auto' CHECK(status IN ('auto','confirmed','rejected')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,CHECK(source_id<>target_id),UNIQUE(subject_id,source_id,target_id));
CREATE INDEX IF NOT EXISTS similarity_source ON memory_similarity(subject_id,source_id,similarity);
CREATE INDEX IF NOT EXISTS similarity_target ON memory_similarity(subject_id,target_id,similarity);
CREATE TRIGGER IF NOT EXISTS similarity_scope_insert BEFORE INSERT ON memory_similarity BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM memories a JOIN memories b ON a.subject_id=b.subject_id WHERE a.id=NEW.source_id AND b.id=NEW.target_id AND a.subject_id=NEW.subject_id) THEN RAISE(ABORT,'SCOPE_VIOLATION') END;
END;
CREATE TRIGGER IF NOT EXISTS similarity_cleanup_delete BEFORE DELETE ON memories BEGIN
 DELETE FROM memory_similarity WHERE source_id=OLD.id OR target_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS vectors(memory_id TEXT PRIMARY KEY REFERENCES memories(id),revision INTEGER NOT NULL,model TEXT NOT NULL,vector BLOB NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,subject_id UNINDEXED,terms);
CREATE TABLE IF NOT EXISTS dedup(actor TEXT NOT NULL,tool TEXT NOT NULL,request_id TEXT NOT NULL,args_hash TEXT NOT NULL,response TEXT NOT NULL,snapshots TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(actor,tool,request_id));
CREATE TABLE IF NOT EXISTS previews(digest TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,config_revision INTEGER NOT NULL,expires_at INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,event TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS query_terms(memory_id TEXT NOT NULL REFERENCES memories(id),term TEXT NOT NULL,count INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,PRIMARY KEY(memory_id,term));
CREATE TABLE IF NOT EXISTS imports(subject_id TEXT NOT NULL,dataset_id TEXT NOT NULL,export_id TEXT NOT NULL,report TEXT NOT NULL,PRIMARY KEY(subject_id,dataset_id,export_id));
CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY,path TEXT NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,label TEXT NOT NULL DEFAULT '');
CREATE TRIGGER IF NOT EXISTS links_scope_insert BEFORE INSERT ON links BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM memories a JOIN memories b ON a.subject_id=b.subject_id WHERE a.id=NEW.source_id AND b.id=NEW.target_id AND a.subject_id=NEW.subject_id) THEN RAISE(ABORT,'SCOPE_VIOLATION') END;
END;
CREATE TRIGGER IF NOT EXISTS links_scope_update BEFORE UPDATE OF source_id,target_id,subject_id ON links BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM memories a JOIN memories b ON a.subject_id=b.subject_id WHERE a.id=NEW.source_id AND b.id=NEW.target_id AND a.subject_id=NEW.subject_id) THEN RAISE(ABORT,'SCOPE_VIOLATION') END;
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
