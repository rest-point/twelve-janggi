CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','operator','admin')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  origin TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
) STRICT;
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE auth_limits (
  key TEXT PRIMARY KEY, window_at INTEGER NOT NULL, count INTEGER NOT NULL
) STRICT;
CREATE TABLE games (
  id TEXT PRIMARY KEY, ruleset TEXT NOT NULL, initial_state TEXT NOT NULL, current_state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0), turn_started_at INTEGER NOT NULL,
  deadline_at INTEGER, result TEXT, termination TEXT, created_at INTEGER NOT NULL,
  CHECK((result IS NULL AND deadline_at IS NOT NULL AND termination IS NULL) OR
        (result IS NOT NULL AND deadline_at IS NULL AND termination IS NOT NULL))
) STRICT;
CREATE INDEX games_deadline ON games(deadline_at) WHERE result IS NULL;
CREATE TABLE game_participants (
  game_id TEXT NOT NULL REFERENCES games(id), side INTEGER NOT NULL CHECK(side IN (0,1)),
  user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(game_id,side), UNIQUE(game_id,user_id)
) STRICT;
CREATE TABLE moves (
  game_id TEXT NOT NULL REFERENCES games(id), ply INTEGER NOT NULL, side INTEGER NOT NULL CHECK(side IN (0,1)),
  action TEXT NOT NULL, elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0), position_key TEXT NOT NULL,
  request_id TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(game_id,ply), UNIQUE(game_id,request_id)
) STRICT;
CREATE TABLE game_requests (
  game_id TEXT NOT NULL REFERENCES games(id), request_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  payload TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(game_id,request_id)
) STRICT;
CREATE TABLE game_events (
  game_id TEXT NOT NULL REFERENCES games(id), revision INTEGER NOT NULL, kind TEXT NOT NULL,
  received_at INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(game_id,revision)
) STRICT;
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
