-- Device Instagram identity + rename budget (2 renames / UTC day after first set).

CREATE TABLE IF NOT EXISTS device_identities (
  device_id TEXT PRIMARY KEY NOT NULL,
  instagram TEXT NOT NULL,
  change_date TEXT NOT NULL,
  renames_today INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  CHECK (length(device_id) BETWEEN 8 AND 64),
  CHECK (length(instagram) BETWEEN 1 AND 30),
  CHECK (length(change_date) = 10),
  CHECK (renames_today >= 0)
);

CREATE INDEX IF NOT EXISTS idx_identities_ig ON device_identities (instagram);
