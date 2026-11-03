-- Keep legacy accounts, sessions and match records intact. New guests have a
-- separate membership marker, so old account cookies cannot become guest seats.
CREATE TABLE guests (
  user_id TEXT PRIMARY KEY REFERENCES users(id), created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('waiting','playing','finished','closed')),
  game_id TEXT UNIQUE REFERENCES games(id), revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE room_seats (
  room_id TEXT NOT NULL REFERENCES rooms(id), side INTEGER NOT NULL CHECK(side IN (0,1)),
  user_id TEXT NOT NULL REFERENCES guests(user_id), ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)),
  PRIMARY KEY(room_id,side), UNIQUE(room_id,user_id)
) STRICT;
CREATE INDEX room_seats_user ON room_seats(user_id);
