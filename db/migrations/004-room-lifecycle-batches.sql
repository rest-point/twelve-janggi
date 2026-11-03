-- Rooms are temporary lobby state; completed game records remain independent.
CREATE TABLE saved_room_seats AS SELECT * FROM room_seats;
DROP TABLE room_seats;
CREATE TABLE rooms_new (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('waiting','playing')),
  game_id TEXT UNIQUE REFERENCES games(id), revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'pvp',
  model_version_id TEXT REFERENCES model_versions(id)
) STRICT;
INSERT INTO rooms_new SELECT id,title,owner_id,status,game_id,revision,created_at,mode,model_version_id
  FROM rooms WHERE status IN ('waiting','playing')
  AND (game_id IS NULL OR game_id IN (SELECT id FROM games WHERE result IS NULL AND infra_error IS NULL));
DROP TABLE rooms;
ALTER TABLE rooms_new RENAME TO rooms;
CREATE TABLE room_seats (
  room_id TEXT NOT NULL REFERENCES rooms(id), side INTEGER NOT NULL CHECK(side IN (0,1)),
  user_id TEXT NOT NULL REFERENCES users(id), ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)),
  ready_revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room_id,side), UNIQUE(room_id,user_id)
) STRICT;
INSERT INTO room_seats SELECT s.* FROM saved_room_seats s JOIN rooms r ON r.id=s.room_id;
DROP TABLE saved_room_seats;
CREATE INDEX room_seats_user ON room_seats(user_id);
CREATE TABLE model_series (
  id TEXT PRIMARY KEY, model_a TEXT NOT NULL REFERENCES model_versions(id),
  model_b TEXT NOT NULL REFERENCES model_versions(id), created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, UNIQUE(model_a,model_b)
) STRICT;
CREATE TABLE model_batches (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES model_series(id),
  requested_by TEXT NOT NULL REFERENCES guests(user_id), request_id TEXT NOT NULL,
  seed INTEGER NOT NULL, game_count INTEGER NOT NULL, config TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(requested_by,request_id)
) STRICT;
CREATE TABLE model_batch_games (
  batch_id TEXT NOT NULL REFERENCES model_batches(id), game_index INTEGER NOT NULL,
  match_id TEXT NOT NULL UNIQUE REFERENCES model_matches(id), PRIMARY KEY(batch_id,game_index)
) STRICT;
CREATE INDEX model_batches_series ON model_batches(series_id,created_at);
CREATE INDEX model_matches_status ON model_matches(status,created_at);
ALTER TABLE model_matches ADD COLUMN a_side INTEGER NOT NULL DEFAULT 0 CHECK(a_side IN (0,1));
ALTER TABLE model_matches ADD COLUMN opening TEXT NOT NULL DEFAULT '[]';
ALTER TABLE model_matches ADD COLUMN start_state TEXT;
-- Group earlier manual single games without deleting or rewriting their records.
INSERT INTO model_series
  SELECT id,a,b,created_at,latest FROM (
    SELECT id,min(model_a,model_b) a,max(model_a,model_b) b,created_at,
      max(created_at) OVER(PARTITION BY min(model_a,model_b),max(model_a,model_b)) latest,
      row_number() OVER(PARTITION BY min(model_a,model_b),max(model_a,model_b) ORDER BY created_at,id) n
    FROM model_matches
  ) WHERE n=1;
INSERT INTO model_batches
  SELECT j.id,s.id,j.requested_by,j.request_id,j.seed,1,
    '{"moveMs":60000,"openingPlies":0,"legacy":true}',j.created_at
  FROM model_matches j JOIN model_series s ON s.model_a=min(j.model_a,j.model_b) AND s.model_b=max(j.model_a,j.model_b)
  ORDER BY j.created_at,j.id;
INSERT INTO model_batch_games SELECT id,0,id FROM model_matches;
