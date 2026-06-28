# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ Keep this file in sync

**Whenever you make a change that conflicts with anything documented here, update CLAUDE.md in the same change.** This includes: removing/renaming a function or IPC handler named here, changing the sync protocol or on-disk file layout, adding/removing a synced entity or DB table, changing build/test commands, or altering the access-control model. A stale CLAUDE.md is worse than none — if you can't fully verify a section you touched, correct it or add a dated note rather than leaving it misleading. Treat the claims here as needing verification against source when there are bugs.

## What This App Is

SDMo is a **patient encounter coding desktop app** built for research studies. Coders watch videos (or review PDFs) of clinical encounters and log timestamped observations while filling out structured forms. The app supports multi-user projects synced via a shared local folder or directly via OneDrive / Google Drive cloud APIs.

Core workflow: Home → select Project → see Encounters → open a media file → Review page (video + timestamp logger + form workspace) → Submit.

## Commands

```bash
npm run dev          # Vite dev server + Electron together (uses concurrently + wait-on)
npm run vite         # Vite only (no Electron)
npm run electron     # Electron only (expects Vite running at localhost:5173)
npm test             # Electron-as-Node test runner (loads test/*.test.js)
npm run build        # Vite production build → dist/
npm run dist:mac     # Full Mac DMG build (arm64 + x64) → release/
npm run dist:win     # Windows NSIS installer → release/
npm run dist:linux   # Linux AppImage → release/
```

No linter is configured.

### Testing

Run the suite via `npm test`. It uses Electron-as-Node because `better-sqlite3` is a native addon built for Electron's ABI:

```bash
npm test
```

Tests live in `test/` and exercise the main-process data layer plus shared IPC contracts (schema/migrations, settings, sync merge logic, tombstones, IPC argument validation).

- `test/run.js` installs an `electron` module mock (temp `userData`, stubbed `dialog`) **before** requiring any project code, then loads every `*.test.js` and runs them.
- `test/_harness.js` is a tiny zero-dependency runner (`test(name, fn)` + `run()`), so no test framework is needed.
- `test/helpers.js` builds isolated in-memory DBs via the exported `initSchema`/`migrate`/`runDataMigrations` from `db.js`, plus seed helpers (`createProject`, `addEncounter`, `addMedia`, `addReview`, …).
- Pure logic tests use their own in-memory DBs; they call exported functions from `sync.js` directly.

**Canary tests** — keep these green when touching sync: the config round-trip (`buildConfigExport → mergeConfigImport`), `config: prune KEEPS an encounter that has reviews`, and the structure-tombstone tests. When you add a new synced entity, migration, or tombstone, add a corresponding test.

## Architecture

### Process Split

This is a standard Electron app (Electron 32) with two processes:

**Main process** (`electron/`): Node.js, has filesystem and SQLite access. All database queries and file I/O happen here via IPC handlers.

**Renderer process** (`src/`): React 18 + Vite, runs in a sandboxed webview with `contextIsolation: true` and `nodeIntegration: false`. Cannot touch the filesystem or database directly.

**Bridge**: `electron/preload.js` exposes `window.api` via `contextBridge`. Every renderer-to-main call goes through `window.api.someMethod()` → IPC → handler → response.

`src/lib/api.js` wraps `window.api` and falls back to mock data when running outside Electron (browser dev preview). **Always add a new method to all three: the IPC handler, `electron/preload.js`, and the mock in `src/lib/api.js`.**

**IPC contracts**: `electron/main.js` wraps `ipcMain.handle` and validates renderer arguments through `electron/ipc/contracts.js` before each handler runs. When adding or changing an IPC channel, update the contract map unless the channel truly has no arguments. Keep the contract permissive about numeric route params (`"1"` is accepted) but strict about shape (`ids` arrays must contain ids, payloads must be objects).

### Main Process Files

