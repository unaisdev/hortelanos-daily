-- Profiles: burned handles (released on rename) + indexes for history/ranking queries.

-- A handle that someone abandoned by renaming. Nobody can claim it again
-- (not even the previous owner) until an admin deletes the row:
--   npm run admin:release-handle -- <handle>
CREATE TABLE IF NOT EXISTS released_handles (
  instagram TEXT PRIMARY KEY,
  released_by_device TEXT NOT NULL,
  released_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_wins_instagram ON daily_wins (instagram);
CREATE INDEX IF NOT EXISTS idx_daily_wins_device ON daily_wins (device_id);

-- One active owner per handle. Fails if production already has duplicates:
-- check first with
--   SELECT instagram, COUNT(*) FROM device_identities GROUP BY instagram HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_identities_instagram ON device_identities (instagram);
