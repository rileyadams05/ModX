PRAGMA foreign_keys = ON;

ALTER TABLE table_releases ADD COLUMN release_url TEXT;
ALTER TABLE table_releases ADD COLUMN release_tag TEXT;
ALTER TABLE table_releases ADD COLUMN github_release_id TEXT;
ALTER TABLE table_releases ADD COLUMN release_commit_sha TEXT;
ALTER TABLE table_releases ADD COLUMN release_published_at TEXT;
ALTER TABLE table_releases ADD COLUMN release_checked_at TEXT;
ALTER TABLE table_releases ADD COLUMN release_asset_id TEXT;
ALTER TABLE table_releases ADD COLUMN release_asset_name TEXT;
ALTER TABLE table_releases ADD COLUMN release_asset_url TEXT;
ALTER TABLE table_releases ADD COLUMN release_asset_digest TEXT;

CREATE INDEX idx_table_releases_github_release
  ON table_releases(github_owner, github_repo, release_tag);

-- Existing pre-release-catalogue rows are preserved but remain unavailable until
-- they can be associated with a verified public GitHub Release.
UPDATE table_releases
SET source_status = 'unavailable'
WHERE release_url IS NULL;
