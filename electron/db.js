const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

const dbPath = path.join(app.getPath('userData'), 'sdmo.db')

let db

function getDb() {
  if (db) return db

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  initSchema(db)
  migrate(db)

  const crypto = require('crypto')
  for (const enc of db.prepare("SELECT id FROM encounters WHERE sync_id IS NULL").all()) {
    db.prepare("UPDATE encounters SET sync_id=? WHERE id=?").run(crypto.randomUUID(), enc.id)
  }
  for (const mf of db.prepare("SELECT id FROM media_files WHERE sync_id IS NULL").all()) {
    db.prepare("UPDATE media_files SET sync_id=? WHERE id=?").run(crypto.randomUUID(), mf.id)
  }
  for (const rev of db.prepare("SELECT id FROM reviews WHERE review_sync_id IS NULL").all()) {
    db.prepare("UPDATE reviews SET review_sync_id=? WHERE id=?").run(crypto.randomUUID(), rev.id)
  }

  // Seed link records from existing file_path values on machines where the file actually exists.
  // This keeps existing setups working without requiring re-linking.
  const mfsWithPath = db.prepare("SELECT id, file_path FROM media_files WHERE file_path IS NOT NULL AND file_path != ''").all()
  for (const mf of mfsWithPath) {
    const existing = db.prepare("SELECT id FROM media_file_links WHERE media_file_id=?").get(mf.id)
    if (!existing && fs.existsSync(mf.file_path)) {
      try {
        db.prepare("INSERT INTO media_file_links (media_file_id, local_path, is_relative) VALUES (?,?,0)").run(mf.id, mf.file_path)
      } catch (_) {}
    }
  }

  return db
}

function migrate(db) {
  // Safe column additions — ignore errors if columns already exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS deleted_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      encounter_name TEXT NOT NULL,
      media_name TEXT NOT NULL,
      reviewer_name TEXT NOT NULL,
      deleted_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, encounter_name, media_name, reviewer_name)
    );
  `)

  const migrations = [
    "ALTER TABLE reviews ADD COLUMN deleted_at TEXT",
    "ALTER TABLE instructions ADD COLUMN content_type TEXT NOT NULL DEFAULT 'markdown'",
    "ALTER TABLE instructions ADD COLUMN file_path TEXT",
    "ALTER TABLE timestamps ADD COLUMN tag_color TEXT",
    "ALTER TABLE projects ADD COLUMN keybinds TEXT DEFAULT '[]'",
    "ALTER TABLE projects ADD COLUMN sync_folder TEXT",
    "ALTER TABLE projects ADD COLUMN owner_name TEXT",
    "ALTER TABLE projects ADD COLUMN owner_uuid TEXT",
    "ALTER TABLE reviews ADD COLUMN reviewer_uuid TEXT",
    "ALTER TABLE projects ADD COLUMN owner_password_hash TEXT",
    "ALTER TABLE projects ADD COLUMN cloud_provider TEXT",
    "ALTER TABLE projects ADD COLUMN cloud_folder_id TEXT",
    "ALTER TABLE projects ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE reviews ADD COLUMN restored_at TEXT",
    "ALTER TABLE encounters ADD COLUMN sync_id TEXT",
    "ALTER TABLE media_files ADD COLUMN sync_id TEXT",
    "ALTER TABLE reviews ADD COLUMN review_sync_id TEXT",
    "ALTER TABLE deleted_reviews ADD COLUMN review_sync_id TEXT",
    `CREATE TABLE IF NOT EXISTS media_file_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
      local_path TEXT,
      is_relative INTEGER NOT NULL DEFAULT 0,
      not_applicable INTEGER NOT NULL DEFAULT 0,
      linked_at TEXT DEFAULT (datetime('now')),
      UNIQUE(media_file_id)
    )`,
  ]
  for (const sql of migrations) {
    try { db.exec(sql) } catch (_) {}
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      media_folder TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      reviews_required INTEGER,
      allow_custom_tags INTEGER DEFAULT 1,
      color TEXT DEFAULT '#6366f1',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS timestamp_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type_id INTEGER NOT NULL REFERENCES media_types(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1',
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS forms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      schema TEXT NOT NULL DEFAULT '{"sections":[]}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS instructions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'markdown',
      content TEXT NOT NULL DEFAULT '',
      file_path TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspace_tabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type_id INTEGER NOT NULL REFERENCES media_types(id) ON DELETE CASCADE,
      tab_type TEXT NOT NULL,
      ref_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS encounters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT NOT NULL DEFAULT 'video',
      media_type_id INTEGER REFERENCES media_types(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
      reviewer_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      submitted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS timestamps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      time_seconds REAL NOT NULL,
      tag_id INTEGER REFERENCES timestamp_tags(id) ON DELETE SET NULL,
      tag_label TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS form_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
      responses TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `)
}

module.exports = { getDb }
