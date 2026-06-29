# CLAUDE.md

**Keep this file in sync.** If you rename/remove a function, IPC channel, DB table, or sync behavior named here, update this file in the same change. A stale CLAUDE.md is worse than none.

---

## What This App Is

SDMo is a clinical encounter coding desktop app for research studies. Coders watch videos (or review PDFs) and log timestamped observations while filling out structured forms. Multi-user projects sync via a shared local folder or OneDrive/Google Drive.

Core flow: Home → Project → Encounters → open media file → Review page (video + timestamp logger + form workspace) → Submit.

---

## Commands

```bash
npm run dev       # Vite + Electron together
npm run vite      # Vite only (browser preview, no IPC)
npm run electron  # Electron only (expects Vite at localhost:5173)
npm test          # Electron-as-Node test runner
npm run build     # Vite production build → dist/
npm run dist:mac  # Mac DMG (arm64 + x64) → release/
npm run dist:win  # Windows NSIS → release/
```

No linter. Tests live in `test/`, use `test/_harness.js` (zero-dep runner), and rely on `test/helpers.js` for in-memory DB setup.

---

## Design Goals

These goals should guide every change — not just new features.

- **Modular.** Each concern lives in one place. IPC handlers stay thin (validate → call service → return). Business logic lives in service modules, not in handlers or React components.
- **Standardized UI.** Use the existing patterns: the `showToast` / banner / modal patterns in `ProjectPage`, the same button classes (`btn btn-primary`, `btn btn-ghost btn-sm`), the same color variables (`var(--danger)`, `var(--text-muted)`, `var(--border)`). Don't introduce new ad-hoc inline styles or new component patterns when existing ones fit.
- **Localizable changes.** When adding a feature, changes should be concentrated — a new IPC channel touches the handler file, `preload.js`, and `api.js` mock. A new DB column goes in `migrate()` only. A new renderer state stays in the relevant page component. Avoid cross-cutting changes that ripple into many unrelated files.
- **Future-proof sync.** Sync is bidirectional and per-entity (LWW). Never replace it with whole-blob overwrite or add counter-gated logic. Deletions only propagate via tombstones — absence from a config is never treated as deletion.

---

## Rules

### IPC — always touch all three

Every new method requires changes in exactly three places:
1. `electron/ipc/*.js` — the handler
2. `electron/preload.js` — the `contextBridge` exposure
3. `src/lib/api.js` — the mock fallback for browser dev preview

If you skip any of these, the method works in Electron but breaks in browser mode or vice versa.

IPC handlers must be validated in `electron/ipc/contracts.js`. Keep handlers thin: validate at the contract layer, call a service or DB helper, return the result.

### Database

The app is in production. Installed users must be able to update without losing data. Every DB change must be forward-compatible.

- **Never modify `initSchema`.** Add new columns/tables/indexes in the `migrations` array in `db.js` (idempotent DDL, each in a try/catch).
- **Data transforms** go in `runDataMigrations()` using `PRAGMA user_version`. Each entry runs exactly once in a transaction. Never edit existing entries — only append new ones.
- **New columns must have a DEFAULT or be nullable.** SQLite's `ALTER TABLE ADD COLUMN` requires this for existing rows. Never add a `NOT NULL` column without a default value.
- **Never rename or drop a column directly.** SQLite requires a table-copy migration for that. If unavoidable, add a new `runDataMigrations()` entry that copies data and recreates the table — do not touch `initSchema`.
- **Every insert** into `encounters`, `media_files`, `forms`, `media_types`, or `instructions` must set `sync_id` (UUID). Every insert into `reviews` must set `review_sync_id`.
- **Every synced edit** (not local-only relinking) must bump `updated_at = datetime('now')` on the row. `file_path` / `folder_path` changes do NOT bump it.
- **Call `backupDb('pre-...')`** before any cascading delete (encounter, media file, form, media type, bulk deletes, project). It's synchronous by design — it snapshots pre-delete state.
- **Startup backup** runs automatically on every launch (`backupDb('startup')`, throttled to once/12h, last 15 kept in `userData/backups/`). This is the safety net for bad migrations — don't remove it.

### Sync — hard rules