| File | Responsibility |
|------|---------------|
| `electron/main.js` | Calls `app.setName('SDMo')`, creates BrowserWindow, registers `localfile://` protocol, requires all IPC modules |
| `electron/db.js` | SQLite singleton via `better-sqlite3`. `getDb()` initializes schema + runs migrations on first call. DB lives at `app.getPath('userData')/sdmo.db` |
| `electron/settings.js` | Per-installation JSON settings at `app.getPath('userData')/app-settings.json`. Stores `reviewer_name`, `user_uuid`, `project_names`, cloud tokens, `media_base_folders`. Atomic write (temp → rename) with a `.bak` fallback |
| `electron/sync.js` | All sync logic: protocol-v2 snapshot local/cloud sync, legacy-folder migration, tombstones, legacy export/import, debounced `scheduleSync` |
| `electron/ipc/contracts.js` | Shared IPC argument validators used by the global `ipcMain.handle` wrapper |
| `electron/ipc/projects.js` | Project CRUD, password/unlock, Excel export, sync:now, sync:importAsNew |
| `electron/ipc/encounters.js` | Encounter CRUD + bulk delete, Excel structure export/import |
| `electron/ipc/media.js` | Media file CRUD + bulk delete/type, `fs:scanMediaFolder`, file linking |
| `electron/ipc/reviews.js` | Reviews, timestamps, form responses, soft-delete/restore |
| `electron/ipc/cloud.js` | Cloud OAuth connect/disconnect, folder listing/selection, cloud sync trigger |
| `electron/services/structure.js` | Setup structure domain operations for media types, forms, and instructions (save/delete, tombstones, backups, sync bumps) |
| `electron/cloud/onedrive.js` | Microsoft Graph API adapter (PKCE OAuth, port 3877) |
| `electron/cloud/googledrive.js` | Google Drive API v3 adapter (installed-app OAuth, port 3878) |
| `electron/cloud/cloudSync.js` | Adapter factory: `getAdapter(provider)` → onedrive or googledrive |

Each `electron/ipc/*.js` exports a function that receives `ipcMain` and registers handlers. Keep IPC handlers thin where possible: validate at the contract layer, delegate domain behavior to a service module, then return the result.

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
deleted_reviews    ← tombstone table for cross-machine review deletion sync
deleted_structure  ← tombstone table for cross-machine structural deletion sync (encounter/media/form/instruction/media_type)
media_file_links   ← per-machine local file path resolution (not synced)
```

**Schema migrations** (`db.js`): two layers.
- `migrate()` holds idempotent DDL — `ALTER TABLE` column adds, `CREATE TABLE IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS` — in the `migrations` array, each in a try/catch so it's safe to re-run. Add new columns, tables, and indexes here; never modify `initSchema`.
- `runDataMigrations()` is the home for **data** transforms. It uses `PRAGMA user_version`: each entry runs exactly once, in a transaction, advancing `user_version`. The v0→v1 entry backfills `sync_id`/`review_sync_id` on legacy encounter/media/review rows; the v1→v2 entry backfills `sync_id` on legacy `forms`/`media_types`/`instructions`. New rows always get their sync ids at insert time, so these are upgrade-only.

**Stable sync ids + clocks**: every `encounters`/`media_files`/`forms`/`media_types`/`instructions` insert sets `sync_id`, and every `reviews` insert sets `review_sync_id`, at creation. The five structural tables also carry an `updated_at` clock that every *synced* insert/edit bumps (see Sync Architecture → per-entity merge). Sync matches on `sync_id` first and falls back to name only for legacy data. If you add an insert path for these tables, set the sync id there too (and set/bump `updated_at` on synced inserts/edits). Local-only relinking edits such as `file_path` and `folder_path` do not bump the merge clock.

**Backups** (`backupDb(reason)` in `db.js`): writes a synchronous `VACUUM INTO` snapshot to `userData/backups/` (keeps newest 15). Called on startup (throttled to once per 12h) and **before any cascading delete** (form, media type, encounter, media file, bulk deletes, project) and before a remote config apply. `VACUUM INTO` is synchronous on purpose so the snapshot captures pre-delete state. Add a `backupDb('pre-...')` call before any new destructive operation.

### Sync Architecture

Three sync modes, selected per-project in Setup → Sync: **None** (manual Export/Import file flow only), **Local folder** (single-snapshot sync to a shared folder), **Cloud** (direct API sync to OneDrive/Google Drive).

#### Protocol v2 layout (local and cloud)
```
<sync_folder_or_drive_folder>/
  project-state.json       ← canonical synced snapshot: structure + reviews + structure tombstones
  manifest.json            ← tiny {protocol_version, config_version, fingerprint} for cheap change checks
  reviews-export.xlsx      ← derived, write-only: multi-sheet Excel of ALL reviews, rewritten every sync
