ALTER TABLE table_releases ADD COLUMN github_owner TEXT;
ALTER TABLE table_releases ADD COLUMN github_repo TEXT;
ALTER TABLE table_releases ADD COLUMN github_branch TEXT;
ALTER TABLE table_releases ADD COLUMN github_path TEXT;
ALTER TABLE table_releases ADD COLUMN github_blob_sha TEXT;
ALTER TABLE table_releases ADD COLUMN download_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_table_releases_github_path
  ON table_releases(github_owner, github_repo, github_path);