- **Tombstones are the only way deletions propagate.** `applyStructure` never prunes. If you add a new delete path for any structural entity, call the appropriate tombstone function before removing the row or the deletion won't sync.
  - Structural entities (encounter/media/form/instruction/media_type): `recordStructureTombstone(db, projectId, kind, id)`
  - Reviews: soft-delete only (`deleted_at` set, row kept)
- **`applyStructure` has two modes** — `merge: true` (LWW, auto-sync) and `merge: false` (authoritative, manual import/join). Neither prunes. Don't add pruning logic.
- **`config_version` is legacy back-compat only.** Don't use it to gate which side wins a sync. The fingerprint + per-entity `updated_at` clocks determine that.
- **No owner-gated writes.** Every machine publishes when its local content differs from the folder. `isOwner` and `owner_projects` no longer exist — don't reintroduce them.
- **Connectivity:** Cloud sync checks `net.isOnline()` before attempting. If offline, it emits `sync:offline` (first occurrence only) and returns. The 5-minute periodic pass retries automatically; when connectivity returns it emits `sync:online`. Local folder sync has no internet check.
- **Auto-sync fires** via `scheduleSync` (2s debounce after structural changes) and `startPeriodicAutoSync` (every 5 min + 15s startup pass). Review saves use `scheduleSyncForReview` (no config_version bump).

### Media

- **Video/audio:** always use the HTTP media server (`mediaServer.js`). `getMediaUrl(filePath)` returns a token URL that supports HTTP range requests. Call `media:getUrl` IPC from the renderer.
- **PDFs / other files:** use the `localfile://` protocol registered in `main.js`. Do **not** replace it with `protocol.handle` + `net.fetch` — that breaks range requests.
- Both mechanisms enforce an allowlist. Never serve arbitrary renderer-provided paths.

### UI patterns

- Toasts: `showToast(message, isError?)` — disappears after 4s. Use for transient confirmations and errors.
- Persistent banners: inline `<div>` with `background`, `borderBottom`, `padding: '8px 20px'` pattern — see the `syncError` / offline banners in `ProjectPage`. Use for states that need to stay visible until resolved.
- Setup section indices come from `src/lib/setupSections.js` (`SETUP_SECTIONS`). Never hardcode section numbers.
- Page routes: `/` → HomePage, `/project/:id` → ProjectPage, `/project/:id/setup` → SetupPage, `/review/:id` → ReviewPage, `/workspace/:id` → WorkspacePage.

### Misc

- Use `node-fetch@2` (CommonJS) for HTTP in the main process. Do **not** upgrade to v3 (ESM only).
- `app.setName('SDMo')` is called at the top of `main.js` — this sets the userData path. Don't move it.
- Form schema: `{ sections: [{ id, title, elements: [{ id, type, label }] }] }`. Form responses are keyed by element UUID. In Excel export iterate `sec.elements`, not `sec.questions`.

---

## Key Files at a Glance

| File | What it owns |
|------|-------------|
| `electron/main.js` | BrowserWindow, `localfile://` protocol, workspace windows, IPC module registration, quit hooks |
| `electron/preload.js` | `window.api` contextBridge — every renderer↔main call lives here |
| `electron/db.js` | SQLite singleton, schema init, migrations, `backupDb` |
| `electron/settings.js` | Per-install JSON settings (reviewer name, UUID, cloud tokens, media base folders) |
| `electron/sync.js` | All sync logic: protocol-v3 split-index sync, tombstones, merge, auto-sync, export/import, offline detection |
| `electron/mediaServer.js` | Token-URL HTTP server for video/audio range streaming |
| `electron/mediaLinks.js` | Per-machine file path resolution (`resolveLink`, `upsertLink`) |
| `electron/services/structure.js` | Forms/instructions/media-types save+delete domain logic; version-history capture (`form_versions`/`media_type_versions`), `listVersionHistory`, `restoreVersion` |
| `electron/services/snapshots.js` | Review-time workspace/form snapshots; `buildWorkspaceSnapshot`, `localizeWorkspaceSnapshot`, structure-migration preview/apply |
| `electron/ipc/contracts.js` | IPC argument validators |
| `electron/ipc/projects.js` | Project CRUD, password, sync:now |
| `electron/ipc/encounters.js` | Encounter CRUD + bulk ops, structure Excel export/import |
| `electron/ipc/media.js` | Media file CRUD + bulk ops, linking, playback |
| `electron/ipc/reviews.js` | Reviews, timestamps, form responses, soft-delete/restore |
| `electron/ipc/cloud.js` | Cloud OAuth, folder ops, cloud sync trigger |
| `electron/cloud/onedrive.js` | Microsoft Graph API adapter (PKCE, port 3877) |
| `electron/cloud/googledrive.js` | Google Drive API v3 adapter (port 3878) |
| `src/lib/api.js` | Renderer API wrapper + browser-mode mocks |
| `src/lib/setupSections.js` | `SETUP_SECTIONS` constants — source of truth for Setup tab indices |

