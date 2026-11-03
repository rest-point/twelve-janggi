CREATE INDEX game_participants_user ON game_participants(user_id,game_id);
CREATE INDEX games_history ON games(created_at DESC,id DESC);
CREATE INDEX model_versions_identity ON model_versions(model_id,created_at DESC);
