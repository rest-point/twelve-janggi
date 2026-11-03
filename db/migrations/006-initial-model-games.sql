-- Retire the former automatic-opening results from the public model arena.
-- Keep every original batch/game/move and immutable execution version internally.
UPDATE model_series SET deleted_at=CAST(strftime('%s','now') AS INTEGER)*1000
WHERE deleted_at IS NULL AND EXISTS (
  SELECT 1 FROM model_batches b WHERE b.series_id=model_series.id
  AND coalesce(json_extract(b.config,'$.openingPlies'),0)>0
);

-- Migration runs before any workers start. Invalidate unfinished old work so a
-- restart cannot restore automatic openings or accept an old completion token.
UPDATE games SET infra_error=coalesce(infra_error,'opening-policy-retired')
WHERE result IS NULL AND id IN (
  SELECT j.game_id FROM model_matches j JOIN model_batch_games bg ON bg.match_id=j.id
  JOIN model_batches b ON b.id=bg.batch_id JOIN model_series s ON s.id=b.series_id
  WHERE s.deleted_at IS NOT NULL AND coalesce(json_extract(b.config,'$.openingPlies'),0)>0
  UNION
  SELECT a.game_id FROM model_match_attempts a JOIN model_batch_games bg ON bg.match_id=a.match_id
  JOIN model_batches b ON b.id=bg.batch_id JOIN model_series s ON s.id=b.series_id
  WHERE s.deleted_at IS NOT NULL AND coalesce(json_extract(b.config,'$.openingPlies'),0)>0
);
UPDATE model_attempts SET error='opening-policy-retired'
WHERE error='running' AND game_id IN (SELECT id FROM games WHERE infra_error='opening-policy-retired');
UPDATE model_matches SET status='error',error='opening-policy-retired',attempt_token=NULL
WHERE status IN ('queued','running') AND id IN (
  SELECT bg.match_id FROM model_batch_games bg JOIN model_batches b ON b.id=bg.batch_id
  JOIN model_series s ON s.id=b.series_id
  WHERE s.deleted_at IS NOT NULL AND coalesce(json_extract(b.config,'$.openingPlies'),0)>0
);
