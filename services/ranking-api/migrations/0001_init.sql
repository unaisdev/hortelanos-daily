-- Daily wins board. One row per (game, day, device) and per (game, day, instagram).

CREATE TABLE IF NOT EXISTS daily_wins (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL,
  play_date TEXT NOT NULL,
  seed TEXT NOT NULL,
  instagram TEXT NOT NULL,
  device_id TEXT NOT NULL,
  won_at TEXT NOT NULL,
  alive_count INTEGER,
  turns INTEGER,
  CHECK (length(game_id) BETWEEN 1 AND 32),
  CHECK (length(play_date) = 10),
  CHECK (length(instagram) BETWEEN 1 AND 30),
  CHECK (length(device_id) BETWEEN 8 AND 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wins_game_date_device
  ON daily_wins (game_id, play_date, device_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wins_game_date_ig
  ON daily_wins (game_id, play_date, instagram);

CREATE INDEX IF NOT EXISTS idx_wins_game_date_won
  ON daily_wins (game_id, play_date, won_at);
