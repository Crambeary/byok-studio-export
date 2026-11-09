CREATE TABLE card_catalog (
      kind TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

CREATE TABLE card_installs (
      card_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      slug TEXT NOT NULL,
      version TEXT,
      installed_at INTEGER NOT NULL,
      dat_action TEXT,
      PRIMARY KEY (card_id, kind, slug)
    );

CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      project_id TEXT,
      file_id TEXT NOT NULL,
      created_at TEXT,
      data TEXT NOT NULL,
      mirrored_at INTEGER NOT NULL
    );

CREATE TABLE device_cards (
      card_id TEXT PRIMARY KEY,
      device_id TEXT,
      registration_code TEXT,
      firmware_version TEXT,
      label TEXT,
      auto_import INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

CREATE TABLE device_files (
      card_id TEXT NOT NULL,
      file_key TEXT NOT NULL,
      project_key TEXT NOT NULL,
      studio_file_id TEXT NOT NULL,
      studio_project_id TEXT,
      name TEXT,
      card_hash TEXT,
      studio_hash TEXT,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY (card_id, file_key)
    );

CREATE TABLE device_projects (
      card_id TEXT NOT NULL,
      project_key TEXT NOT NULL,
      studio_project_id TEXT NOT NULL,
      name TEXT,
      PRIMARY KEY (card_id, project_key)
    );

CREATE TABLE files (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        project_id TEXT NOT NULL,
        folder_id TEXT,
        type TEXT,
        is_trashed INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        data TEXT NOT NULL,
        mirrored_at INTEGER NOT NULL
      );

CREATE TABLE folders (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        project_id TEXT NOT NULL,
        parent_folder_id TEXT,
        is_trashed INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL,
        mirrored_at INTEGER NOT NULL
      );

CREATE TABLE id_map (
        temp_id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        entity_type TEXT,
        mapped_at INTEGER NOT NULL
      );

CREATE TABLE local_versions (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      content TEXT,
      extras TEXT,
      fingerprint TEXT NOT NULL,
      reason TEXT NOT NULL,
      file_name TEXT,
      content_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

CREATE TABLE manuscript_files (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        project_id TEXT NOT NULL,
        folder_id TEXT,
        is_trashed INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL,
        mirrored_at INTEGER NOT NULL
      );

CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );

CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        kind TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        body TEXT,
        temp_ids TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE project_tags (
        project_id TEXT PRIMARY KEY,
        user_id TEXT,
        data TEXT NOT NULL,
        mirrored_at INTEGER NOT NULL
      );

CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        created_at TEXT,
        data TEXT NOT NULL,
        mirrored_at INTEGER NOT NULL
      );

CREATE TABLE scratchpad_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      project_id TEXT NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      data TEXT NOT NULL,
      mirrored_at INTEGER NOT NULL
    );

CREATE TABLE telemetry_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      props TEXT NOT NULL,
      session_id TEXT,
      occurred_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE users (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        mirrored_at INTEGER NOT NULL
      );

CREATE INDEX idx_comments_file ON comments(file_id);

CREATE INDEX idx_files_folder ON files(folder_id);

CREATE INDEX idx_files_project ON files(project_id, is_trashed);

CREATE INDEX idx_folders_project ON folders(project_id, is_trashed);

CREATE INDEX idx_local_versions_file ON local_versions(file_id, created_at);

CREATE INDEX idx_manuscripts_project ON manuscript_files(project_id, is_trashed);

CREATE INDEX idx_outbox_entity ON outbox(entity_id);

CREATE INDEX idx_outbox_status ON outbox(status, id);

CREATE INDEX idx_projects_user ON projects(user_id);

CREATE INDEX idx_scratchpad_project ON scratchpad_entries(project_id);

