# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This App Is

SDMo is a **patient encounter coding desktop app** built for research studies. Coders watch videos (or review PDFs) of clinical encounters and log timestamped observations while filling out structured forms. The app supports multi-user projects synced via a shared local folder or directly via OneDrive / Google Drive cloud APIs.

Core workflow: Home → select Project → see Encounters → open a media file → Review page (video + timestamp logger + form workspace) → Submit.

## Commands

```bash
npm run dev          # Vite dev server + Electron together (uses concurrently + wait-on)
npm run vite         # Vite only (no Electron)
npm run electron     # Electron only (expects Vite running at localhost:5173)
npm run build        # Vite production build → dist/
npm run dist:mac     # Full Mac DMG build (arm64 + x64) → release/
npm run dist:win     # Windows NSIS installer → release/
npm run dist:linux   # Linux AppImage → release/
npm test             # Run the main-process unit/integration test suite
```

No linter is configured.

### Testing

Tests live in `test/` and exercise the main-process data layer (schema/migrations, sync merge logic, and the encounter/review/media IPC handlers). They run under Electron-as-Node because `better-sqlite3` is a native addon built for Electron's ABI:

```bash
npm test   # → ELECTRON_RUN_AS_NODE=1 electron test/run.js
```

- `test/run.js` installs an `electron` module mock (temp `userData`, stubbed `dialog`) **before** requiring any project code, then loads every `*.test.js` and runs them.
- `test/_harness.js` is a tiny zero-dependency runner (`test(name, fn)` + `run()`), so no test framework is needed.
- `test/helpers.js` builds isolated in-memory DBs via the exported `initSchema`/`migrate`/`runDataMigrations` from `db.js`, plus seed helpers.
- Pure logic tests (sync round-trips, config apply, tombstones) use their own in-memory DBs; IPC handler tests register handlers against a fake `ipcMain` backed by the singleton DB.

When you add a new synced entity or migration, add a corresponding test — the config round-trip and "config apply preserves reviews" tests are the canaries for sync regressions.

## Architecture

### Process Split

This is a standard Electron app with two processes:

**Main process** (`electron/`): Node.js, has filesystem and SQLite access. All database queries and file I/O happen here via IPC handlers.

**Renderer process** (`src/`): React 18 + Vite, runs in a sandboxed webview with `contextIsolation: true` and `nodeIntegration: false`. Cannot touch the filesystem or database directly.

**Bridge**: `electron/preload.js` exposes `window.api` via `contextBridge`. Every renderer-to-main call goes through `window.api.someMethod()` → IPC → handler → response.

`src/lib/api.js` wraps `window.api` and falls back to mock data when running outside Electron (browser dev preview). Always add new methods to both the real preload and the mock in `api.js`.

### Main Process Files

| File | Responsibility |
|------|---------------|
| `electron/main.js` | Creates BrowserWindow, registers `localfile://` protocol, requires all IPC modules |
| `electron/db.js` | SQLite singleton via `better-sqlite3`. `getDb()` initializes schema + runs migrations on first call. DB lives at `app.getPath('userData')/sdmo.db` |
| `electron/settings.js` | Per-installation JSON settings at `app.getPath('userData')/app-settings.json`. Stores `reviewer_name`, `user_uuid`, `project_names`, `owner_projects`, cloud tokens |
| `electron/sync.js` | All sync logic: split-file local/cloud sync, legacy export/import, debounced `scheduleSync` |
| `electron/ipc/projects.js` | Project CRUD, password/lock, Excel export, sync:now, sync:importAsNew |
| `electron/ipc/encounters.js` | Encounter CRUD |
| `electron/ipc/media.js` | Media file CRUD, `fs:scanMediaFolder` |
| `electron/ipc/reviews.js` | Reviews, timestamps, form responses, soft-delete/restore |
| `electron/ipc/cloud.js` | Cloud OAuth connect/disconnect, folder listing/selection, cloud sync trigger |
| `electron/cloud/onedrive.js` | Microsoft Graph API adapter (PKCE OAuth, port 3877) |
| `electron/cloud/googledrive.js` | Google Drive API v3 adapter (installed-app OAuth, port 3878) |
| `electron/cloud/cloudSync.js` | Adapter factory: `getAdapter(provider)` → onedrive or googledrive |

Each `electron/ipc/*.js` exports a function that receives `ipcMain` and registers handlers.

### Database Schema

Key tables and relationships:
```
projects (+ cloud_provider, cloud_folder_id, config_version columns)
  └── media_types → timestamp_tags, workspace_tabs
  └── forms
  └── instructions
  └── encounters
        └── media_files → media_type_id (FK to media_types)
              └── reviews (soft-deleted via deleted_at)
                    └── timestamps
                    └── form_responses
deleted_reviews  ← tombstone table for cross-machine deletion sync
```