---

## DB Schema (abbreviated)

```
projects
  └── media_types (config_version, archived_at) → timestamp_tags, workspace_tabs
  └── forms (schema_version, archived_at)
  └── instructions
  └── encounters
        └── media_files → media_type_id
              └── reviews (soft-deleted via deleted_at; workspace_snapshot, media_type_sync_id/version)
                    └── timestamps
                    └── form_responses (form_sync_id, form_version, form_snapshot)
form_versions        ← per-edit history of each form's schema (keyed by form_sync_id + version)
media_type_versions  ← per-edit history of each media type's config (tags + workspace tabs)
deleted_structure    ← sync tombstones for structural entities
deleted_reviews      ← legacy tombstones (still written; not used in protocol-v2 sync path)
media_file_links     ← per-machine path resolution (not synced)
```

### Versioning & snapshots

Forms and media types are **versioned**. Editing one bumps its `schema_version` / `config_version` and `structure.js` captures the prior state into `form_versions` / `media_type_versions` (via `captureFormVersion` / `captureMediaTypeVersion`, `INSERT OR IGNORE`). The Setup UI lists history (`setup:listVersionHistory`) and can restore a prior version as a new latest version (`setup:restoreVersion`).

Each **review captures a snapshot** of the exact instrument it was filled against: `reviews.workspace_snapshot` (media type + tags + workspace tabs + full form schemas) and `form_responses.form_snapshot` (the one form's schema). `WorkspacePage` renders from this snapshot, so a coder always sees the form as it was — later edits don't retroactively change in-flight or submitted reviews. The Excel export and `Responses_Long` sheet read these snapshots, so old answers keep their original labels and removed questions are never dropped.

Re-aligning existing reviews to the current structure is **opt-in**, never automatic: `setup:previewStructureMigration` shows how many drafts/submitted reviews match, `setup:migrateStructureReviews` rewrites their snapshots. Don't auto-migrate on edit.

> **Setup IPC lives in `electron/ipc/projects.js`** (channels prefixed `setup:`), not a separate `setup.js` module. New `setup:*` methods follow the same three-place rule.

## Sync File Layout (protocol v3)

```
<sync folder>/
  project-state.json       ← canonical compact index (structure + entity hashes + tombstones)
  manifest.json            ← {protocol_version, config_version, fingerprint}
  reviews/
    <review_sync_id>.json  ← full review payload (timestamps/responses/snapshots)
  form-versions/
    <form_sync_id>-vN.json ← immutable/current form-version payloads
  media-type-versions/
    <media_type_sync_id>-vN.json
```

Sync is fingerprint-driven and bidirectional. Both sides merge by `sync_id` + `updated_at` (LWW). `project-state.json` remains the single comparison/index surface: it contains structure, tombstones, and hashes/paths for split payloads. Large or frequently edited payloads live in split files, but those files must not become independent sources of truth; their hashes and paths ride in the index. Protocol-v2 monolithic `project-state.json` folders are still accepted and republished as protocol v3 on the next sync.

The Excel report (`buildReviewsWorkbook`) is **not** written during sync — it's generated on demand via the "Export Excel" button (`export:excel`). Don't reintroduce a per-sync `.xlsx` write; the per-pass upload was the slowest part of cloud sync. The workbook is version-aware: reviews keep a `form_snapshot`, so questions removed by later form edits still appear (wide-sheet columns suffixed `(removed)`, codebook `In Current Form = No`) and the `Responses_Long` sheet stays lossless.