```

- **`project-state.json`** is the single source of truth for synced project data. It contains the project metadata, forms, instructions, media types, encounters, media files, reviews (including soft-deleted reviews), and `deleted_structure` tombstones. Local/cloud sync always reads, merges, and republishes this one file.
- **Reviews are no longer stored as per-reviewer files.** Review rows are part of the canonical snapshot and merge by `review_sync_id` plus a derived review clock (`created_at`/`submitted_at`/`deleted_at`/`restored_at` + child response/timestamp clocks). Soft-deletes propagate through the review row itself (`deleted_at` / `restored_at`), not through a separate synced `deleted-reviews.json` file.
- **`reviews-export.xlsx`** is still a convenience report for researchers — the same workbook the "Export Excel" button produces (one `<Media Type> Reviews` + `<Media Type> Timestamps` sheet pair per media type), regenerated and uploaded at the end of every sync so the latest reviews are always available in the shared folder/cloud without anyone manually exporting. It is **derived and write-only**: it is built from the local DB after the remote snapshot is merged in, is never read back or merged, and is not a source of truth — deleting it just means the next sync rewrites it. Built by `buildReviewsWorkbook(db, projectId)` in `sync.js` (returns `null` when there are no reviews, so an empty workbook is never written); the `export:excel` IPC handler reuses the same function. Writing binary `.xlsx` to the cloud uses the adapters' `writeFile(folderId, name, content, mimeType)` — the 4th `mimeType` arg defaults to `application/json`; Google Drive base64-encodes `Buffer` content in its multipart body.

- **Per-entity merge (NOT whole-blob replace).** Snapshot sync is **fingerprint-driven and bidirectional**, not a "who's newer" counter gate. Every structural entity (project meta, forms, instructions, media types, encounters, media files) carries a stable `sync_id` and an `updated_at` clock. Reviews merge as full review entities keyed by `review_sync_id`, with timestamps/form responses replaced together when the incoming review wins. `syncProjectState{Local,Cloud}` compares the folder's `manifest.fingerprint` (a content hash of the canonical snapshot, via `projectStateFingerprint`) to the local one: if equal, nothing to do; otherwise read `project-state.json`, apply structure tombstones, merge structure via `applyStructure(..., { merge: true })`, then merge reviews via `mergeProjectStateImport`. Then republish if our post-merge fingerprint still differs (we hold newer/extra entities). This keeps concurrent edits convergent without maintaining separate config/review/tombstone protocols.
- **Conflict toast.** A genuine same-entity concurrent edit (equal clocks, differing content) is resolved by LWW *and* reported: `applyStructure` returns `{ conflicts }`, `do{Local,Cloud}Sync` calls `emitConflicts`, which sends a `sync:conflict` event → `ProjectPage` shows a toast ("another machine's change was newer, kept the most recent version"). Resolution stays automatic — there is intentionally **no** interactive merge UI.
- **`updated_at` is the merge clock.** Every IPC handler that edits synced structure sets `updated_at=datetime('now')` (forms/instructions/media_types in `setup:save*`; encounters/media in rename/move/type handlers). Local-only edits that aren't part of the config (e.g. `fs:scanMediaFolder` setting `file_path`/`folder_path`) deliberately do **not** bump it. When `applyStructure` adopts an incoming entity it stores the *incoming* `updated_at` so both machines converge to the same clock. Readers fall back to `created_at` when `updated_at` is NULL.
- **`config_version`** is now a **legacy/back-compat counter only** (kept for old clients and the "update available" badge via `project:checkManifest`). It is still bumped by `bumpConfigVersion`/`bumpAndSync` and merged as `max(local, incoming)`, but it **no longer gates** which side wins — the fingerprint + per-entity clocks do. Don't reintroduce counter-based pull/push gating.
- **Config writing is NOT owner-gated.** Every machine publishes when its content differs from the folder. (Historical note: an `isOwner`/PI-only-write model was documented and then removed in 2026-06; do not reintroduce references to `isOwner` or `owner_projects` — they no longer exist.)
- **`applyStructure(db, projectId, configData, { merge })`** is the single apply path. `merge: false` (authoritative — incoming wins per entity) backs the manual Import File / join-from-folder / "accept update" flows via `_applyConfigTransaction` / `replaceStructureFromConfig`; `merge: true` (LWW) backs auto-sync via `mergeStructureFromConfig`. **Neither mode prunes** — see Deletion propagation.
- **`SYNC_PROTOCOL_VERSION`** (in `sync.js`, currently **2**) is the on-disk sync protocol version, stamped into `manifest.json` and `project-state.json`. `assertProjectStateCompatible` refuses to apply a snapshot from a newer protocol the app does not understand. `CONFIG_FORMAT_VERSION` still exists for the legacy/manual config format and legacy-folder migration.
- **Concurrent-sync guard**: `doLocalSync`/`doCloudSync` run through a per-project mutex (`runExclusiveSync`); a sync requested mid-flight is queued to run once afterward. `cancelSync(projectId)` clears the debounce timer and queue (called on project delete).
- **Auto-sync**: `scheduleSync(projectId)` debounces 2 seconds. `bumpAndSync` = `bumpConfigVersion` + `scheduleSync`, called after structural changes and settings saves. Review saves call `scheduleSyncForReview` (sync without bumping config_version).
- **Sync order** (`sync:now` / `cloud:syncNow` and auto-sync): read `manifest.json` → merge `project-state.json` (structure tombstones, structure, reviews) → republish `project-state.json`/`manifest.json` if our post-merge fingerprint differs → write `reviews-export.xlsx` report.
- **Legacy folder migration.** `syncProjectState{Local,Cloud}` can still read the old split-file layout (`project-config.json`, `reviews/*.json`, `deleted-*.json`) and fold it into the local DB once. After that merge, the app republishes the project as protocol v2 (`project-state.json` + new manifest). This keeps existing shared folders joinable during the transition.

#### Deletion propagation (tombstones)
Two deletion mechanisms remain, but only one is sync-specific:

- **Reviews** — soft-deleted (`deleted_at` set, row kept). In protocol v2 the delete/restore state travels with the review entity itself (`deleted_at` / `restored_at`) inside `project-state.json`. The legacy `deleted_reviews` table is still populated locally and still used when importing or migrating legacy sync folders, but the protocol-v2 sync path does not write/read a standalone `deleted-reviews.json`.
- **All structural entities** (encounters, media files, **forms, instructions, media types**) — hard-deleted, with a `deleted_structure` tombstone keyed by `sync_id` (`kind` = `'encounter'` | `'media'` | `'form'` | `'instruction'` | `'media_type'`). Encounters/media use `recordEncounterTombstone` / `recordMediaTombstone`; forms/instructions/media types use the generic `recordStructureTombstone(db, projectId, kind, id)`. All are called in the delete handlers (`encounters:delete`, `media:deleteFile`, `setup:deleteForm` / `deleteInstruction` / `deleteMediaType`, and the `*:bulkDelete` variants) **before** the row is removed. Helpers: `applyStructureTombstones` / `buildStructureTombstones`. In protocol v2 these tombstones are embedded in `project-state.json` as `deleted_structure`.

**Tombstones are the ONLY way a deletion propagates.** Config apply (both authoritative and merge modes) **never prunes** — an entity absent from a peer's config is left alone, because absence is ambiguous (the peer may simply not have it yet). Only an explicit tombstone deletes. This is why a deletion of even a *reviewed* encounter propagates (the delete UI warns it destroys reviews): `applyStructureTombstones` runs before config-apply, deletes the item everywhere, and config-apply **skips any tombstoned `sync_id`** (`tombstonedSyncIds` covers all five kinds) so a stale peer config can't resurrect it. **If you add a new way to delete a structural entity, record its tombstone there too**, or the deletion won't sync. (The former "absent-from-config prune + review-protection guard" was removed when per-entity merge landed — do not reintroduce config-driven pruning.)

**If you add a new way to delete an encounter or media file, record a structure tombstone there too**, or the deletion won't propagate.

#### Legacy Export/Import (manual file flow)
`buildExport` / `mergeImport` / `createFromImport` still exist for the manual Save File / Import File flow. `mergeImport` only adds structure (never prunes), so structure tombstones are not part of this path. Do not remove these functions.

#### Cloud OAuth
- **OneDrive**: PKCE flow, Azure app `769f4075-4597-4d51-ba1b-c3611914ca68`, redirect `http://localhost:3877`. Tokens stored as `onedrive_tokens` + `onedrive_email` in `app-settings.json`.
- **Google Drive**: installed-app flow, GCP client in `electron/cloud/googledrive.js`, redirect `http://localhost:3878`. Scope: `https://www.googleapis.com/auth/drive email profile` (full drive scope needed for shared folders). Tokens stored as `googledrive_tokens` + `googledrive_email`.
- Both OAuth servers listen with `{ exclusive: false }` and are cancellable via `cloud:cancelAuth` IPC.
- `ensureFolder` uses `conflictBehavior: 'fail'` (OneDrive) / query-first (Google Drive) to avoid duplicate folder creation.

### Local File Protocol

Videos are served via a custom `localfile://` protocol registered in `main.js`:
```js
protocol.registerFileProtocol('localfile', (request, callback) => {
  const filePath = decodeURIComponent(request.url.replace('localfile://', ''))
  if (isKnownLocalFile(filePath)) callback({ path: filePath })
  else callback({ error: -6 })
})
```
This uses Chromium's native file serving, which supports HTTP range requests needed for video seeking. Do **not** replace with `protocol.handle` + `net.fetch` — that breaks range requests and videos won't play. The scheme is registered as privileged before `app.whenReady()`, and BrowserWindows keep Chromium `webSecurity` enabled. `isKnownLocalFile` allowlists files already known to the app through `media_files.file_path`, `instructions.file_path`, or resolved `media_file_links`; arbitrary renderer-provided local paths should not be served.

### Access Control (password / unlock)

There is **one** gate: a per-installation in-memory unlock set.

- Owner password is hashed with SHA-256 (`crypto.createHash`) and stored in `projects.owner_password_hash`. The hash is included in the synced config so all machines enforce the same password.
- `unlockedProjects` is an in-memory `Set` in `ipc/projects.js`, populated by `project:verifyPassword`/`project:setPassword` and cleared on app restart. `projects:get` exposes `is_unlocked` from it.
- The SetupPage uses `is_unlocked` to gate **editing settings** (the `locked` / `isOwner` props inside SetupPage are renderer-local and just mean "is unlocked"). This is the only thing the unlock state controls — it does **not** gate config writing (see Sync Architecture).
- There is no persistent ownership concept. (The former `isOwner()` function and `owner_projects` setting were removed in 2026-06.)

### Soft Delete vs Hard Delete

- **Reviews** are soft-deleted (`deleted_at` set). All listing queries filter `WHERE deleted_at IS NULL`. Propagated via `deleted_reviews`; restore removes the tombstone.
- **Encounters / media files** are hard-deleted (FK cascade), propagated via `deleted_structure` tombstones (see above).

### Form Schema

Forms stored as JSON in `forms.schema`:
```json
{ "sections": [{ "id": "uuid", "title": "...", "elements": [{ "id": "uuid", "type": "text|number|select|...", "label": "..." }] }] }
```
Form responses in `form_responses.responses` are keyed by element UUID: `{ "element-uuid": value }`.
In Excel export, iterate `sec.elements` (not `sec.questions`).

### Renderer Pages

| Route | Page | Purpose |
|-------|------|---------|
| `/` | `HomePage` | Project list, reviewer name, import/create, tutorial |
| `/project/:id` | `ProjectPage` | Encounter list (paginated, `PAGE_SIZE = 15`), media files, review badges, sync now, export Excel. Fixed-height (`100vh`) sidebar |
| `/project/:id/setup` | `SetupPage` | 10-tab settings; manages encounters/files incl. multi-select bulk delete + bulk set-media-type |
| `/review/:id` | `ReviewPage` | Video player, timestamp logger (scrollable sidebar), form workspace tabs |

`SetupPage` section indices are defined in `src/lib/setupSections.js` (the source of truth — import `SETUP_SECTIONS` rather than hardcoding): 0=Overview, 1=Forms, 2=Instructions, 3=Media Types, 4=Encounters, 5=Files, 6=Sync, 7=Keybinds, 8=Access, 9=Deleted Reviews.

**Encounters management (SetupPage, section 4)**: per-row rename / add file / move / set media type / delete, plus **multi-select** via checkboxes on encounter headers and file rows. A floating action bar offers bulk Set-media-type (files only) and bulk Delete; these route through `encounters:bulkDelete` / `media:bulkDelete` / `media:bulkUpdateType` (one backup + one transaction + one sync per batch).

**Excel structure export/import** (`encounters:exportStructure` / `previewImport` / `applyImport`): three columns only — `Encounter`, `File Name`, `Media Type`. The importer reads only those columns.

### Packaging

- Built with `electron-builder`. Config is in the `"build"` key of `package.json`.
- `better-sqlite3` is a native addon listed in `asarUnpack` (excluded from the asar archive). electron-builder rebuilds it via `@electron/rebuild` during packaging. After a manual `npm install`, rebuild with `./node_modules/.bin/electron-rebuild -f -w better-sqlite3`.
- `app.setName('SDMo')` is called at the top of `main.js` so the packaged app stores data under the `SDMo` userData name. Output goes to `release/`. Mac builds produce two DMGs (arm64 + x64). App is unsigned — users on other Macs may need `xattr -cr /Applications/SDMo.app` if Gatekeeper blocks it.
- GitHub Actions workflow at `.github/workflows/build.yml` builds all platforms on tag push.
- `node-fetch@2` (CommonJS) is required for HTTP in the main process — do not upgrade to v3 (ESM only).

### Tutorial System

First-time tutorial on `HomePage` uses `TutorialBubble` (portal-rendered, positioned via `getBoundingClientRect`). State persisted to `localStorage` key `sdmo_tutorial_v1`. Target elements identified by `id` attributes (`tut-name`, `tut-import`, `tut-new`, `tut-help`). Re-triggered via the `?` button.