**Schema migrations** (`db.js`): two layers.
- `migrate()` holds idempotent DDL — `ALTER TABLE` column adds and `CREATE INDEX IF NOT EXISTS` — in the `migrations` array, each in a try/catch so it's safe to re-run. Add new columns and indexes here; never modify `initSchema`.
- `runDataMigrations()` is the home for **data** transforms (not just DDL). It uses `PRAGMA user_version`: each entry in its `migrations` array runs exactly once, in a transaction, advancing `user_version`. The v0→v1 entry backfills `sync_id`/`review_sync_id` on legacy rows. New rows always get their sync ids at insert time, so these are upgrade-only.

**Stable sync ids**: every `encounters`/`media_files` insert sets `sync_id` and every `reviews` insert sets `review_sync_id` at creation. Sync matches on these ids first and falls back to name only for legacy data — so duplicate names no longer cause cross-record mis-merges. If you add an insert path for these tables, set the sync id there too.

**Backups** (`backupDb(reason)` in `db.js`): writes a synchronous `VACUUM INTO` snapshot to `userData/backups/` (keeps newest 15). Called on startup (throttled to once per 12h) and **before any cascading delete** (form, media type, encounter, media file, project) and before a remote config apply (`replaceStructureFromConfig`). `VACUUM INTO` is synchronous on purpose so the snapshot always captures pre-delete state. Add a `backupDb('pre-...')` call before any new destructive operation.

**Settings durability** (`settings.js`): `saveSettings` writes atomically (temp file → `rename`) and keeps a `.bak`; `getSettings` falls back to `.bak` on a corrupt/truncated file. This protects `user_uuid`, `owner_projects`, cloud tokens, and `media_base_folders` from a crash mid-write.

### Sync Architecture

Three sync modes, selected per-project in Setup → Sync:

**None**: manual Export/Import file flow only (legacy, still works).

**Local folder**: split-file sync to a shared folder on disk (OneDrive/Dropbox local sync, network drive, etc.).

**Cloud**: direct API sync to OneDrive or Google Drive — no local folder required.

#### Split-file sync layout (local and cloud)
```
<sync_folder_or_drive_folder>/
  project-config.json      ← PI-owned: forms, media types, instructions, encounters schema, config_version
  reviews/
    <reviewer-uuid>.json   ← per-reviewer, only that machine writes it
  deleted-reviews.json     ← append-only tombstone log
```

