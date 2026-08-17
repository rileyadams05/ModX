PRAGMA foreign_keys = ON;

ALTER TABLE table_releases ADD COLUMN future_service_support INTEGER NOT NULL DEFAULT 0
  CHECK(future_service_support IN (0, 1));

ALTER TABLE table_releases ADD COLUMN maintenance_policy TEXT NOT NULL DEFAULT 'uploader'
  CHECK(maintenance_policy IN ('uploader', 'community'));
