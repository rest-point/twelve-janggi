CREATE TABLE models (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE model_versions (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES models(id), legacy_registry_id TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL, manifest TEXT NOT NULL, environment TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE model_players (
  user_id TEXT PRIMARY KEY REFERENCES users(id), model_version_id TEXT NOT NULL UNIQUE REFERENCES model_versions(id)
) STRICT;
ALTER TABLE games ADD COLUMN mode TEXT NOT NULL DEFAULT 'pvp';
ALTER TABLE games ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE games ADD COLUMN infra_error TEXT;
ALTER TABLE rooms ADD COLUMN mode TEXT NOT NULL DEFAULT 'pvp';
ALTER TABLE rooms ADD COLUMN model_version_id TEXT REFERENCES model_versions(id);
CREATE TABLE room_seats_new (
  room_id TEXT NOT NULL REFERENCES rooms(id), side INTEGER NOT NULL CHECK(side IN (0,1)),
  user_id TEXT NOT NULL REFERENCES users(id), ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)),
  ready_revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room_id,side), UNIQUE(room_id,user_id)
) STRICT;
INSERT INTO room_seats_new(room_id,side,user_id,ready) SELECT room_id,side,user_id,ready FROM room_seats;
DROP TABLE room_seats;
ALTER TABLE room_seats_new RENAME TO room_seats;
CREATE INDEX room_seats_user ON room_seats(user_id);
CREATE TABLE model_matches (
  id TEXT PRIMARY KEY, requested_by TEXT NOT NULL REFERENCES guests(user_id), request_id TEXT NOT NULL,
  model_a TEXT NOT NULL REFERENCES model_versions(id), model_b TEXT NOT NULL REFERENCES model_versions(id),
  first INTEGER NOT NULL CHECK(first IN (0,1)), seed INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','error')),
  game_id TEXT REFERENCES games(id), attempt INTEGER NOT NULL DEFAULT 0, attempt_token TEXT,
  error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER, UNIQUE(requested_by,request_id)
) STRICT;
CREATE TABLE model_match_attempts (
  match_id TEXT NOT NULL REFERENCES model_matches(id), attempt INTEGER NOT NULL,
  game_id TEXT NOT NULL UNIQUE REFERENCES games(id), error TEXT, PRIMARY KEY(match_id,attempt)
) STRICT;
CREATE TABLE model_attempts (
  game_id TEXT NOT NULL REFERENCES games(id), revision INTEGER NOT NULL, side INTEGER NOT NULL,
  stage TEXT NOT NULL, elapsed_ms REAL NOT NULL, accepted INTEGER NOT NULL CHECK(accepted IN (0,1)), error TEXT,
  PRIMARY KEY(game_id,revision,side,stage)
) STRICT;