- **`config_version`**: integer on `projects` table, bumped by `bumpConfigVersion` whenever the PI saves settings. Non-PI machines see a banner when incoming config_version > local. This is a "who's newer" counter, **not** a schema version.
- **`CONFIG_FORMAT_VERSION`** (in `sync.js`): the on-disk config *format* version, stamped into `project-config.json` as `version`. `assertConfigCompatible` refuses to apply a config whose `version` is newer than this app understands (so a stale app can't mis-apply a newer file). Bump it when the config format changes incompatibly.
- **Concurrent-sync guard**: `doLocalSync`/`doCloudSync` run through a per-project mutex (`runExclusiveSync`); a sync requested mid-flight is queued to run once afterward, so tombstones/config can't be lost to interleaving. `cancelSync(projectId)` clears the debounce timer and queue (called on project delete).
- **Config apply never destroys reviewer work**: when the authoritative config prunes structure, `_applyConfigTransaction` skips deleting any encounter/media that still has reviews (the FK cascade would otherwise wipe them) and logs a warning instead.
- **PI detection** (`isOwner(projectId)` in `ipc/projects.js`): true if in-session `unlockedProjects` Set OR listed in `app-settings.json` `owner_projects` array. `owner_projects` is written when `setOwnerPassword` is called, so PI status persists across restarts.
- **Config write**: only the PI machine writes `project-config.json` during sync.
- **Review write**: every machine always writes its own `reviews/<uuid>.json`.
- **Auto-sync**: `scheduleSync(projectId)` debounces 2 seconds. Triggered after any review save (in `ipc/reviews.js`) and after any settings save that calls `bumpConfigVersion` (in `ipc/projects.js`).
- **`sync:now` / `cloud:syncNow` order**: tombstones → config → peer reviews → write own review → write config (if PI) → write tombstones.

#### Legacy Export/Import (unchanged)
`buildExport` / `mergeImport` / `createFromImport` still exist for the manual file flow. Do not remove them.

#### Cloud OAuth
- **OneDrive**: PKCE flow, Azure app `769f4075-4597-4d51-ba1b-c3611914ca68`, redirect `http://localhost:3877`. Tokens stored as `onedrive_tokens` + `onedrive_email` in `app-settings.json`.
- **Google Drive**: installed-app flow, GCP client in `electron/cloud/googledrive.js`, redirect `http://localhost:3878`. Scope: `https://www.googleapis.com/auth/drive email profile` (full drive scope needed to access shared folders). Tokens stored as `googledrive_tokens` + `googledrive_email`.
- Both OAuth servers listen with `{ exclusive: false }` and are cancellable via `cloud:cancelAuth` IPC.
- `ensureFolder` uses `conflictBehavior: 'fail'` (OneDrive) / query-first (Google Drive) to avoid duplicate folder creation.

### Local File Protocol

Videos are served via a custom `localfile://` protocol registered in `main.js`:
```js
protocol.registerFileProtocol('localfile', (request, callback) => {
  const filePath = decodeURIComponent(request.url.replace('localfile://', ''))
  callback({ path: filePath })
})
```
This uses Chromium's native file serving, which supports HTTP range requests needed for video seeking. Do **not** replace with `protocol.handle` + `net.fetch` — that breaks range requests and videos won't play.

### Password / Lock System

- Owner password is hashed with SHA-256 (`crypto.createHash`) and stored in `projects.owner_password_hash`.
- The hash is included in the sync config file so all machines enforce the same password.
- Session unlock state: in-memory `unlockedProjects` Set in `ipc/projects.js` — cleared on app restart.
- Persistent PI ownership: `owner_projects` array in `app-settings.json` — written when `setOwnerPassword` is called so PI can write the config file after restarts without re-entering password.
- `isOwner(projectId)` checks both. Use this instead of `unlockedProjects.has()` for any PI-gated logic.
- Settings page always prompts for password on open when `has_password` is true.

### Soft Delete

Reviews are soft-deleted (`deleted_at` timestamp set, not removed). A `deleted_reviews` tombstone table propagates deletions across machines during sync. Restoring a review removes its tombstone.

All listing queries filter `WHERE deleted_at IS NULL`.

### Form Schema

Forms stored as JSON in `forms.schema`:
```json
{ "sections": [{ "id": "uuid", "title": "...", "elements": [{ "id": "uuid", "type": "text|number|select|...", "label": "..." }] }] }
```
Form responses in `form_responses.responses` are keyed by element UUID: `{ "element-uuid": value }`.
In Excel export, use `sec.elements` (not `sec.questions`) to iterate form fields.

### Renderer Pages

| Route | Page | Purpose |
|-------|------|---------|
| `/` | `HomePage` | Project list, reviewer name, import/create, tutorial |
| `/project/:id` | `ProjectPage` | Encounter list, media files, review badges, sync now, export Excel |
| `/project/:id/setup` | `SetupPage` | 10-tab settings: Overview, Forms, Instructions, Media Types, Media Folder, Media Files, Sync, Keybinds, Access, Deleted Reviews |
| `/review/:id` | `ReviewPage` | Video player, timestamp logger, form workspace tabs |

`SetupPage` section indices are defined in `src/lib/setupSections.js` (the source of truth — import `SETUP_SECTIONS` rather than hardcoding numbers): 0=Overview, 1=Forms, 2=Instructions, 3=Media Types, 4=Encounters, 5=Files, 6=Sync, 7=Keybinds, 8=Access, 9=Deleted Reviews.

**Sync tab (section 6)** has three modes: None / Local Folder / OneDrive or Google Drive. Cloud mode shows connect/disconnect, folder picker modal (with refresh button), and a "paste share link" input for teammates to join by URL.

### Packaging

- Built with `electron-builder`. Config is in the `"build"` key of `package.json`.
- `better-sqlite3` is a native addon. It's listed in `asarUnpack` so it's excluded from the asar archive. electron-builder rebuilds it via `@electron/rebuild` automatically during packaging.
- `app.setName('SDMo')` is called at the top of `main.js` so the packaged app stores data in `~/Library/Application Support/SDMo/` (not `sdmo-app/` which the dev app uses). This keeps dev and prod data separate.
- Output goes to `release/`. Mac builds produce two DMGs (arm64 + x64). App is unsigned — users on other Macs need to run `xattr -cr /Applications/SDMo.app` if Gatekeeper blocks it.
- GitHub Actions workflow at `.github/workflows/build.yml` builds all platforms on tag push.
- `node-fetch@2` (CommonJS) is required for HTTP in the main process — do not upgrade to v3 (ESM only).

### Tutorial System

First-time tutorial on `HomePage` uses `TutorialBubble` (portal-rendered, positioned via `getBoundingClientRect`). State persisted to `localStorage` key `sdmo_tutorial_v1`. Target elements identified by `id` attributes (`tut-name`, `tut-import`, `tut-new`, `tut-help`). Re-triggered via the `?` button.
