-- Player-chosen profile pictures. Stored per DEVICE (not per @) so a rename keeps the photo.
-- The client shrinks images to 128x128 JPEG (~5-10 KB) before upload; `image` is base64.
CREATE TABLE IF NOT EXISTS device_avatars (
  device_id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  image TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
