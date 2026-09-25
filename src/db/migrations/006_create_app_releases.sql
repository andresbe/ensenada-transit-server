CREATE TABLE IF NOT EXISTS app_releases (
  package_name TEXT NOT NULL CHECK (package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  version_name TEXT NOT NULL CHECK (length(btrim(version_name)) > 0),
  version_code INTEGER NOT NULL CHECK (version_code > 0),
  min_supported_version_code INTEGER NOT NULL DEFAULT 1
    CHECK (min_supported_version_code > 0 AND min_supported_version_code <= version_code),
  apk_url TEXT NOT NULL CHECK (apk_url ~ '^https://[^[:space:]]+$'),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 9007199254740991),
  release_notes JSONB NOT NULL CHECK (jsonb_typeof(release_notes) = 'array'),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (package_name, version_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_releases_active_package
  ON app_releases (package_name) WHERE active = TRUE;
