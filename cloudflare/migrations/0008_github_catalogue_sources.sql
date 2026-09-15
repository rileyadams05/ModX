PRAGMA foreign_keys = ON;

ALTER TABLE table_releases ADD COLUMN source_url TEXT;
ALTER TABLE table_releases ADD COLUMN repository_url TEXT;
ALTER TABLE table_releases ADD COLUMN table_path TEXT;
ALTER TABLE table_releases ADD COLUMN original_source_url TEXT;
ALTER TABLE table_releases ADD COLUMN source_status TEXT NOT NULL DEFAULT 'unavailable'
  CHECK(source_status IN ('available', 'unavailable'));
ALTER TABLE table_releases ADD COLUMN maintenance_mode TEXT NOT NULL DEFAULT 'author'
  CHECK(maintenance_mode IN ('author', 'community'));
ALTER TABLE table_releases ADD COLUMN original_author_name TEXT;
ALTER TABLE table_releases ADD COLUMN current_maintainer_name TEXT;
ALTER TABLE table_releases ADD COLUMN current_maintainer_abuse_key TEXT;

UPDATE table_releases
SET original_author_name = contributor_name,
    current_maintainer_name = contributor_name,
    current_maintainer_abuse_key = uploader_abuse_key,
    maintenance_mode = CASE WHEN maintenance_policy = 'community' THEN 'community' ELSE 'author' END,
    source_status = 'unavailable';

CREATE TABLE maintenance_submissions (
  id TEXT PRIMARY KEY,
  table_release_id TEXT NOT NULL REFERENCES table_releases(id) ON DELETE CASCADE,
  contributor_name TEXT NOT NULL,
  contributor_abuse_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  table_path TEXT,
  notes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK(status IN ('pending_review', 'approved', 'rejected')),
  reviewed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);

CREATE INDEX idx_maintenance_submissions_review
  ON maintenance_submissions(table_release_id, status, created_at DESC);
