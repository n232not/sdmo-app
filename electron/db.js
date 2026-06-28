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
  runDataMigrations(db)
  seedMediaLinks(db)

  return db
}

// ─── Versioned data migrations (PRAGMA user_version) ────────────────────────────
// `migrate()` above only adds columns/indexes idempotently. This runner is the home
// for data transforms: each entry runs once, in a transaction, advancing user_version.
// New records always get their sync ids at insert time, so these are upgrade-only.
function runDataMigrations(db) {
  const crypto = require('crypto')

  const migrations = [
    // v0 → v1: backfill sync ids on rows created before sync ids existed
    (db) => {
      for (const enc of db.prepare("SELECT id FROM encounters WHERE sync_id IS NULL").all()) {
        db.prepare("UPDATE encounters SET sync_id=? WHERE id=?").run(crypto.randomUUID(), enc.id)
      }
      for (const mf of db.prepare("SELECT id FROM media_files WHERE sync_id IS NULL").all()) {
        db.prepare("UPDATE media_files SET sync_id=? WHERE id=?").run(crypto.randomUUID(), mf.id)
      }
      for (const rev of db.prepare("SELECT id FROM reviews WHERE review_sync_id IS NULL").all()) {
        db.prepare("UPDATE reviews SET review_sync_id=? WHERE id=?").run(crypto.randomUUID(), rev.id)
      }
    },
  ]

  let version = db.pragma('user_version', { simple: true })
  for (let v = version; v < migrations.length; v++) {
    db.transaction(() => {
      migrations[v](db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}

// Seed link records from existing file_path values on machines where the file actually
// exists. Environment-sensitive (depends on local filesystem), so it runs every launch
// rather than being gated by user_version — it's a no-op once links exist.
function seedMediaLinks(db) {
  const mfsWithPath = db.prepare("SELECT id, file_path FROM media_files WHERE file_path IS NOT NULL AND file_path != ''").all()
  for (const mf of mfsWithPath) {
    const existing = db.prepare("SELECT id FROM media_file_links WHERE media_file_id=?").get(mf.id)
    if (!existing && fs.existsSync(mf.file_path)) {
      try {
        db.prepare("INSERT INTO media_file_links (media_file_id, local_path, is_relative) VALUES (?,?,0)").run(mf.id, mf.file_path)
      } catch (_) {}
    }
  }
}

// ─── Backups ────────────────────────────────────────────────────────────────────
// Online backup (WAL-safe) into userData/backups, newest-kept rotation. Used as a
// safety net on startup and before any irreversible/cascading operation.
const KEEP_BACKUPS = 15

function rotateBackups(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('sdmo-') && f.endsWith('.db'))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(KEEP_BACKUPS)) {
      try { fs.unlinkSync(path.join(dir, f)) } catch (_) {}
    }
  } catch (_) {}
}

// reason: short tag for the filename. For 'startup' we throttle to once per 12h so
// launches don't pile up backups; explicit pre-destructive backups always run.
function backupDb(reason = 'manual') {
  try {
    const database = getDb()
    const dir = path.join(app.getPath('userData'), 'backups')
    fs.mkdirSync(dir, { recursive: true })

    if (reason === 'startup') {
      const recent = fs.readdirSync(dir)
        .filter(f => f.startsWith('sdmo-') && f.endsWith('.db'))
        .some(f => Date.now() - fs.statSync(path.join(dir, f)).mtimeMs < 12 * 60 * 60 * 1000)
      if (recent) return
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = path.join(dir, `sdmo-${stamp}-${reason}.db`)
    // VACUUM INTO writes a complete, WAL-correct snapshot synchronously, so it always
    // finishes before any subsequent write (e.g. the delete that triggered a
    // pre-destructive backup). The async .backup() API could otherwise race the delete.
    database.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
    rotateBackups(dir)
  } catch (e) {
    console.error('[db] backup failed:', e.message)
  }
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
    // Indexes on the foreign keys / sync ids that every list and sync query filters on.
    // SQLite only auto-indexes PK and UNIQUE columns, so these are full-scans otherwise.
    "CREATE INDEX IF NOT EXISTS idx_encounters_project ON encounters(project_id)",
    "CREATE INDEX IF NOT EXISTS idx_media_files_encounter ON media_files(encounter_id)",
    "CREATE INDEX IF NOT EXISTS idx_media_files_sync ON media_files(sync_id)",
    "CREATE INDEX IF NOT EXISTS idx_reviews_media_file ON reviews(media_file_id)",
    "CREATE INDEX IF NOT EXISTS idx_reviews_sync ON reviews(review_sync_id)",
    "CREATE INDEX IF NOT EXISTS idx_timestamps_review ON timestamps(review_id)",
    "CREATE INDEX IF NOT EXISTS idx_form_responses_review ON form_responses(review_id)",
    "CREATE INDEX IF NOT EXISTS idx_deleted_reviews_project ON deleted_reviews(project_id)",
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

// Deletes all reviews for a media file without deleting the file itself.
// FK cascade (reviews → timestamps, form_responses) handles child rows automatically.
function deleteReviewsForMediaFile(db, mediaFileId) {
  db.prepare('DELETE FROM reviews WHERE media_file_id=?').run(mediaFileId)
}

module.exports = { getDb, deleteReviewsForMediaFile, backupDb, initSchema, migrate, runDataMigrations }
