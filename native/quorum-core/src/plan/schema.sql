      CREATE TABLE workspaces (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE);
      CREATE TABLE plans (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT NOT NULL,
        current_revision_id TEXT REFERENCES plan_revisions(id) DEFERRABLE INITIALLY DEFERRED, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE plan_revisions (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), revision INTEGER NOT NULL,
        definition_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(plan_id, revision)
      );
      CREATE TABLE plan_approvals (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
        content_hash TEXT NOT NULL, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, scope_json TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE plan_events (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), sequence INTEGER NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(plan_id, sequence)
      );
      CREATE TABLE plan_questions (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
        question TEXT NOT NULL, options_json TEXT NOT NULL, answer TEXT, created_at TEXT NOT NULL, answered_at TEXT
      );
      CREATE INDEX plan_events_order ON plan_events(plan_id, sequence);
      PRAGMA user_version = 1;
