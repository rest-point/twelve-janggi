-- Keep existing games/batches and their insertion order. Only live pairs must be unique.
CREATE TABLE migration_005_games AS SELECT * FROM model_batch_games;
DROP TABLE model_batch_games;
CREATE TABLE migration_005_batches AS SELECT rowid AS original_rowid,* FROM model_batches;
DROP TABLE model_batches;
CREATE TABLE migration_005_series AS SELECT * FROM model_series;
DROP TABLE model_series;
CREATE TABLE model_series (
  id TEXT PRIMARY KEY, model_a TEXT NOT NULL REFERENCES model_versions(id),
  model_b TEXT NOT NULL REFERENCES model_versions(id), created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, deleted_at INTEGER, deleted_by TEXT REFERENCES guests(user_id)
) STRICT;
INSERT INTO model_series(id,model_a,model_b,created_at,updated_at)
  SELECT id,model_a,model_b,created_at,updated_at FROM migration_005_series;
CREATE UNIQUE INDEX model_series_active_pair ON model_series(model_a,model_b) WHERE deleted_at IS NULL;
CREATE TABLE model_batches (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES model_series(id),
  requested_by TEXT NOT NULL REFERENCES guests(user_id), request_id TEXT NOT NULL,
  seed INTEGER NOT NULL, game_count INTEGER NOT NULL, config TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(requested_by,request_id)
) STRICT;
INSERT INTO model_batches(rowid,id,series_id,requested_by,request_id,seed,game_count,config,created_at)
  SELECT original_rowid,id,series_id,requested_by,request_id,seed,game_count,config,created_at FROM migration_005_batches;
CREATE INDEX model_batches_series ON model_batches(series_id,created_at);
CREATE TABLE model_batch_games (
  batch_id TEXT NOT NULL REFERENCES model_batches(id), game_index INTEGER NOT NULL,
  match_id TEXT NOT NULL UNIQUE REFERENCES model_matches(id), PRIMARY KEY(batch_id,game_index)
) STRICT;
INSERT INTO model_batch_games SELECT * FROM migration_005_games;
DROP TABLE migration_005_games;
DROP TABLE migration_005_batches;
DROP TABLE migration_005_series;

-- Mutable, plain team notes never alter an immutable model manifest or executable.
CREATE TABLE model_descriptions (
  registry_id TEXT PRIMARY KEY REFERENCES model_versions(id), developer TEXT NOT NULL,
  characteristics TEXT NOT NULL, motivation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL REFERENCES guests(user_id)
) STRICT;
