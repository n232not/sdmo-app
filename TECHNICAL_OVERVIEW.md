# How SDMo Works — A Complete Technical Walkthrough

Written for someone who knows basic JavaScript but has not used React, Node.js, Electron, or SQLite before.

---

## Part 1: The Technologies

### Electron — What Makes It a Desktop App

Normally JavaScript runs inside a browser and can only do browser things — show pages, fetch URLs, store cookies. It cannot read files from your hard drive, write to a database, or open a save dialog. This is intentional: you don't want a random website to be able to delete your files.

Electron solves this by bundling two things together into one desktop app:

1. **Chromium** — the same browser engine that powers Chrome. This renders the UI.
2. **Node.js** — a JavaScript runtime that has full access to your computer: files, folders, system dialogs, network calls, databases.

When you launch SDMo, Electron starts both of these simultaneously. The browser window (Chromium) shows the interface. Node.js runs invisibly in the background handling all the heavy lifting.

These two environments are deliberately kept separate for security. The UI cannot directly access your filesystem. They communicate through a message-passing system called **IPC (Inter-Process Communication)**. Think of it as two people in different rooms passing typed notes through a slot in the wall: the UI sends a request ("give me the list of encounters for project 3"), Node.js handles it, and sends back a response ("here they are").

This separation is enforced by two Electron security settings in `electron/main.js`:
```js
webPreferences: {
  contextIsolation: true,   // the renderer can't access Node globals
  nodeIntegration: false,   // the renderer can't require() Node modules
  preload: path.join(__dirname, 'preload.js')  // only this file bridges the gap
}
```

`contextIsolation: true` means the browser window's JavaScript environment is completely sandboxed — it cannot see Node.js variables, cannot call `require()`, and cannot access the filesystem. The only thing that crosses the boundary is what the preload script explicitly exposes.

---

### React — How the UI Is Built

React is a JavaScript library for building interfaces. The core idea is that instead of manually updating the page when data changes (e.g. `document.getElementById('count').innerText = newCount`), you write **components** — functions that describe what the screen should look like given some data — and React automatically updates only the parts that changed.

Every file in `src/pages/` and `src/components/` is a React component. A component is just a function that returns JSX:

```jsx
function EncounterRow({ encounter }) {
  return (
    <div className="row">
      <span>{encounter.name}</span>
      <span>{encounter.media.length} files</span>
    </div>
  )
}
```

JSX looks like HTML but it's actually JavaScript. The `<div>` above compiles to `React.createElement('div', { className: 'row' }, ...)` under the hood. You write JSX because it's far easier to read than nested function calls.

**Props** are the arguments you pass into a component — `encounter` above is a prop. They flow downward from parent to child.

**State** is how a component remembers things between renders. When state changes, React re-runs the function and updates the screen:

```js
const [encounters, setEncounters] = useState([])
// encounters starts as an empty array
// calling setEncounters([...data]) updates it and re-renders the component
```

State is local to the component that owns it. If a child component needs to change the parent's state, the parent passes down a callback function as a prop:

```jsx
// Parent
const [expanded, setExpanded] = useState({})
<EncounterRow onToggle={() => setExpanded(e => ({ ...e, [enc.id]: !e[enc.id] }))} />

// Child
<button onClick={onToggle}>Expand</button>
```

**Effects** (`useEffect`) let you run code when something happens — typically when the component first appears on screen, or when a specific value changes:

```js
useEffect(() => {
  loadEncounters()
}, [projectId])
// runs loadEncounters() when the component mounts, and again whenever projectId changes
```

The array at the end is the "dependency array." An empty array `[]` means "run once when the component mounts." Omitting it means "run after every render," which is almost never what you want.

**Cleanup:** Effects can return a function that runs when the component unmounts (leaves the screen). This is used to cancel timers, remove event listeners, etc.:

```js
useEffect(() => {
  const interval = setInterval(pollForUpdates, 15000)
  return () => clearInterval(interval)  // runs when component unmounts
}, [])
```

**Refs** (`useRef`) are like state but they don't trigger re-renders. They're used for things that change frequently (like the current video time, 30x per second) or for holding a direct reference to a DOM element:

```js
const playerRef = useRef(null)
// playerRef.current is the actual DOM element or object
playerRef.current.seekTo(42.5)  // jump to 42.5 seconds in the video
```

**React Router** (`react-router-dom`) handles navigation between pages without a full page reload. Routes are defined in `src/main.jsx`:

```jsx
<Routes>
  <Route path="/" element={<HomePage />} />
  <Route path="/project/:projectId" element={<ProjectPage />} />
  <Route path="/project/:projectId/setup" element={<SetupPage />} />
  <Route path="/review/:reviewId" element={<ReviewPage />} />
</Routes>
```

The `:projectId` and `:reviewId` parts are URL parameters — they match any value. Inside a page, `useParams()` extracts them:

```js
const { projectId } = useParams()
// If the URL is /project/3, projectId === "3" (always a string)
```

`useNavigate()` gives you a function to change the URL programmatically:
```js
const navigate = useNavigate()
navigate(`/project/${projectId}/setup`)
```

---

### Node.js — The Local Backend

Node.js is JavaScript that runs outside the browser, directly on your computer. It was built for running servers, but here it's used as a local backend — a "server" that runs on your own machine inside Electron.

Node.js uses a **module system** where each file is its own module. You export things with `module.exports` and import them with `require()`:

```js
// electron/db.js
module.exports = { getDb }

// electron/ipc/encounters.js
const { getDb } = require('../db')
```

This is the older CommonJS module format. React uses the newer ESM format (`import`/`export`). The app uses both — Electron (main process) uses CommonJS, React (renderer) uses ESM. Vite handles the translation during the build.

Node.js is single-threaded but handles multiple operations via an **event loop**. When you do something that takes time (reading a file, making an HTTP call), Node.js registers a callback and continues running other code. When the operation finishes, the callback runs. `async/await` is syntactic sugar over this:

```js
async function doCloudSync() {
  const files = await adapter.listFiles(folderId)  // waits for the API call
  for (const file of files) {
    const data = await adapter.readFile(file.id)   // waits for each file
    mergeReviewFile(db, projectId, data)
  }
}
```

`await` pauses execution of the current function until the Promise resolves, but doesn't block Node.js from handling other things in the meantime.

---

### SQLite — The Database

SQLite is a database that lives entirely in a single file (`sdmo.db`) stored in your computer's app data folder (`~/Library/Application Support/SDMo/` on Mac, `%AppData%/SDMo/` on Windows). There is no database server, no installation required, no separate process running. The app opens the file and runs SQL queries directly against it.

The library `better-sqlite3` gives Node.js access to SQLite. Notably, it's **synchronous** — queries block until they complete. This is unusual for Node.js (which normally does everything asynchronously) but fine here because SQLite is fast and the database is local. Synchronous queries are simpler to write and read.

```js
// Prepare a statement once, run it many times (more efficient)
const stmt = db.prepare('SELECT * FROM encounters WHERE project_id = ?')
const rows = stmt.all(projectId)   // returns array of rows
const row  = stmt.get(projectId)   // returns first row or undefined

// Insert and get the auto-generated ID
const result = db.prepare('INSERT INTO encounters (project_id, name) VALUES (?, ?)').run(projectId, name)
result.lastInsertRowid  // the new row's id

// Transactions: all-or-nothing group of operations
const tx = db.transaction(() => {
  db.prepare('DELETE FROM timestamps WHERE review_id=?').run(reviewId)
  db.prepare('DELETE FROM reviews WHERE id=?').run(reviewId)
})
tx()  // runs both or neither
```

`?` in queries are **prepared statement placeholders** — the values are passed separately so SQLite handles escaping, preventing SQL injection attacks. Never concatenate user input directly into a SQL string.

**WAL mode** is enabled on startup (`db.pragma('journal_mode = WAL')`). WAL (Write-Ahead Logging) is a SQLite journal mode that allows reads and writes to happen simultaneously without blocking each other, which matters when the app is syncing in the background while the user is actively reviewing.

The database schema (the table definitions) lives in `electron/db.js` in the `initSchema` function, which uses `CREATE TABLE IF NOT EXISTS` so it only creates tables that don't exist yet. New columns added later (as the app evolves) are handled by the `migrations` array — each entry is a single `ALTER TABLE` statement wrapped in a try/catch that silently ignores "column already exists" errors:

```js
const migrations = [
  "ALTER TABLE reviews ADD COLUMN reviewer_uuid TEXT",
  "ALTER TABLE reviews ADD COLUMN review_sync_id TEXT",
  // ...
]
for (const sql of migrations) {
  try { db.exec(sql) } catch (_) {}  // silently skip if already exists
}
```

After migrations run, startup also backfills missing `sync_id` and `review_sync_id` values on existing rows using `crypto.randomUUID()`, so records created before those columns existed still get proper identifiers.

---

## Part 2: How the Two Halves Talk to Each Other

This is the most important architectural concept in the app.

### `electron/preload.js` — The Bridge

This file runs in a special context that can see both the renderer's JavaScript environment and the IPC system. It uses Electron's `contextBridge` to expose a set of functions to the UI under `window.api`:

```js
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  listEncounters: (projectId) =>
    ipcRenderer.invoke('encounters:list', projectId),

  createEncounter: (projectId, name) =>
    ipcRenderer.invoke('encounters:create', projectId, name),

  deleteEncounter: (projectId, encounterId) =>
    ipcRenderer.invoke('encounters:delete', projectId, encounterId),
  // ... dozens more
})
```

`ipcRenderer.invoke(channel, ...args)` sends a message to the main process on the named channel and returns a **Promise** that resolves with whatever the handler returns. The UI `await`s that Promise to get the result.

The naming convention is `domain:action` — `encounters:list`, `reviews:create`, `sync:now`, `cloud:connectOneDrive`. This keeps channels organized and makes it easy to find what handles what.

### `electron/ipc/*.js` — The Handlers

Each file in `electron/ipc/` exports a function that receives `ipcMain` and registers handlers for one domain. `electron/main.js` calls all of them:

```js
// electron/main.js
require('./ipc/projects')(ipcMain)
require('./ipc/encounters')(ipcMain)
require('./ipc/media')(ipcMain)
require('./ipc/reviews')(ipcMain)
require('./ipc/cloud')(ipcMain)
```

Inside each file, `ipcMain.handle` registers a handler for a channel:

```js
ipcMain.handle('encounters:list', (_, projectId) => {
  const db = getDb()
  const encounters = db.prepare('SELECT * FROM encounters WHERE project_id=? ORDER BY name').all(projectId)
  // ... attach media files and reviews to each encounter
  return encounters
})
```

The first argument to the callback is the Electron event object (unused, hence `_`). The remaining arguments are whatever was passed from the renderer. Whatever the function returns gets sent back as the Promise result.

### `src/lib/api.js` — The UI's Wrapper

The UI never calls `window.api` directly. `src/lib/api.js` wraps it and provides a fallback with mock data for when the app runs in a plain browser (useful during UI development without needing to run Electron):

```js
const isElectron = typeof window !== 'undefined' && !!window.api

export const api = isElectron ? window.api : {
  listEncounters: async () => [],        // returns empty array in browser
  createEncounter: async () => ({ id: Date.now() }),  // returns fake row
  // ...
}
```

Every page and component imports `api` from here. A call like `api.listEncounters(projectId)` travels: `src/pages/ProjectPage.jsx` → `src/lib/api.js` → `window.api.listEncounters` → `electron/preload.js` → IPC → `electron/ipc/encounters.js` handler → SQLite query → back up the chain.

### One-Way Push Events

Most communication is request/response (UI asks, main process answers). But some things need to be pushed from the main process to the UI without the UI asking — for example, when a sync finishes and new data is available.

For this, the main process uses `mainWindow.webContents.send(channel, data)`:

```js
// In electron/sync.js, after detecting a newer config in the cloud
_mainWindow.webContents.send('sync:configUpdateAvailable', { projectId, configData })
```

The renderer listens with `ipcRenderer.on`:

```js
// In electron/preload.js
onConfigUpdateAvailable: (cb) =>
  ipcRenderer.on('sync:configUpdateAvailable', (_, d) => cb(d)),
offConfigUpdateAvailable: (cb) =>
  ipcRenderer.removeListener('sync:configUpdateAvailable', cb),
```

In the UI, this is used to show the "New configuration available" banner when a PI has updated the project structure.

---

## Part 3: The Database Schema

The database has these tables (all defined in `electron/db.js`). `initSchema` creates the base tables with `CREATE TABLE IF NOT EXISTS`; the `migrations` array adds every column/index/table that came later, each statement wrapped in try/catch so re-running is harmless. **Important:** never edit `initSchema` to change an existing table — add a new `ALTER TABLE`/`CREATE TABLE` to the `migrations` array instead. Data transforms (not shape changes) go in `runDataMigrations`, gated by `PRAGMA user_version` so each runs exactly once.

### `projects`
The top-level table. One row per project on this machine.

Key columns: `name`, `description`, `media_folder` (local path to the media folder), `sync_folder` (local folder path for sync), `cloud_provider` (`'onedrive'` or `'googledrive'` or null), `cloud_folder_id` (the cloud folder's ID), `config_version` (integer; **legacy back-compat only** — see Part 5, no longer gates who wins a sync), `owner_password_hash` (SHA-256 hash of the admin password), `keybinds` (JSON array of keyboard shortcut mappings).

### `encounters`
One row per encounter (patient visit / session).

Key columns: `project_id` (FK to projects), `name`, `folder_path` (local path matched during media scan), `sync_id` (stable UUID used to identify this encounter across machines even if renamed), `updated_at` (per-entity modification clock for sync — NULL on old rows, readers fall back to `created_at`).

### `media_files`
One row per media file (video, PDF, etc.) within an encounter.

Key columns: `encounter_id` (FK to encounters), `name`, `file_path` (legacy/seed path — current path resolution is per-machine via `media_file_links`, below), `file_type` (`'video'`, `'audio'`, `'document'`, `'other'`), `media_type_id` (FK to media_types, determines which tags and forms appear), `sync_id` (stable UUID), `updated_at`.

### `media_file_links`
**Per-machine** file path resolution — this table is NOT synced. Each machine records where it found a given media file locally, so the absolute path never has to travel between machines.

Key columns: `media_file_id` (FK, UNIQUE), `local_path`, `is_relative` (resolved against the machine's media base folder when set), `not_applicable` (the user marked this file as intentionally absent here). `electron/mediaLinks.js` owns this: `resolveLink()` returns `{ status, resolved_path }` and `upsertLink()` records a match. `db.js`'s `seedMediaLinks()` backfills links from any existing `file_path` that still exists on disk.

### `media_types`
Defines categories of media files — e.g., "Video" or "Audio Interview." **Versioned.**

Key columns: `project_id`, `name`, `reviews_required` (how many completed reviews count as "done"), `allow_custom_tags`, `color` (hex color for UI display), `config_version` (bumped on every edit), `archived_at` (set instead of hard-deleting when reviews reference it), `sync_id`, `updated_at`.

### `timestamp_tags`
The clickable tag buttons that appear in the review page sidebar.

Key columns: `media_type_id` (FK — tags belong to a media type), `label`, `color`, `description`.

### `workspace_tabs`
Which forms and instructions appear as tabs in the review workspace.

Key columns: `media_type_id`, `tab_type` (`'form'` or `'instruction'`), `ref_id` (local FK to forms or instructions table), `label`, `sort_order`. Because `ref_id` is a local database id, the synced representation carries the referenced item's `sync_id`/name and each machine re-resolves it to its own local id.

### `forms`
Structured questionnaires coders fill out during a review. **Versioned.**

Key columns: `project_id`, `name`, `schema` (JSON string defining sections and elements — see Part 4 for the format), `schema_version` (bumped on every edit), `archived_at` (set instead of hard-deleting when responses reference it), `sync_id`, `updated_at`.

### `instructions`
Reference documents coders can view while reviewing.

Key columns: `project_id`, `name`, `content_type` (`'markdown'` or `'pdf'`), `content` (markdown text), `file_path` (path to PDF file if applicable), `sync_id`, `updated_at`.

### `form_versions` and `media_type_versions`
History tables. Whenever a form or media type is edited, the *prior* state is captured here before the live row is overwritten, so any earlier version can be inspected or restored.

`form_versions` columns: `project_id`, `form_sync_id`, `version`, `name`, `schema` (JSON), `source_updated_at`, `created_at`, `UNIQUE(project_id, form_sync_id, version)`. `media_type_versions` mirrors it with a `config` JSON (tags + workspace tabs) instead of `schema`. `electron/services/structure.js` writes these with `INSERT OR IGNORE`.

### `reviews`
One row per coder per media file — the core unit of work.

Key columns: `media_file_id` (FK), `reviewer_name`, `reviewer_uuid` (the UUID of the machine that created this review), `review_sync_id` (stable UUID for this specific review — used for precise sync matching and deletion targeting), `status` (`'in_progress'` or `'submitted'`), `notes`, `created_at`, `submitted_at`, `deleted_at` (null unless soft-deleted), `restored_at`. **Snapshot columns:** `workspace_snapshot` (JSON of the exact media type, tags, workspace tabs, and full form schemas the coder saw — captured at review time), `media_type_sync_id`, `media_type_version`.

### `timestamps`
Individual timestamped observations logged during a review.

Key columns: `review_id` (FK), `time_seconds` (float — the video time in seconds), `tag_id` (FK to timestamp_tags, nullable for custom tags), `tag_label`, `tag_color`, `notes`, `created_at`.

### `form_responses`
A coder's answers to a form within a review.

Key columns: `review_id`, `form_id`, `responses` (JSON object keyed by element UUID: `{ "element-uuid": value }`). One row per (review, form) pair — the entire response object is stored and replaced on every save. **Snapshot columns:** `form_sync_id`, `form_version`, `form_snapshot` (JSON of the form's schema as it was when answered — this is what makes the Excel export keep old labels and never drop removed questions; see Part 4).

### `deleted_structure`
The tombstone table for **structural** deletions (encounter, media file, form, instruction, media type). Recording a tombstone here is the only way a structural deletion propagates — sync never infers deletion from absence.

Key columns: `project_id`, `kind` (e.g. `'encounter'`, `'media'`, `'form'`, `'instruction'`, `'media_type'`), `sync_id`, `deleted_at`, `UNIQUE(project_id, kind, sync_id)`.

### `deleted_reviews`
A legacy tombstone table for reviews. It's still written for backward compatibility, but the protocol-v2 sync path no longer reads it — review deletions now travel as `deleted_at` inside the shared project-state snapshot (soft-delete, row kept). Has a `UNIQUE(project_id, encounter_name, media_name, reviewer_name)` constraint; `INSERT OR IGNORE` skips duplicates.

---

## Part 4: The Pages

### Home Page (`src/pages/HomePage.jsx`)

**What it shows:** A list of your projects, a field to enter your reviewer name, and buttons to create or join a project. The tutorial tooltip sequence runs here on first launch.

**Loading projects:**

```js
useEffect(() => {
  api.listProjects().then(setProjects)
  api.getAppSettings().then(s => setReviewerName(s.reviewer_name || ''))
}, [])
```

`api.listProjects()` runs `SELECT * FROM projects ORDER BY created_at DESC` and returns all projects stored in the local SQLite database. This list is local — projects you've joined on other machines don't appear here unless you import them.

`api.getAppSettings()` reads `app-settings.json` — a JSON file (not the database) stored in the app's data folder. It holds machine-wide settings like the reviewer name, the machine UUID, and cloud OAuth tokens. App settings are intentionally kept out of the database because the database might be wiped or recreated from a sync, but settings like your identity and credentials should persist.

**Creating a project:**

When you click New Project and submit the form:
```js
const project = await api.createProject({ name, description })
navigate(`/project/${project.id}/setup`)
```

`createProject` runs `INSERT INTO projects (name, description) VALUES (?, ?)` and returns the new row. The app immediately navigates to that project's Setup page so you can configure it.

**Importing a project file:**

`api.importProjectAsNew()` opens a system file picker (`dialog.showOpenDialog`), reads the selected JSON file, and calls `createFromImport(db, data)` in `sync.js`. This creates a new project row and then calls `mergeImport` to upsert all encounters, forms, media types, and reviews from the file. It returns a `syncHint` — if the exported file came from a cloud-synced project, the hint tells the new project which cloud provider was used, so Setup can pre-configure the sync settings.

**The tutorial system:**

`TutorialBubble` is a component that renders a tooltip bubble positioned next to a specific element on the page. It uses a **React portal** — rendered into `document.body` so it floats above everything — and positions itself using `getBoundingClientRect()` on the target element:

```js
const rect = document.getElementById('tut-new').getBoundingClientRect()
// position the bubble at: { top: rect.bottom + 8, left: rect.left }
```

Tutorial state (which step you're on, whether it's dismissed) is stored in `localStorage` under the key `sdmo_tutorial_v1`. The `?` button in the top bar resets the step to 0 and sets `active: true` to restart it.

---

### Project Page (`src/pages/ProjectPage.jsx`)

**What it shows:** A sidebar with four views and a content area. This is the hub of the app — where coders see their work and admins track progress.

**Loading:**

```js
async function load() {
  try { await api.fetchProjectStructure(projectId) } catch {}
  const [proj, encs, types, status, health] = await Promise.all([
    api.getProject(projectId),
    api.listEncounters(projectId),
    api.listMediaTypes(projectId),
    api.getSyncStatus(projectId),
    api.mediaHealthCheck(projectId),
  ])
  setProject(proj)
  setEncounters(encs)
  // ...
}
```

The first call, `fetchProjectStructure`, attempts to pull the latest config from the sync folder before loading local data. This ensures you see up-to-date encounter lists if the PI has made changes since you last opened the project. It's wrapped in try/catch because if sync isn't configured or the network is unavailable, the page should still load from local data.

`Promise.all` fires all five async calls simultaneously and waits for all of them. This is roughly 5x faster than calling them sequentially.

**The encounter list:**

`encounters:list` is the most complex IPC handler in the app. It returns not just encounter rows but also their media files, and for each media file, its reviews:

```js
ipcMain.handle('encounters:list', (_, projectId) => {
  const encounters = db.prepare('SELECT * FROM encounters WHERE project_id=? ORDER BY name').all(projectId)
  for (const enc of encounters) {
    const media = db.prepare(`
      SELECT mf.*, mt.name as media_type_name, mt.reviews_required, mt.color as media_type_color
      FROM media_files mf
      LEFT JOIN media_types mt ON mf.media_type_id = mt.id
      WHERE mf.encounter_id=? ORDER BY mf.name
    `).all(enc.id)
    for (const m of media) {
      const reviews = db.prepare(
        'SELECT id, reviewer_name, status, created_at, submitted_at FROM reviews WHERE media_file_id=? AND deleted_at IS NULL'
      ).all(m.id)
      m.reviews = reviews
      m.reviews_completed = reviews.filter(r => r.status === 'submitted').length
    }
    enc.media = media
    enc.completed = media.length > 0 && media.every(m =>
      m.reviews_required && m.reviews_completed >= m.reviews_required
    )
  }
  return encounters
})
```

`LEFT JOIN` means "include media_type data if it exists, but return the row even if media_type_id is null." The handler assembles a nested object tree in JavaScript rather than making separate IPC calls from the UI for each level — one round trip is much faster than dozens.

**Collapsible rows:**

Expanded state is stored as a plain object `{ [encounterId]: boolean }`. Toggling an encounter:

```js
function toggle(encId) {
  setExpanded(e => ({ ...e, [encId]: !e[encId] }))
}
```

`{ ...e, [encId]: !e[encId] }` is the spread operator creating a new object with all existing keys plus one overridden key. React requires state updates to create a new object (not mutate the existing one) so it can detect the change.

**Search and filtering:**

The `applyFilters` function runs purely in JavaScript on the already-loaded `encounters` array — no database query needed:

```js
function applyFilters(encs) {
  let result = encs
  if (search.trim()) {
    const q = search.toLowerCase()
    result = result.filter(enc =>
      enc.name.toLowerCase().includes(q) ||
      enc.media?.some(m => m.name.toLowerCase().includes(q))
    )
  }
  if (filters.completion === 'complete') result = result.filter(e => e.completed)
  if (filters.completion === 'incomplete') result = result.filter(e => !e.completed)
  if (filters.mediaType) result = result.filter(e =>
    e.media?.some(m => m.media_type_id == filters.mediaType)
  )
  return result
}

const filtered = applyFilters(encounters)
```

`filtered` is a derived value computed fresh on every render. This works because the encounters array (already in memory) is small enough to filter instantly. There's no need to query the database each time the search box changes.

**The 15-second polling loop:**

```js
useEffect(() => {
  const interval = setInterval(async () => {
    try {
      const manifest = await api.checkManifest(projectId)
      if (manifest && manifest.config_version > manifest.local_version) {
        await api.fetchProjectStructure(projectId)
        setEncounters(await api.listEncounters(projectId))
      }
    } catch {}
  }, 15000)
  return () => clearInterval(interval)
}, [projectId])
```

`checkManifest` reads `manifest.json` from the sync folder — a tiny file carrying the protocol version, `config_version`, and a content **fingerprint**. If it indicates the folder has changed relative to local, `fetchProjectStructure` pulls and merges the full `project-state.json`. If nothing changed, the poll does no further work. This avoids reading/merging the (potentially large) full snapshot every 15 seconds when nothing has changed. (See Part 5 for the snapshot + fingerprint model.)

**The Progress view:**

`ProgressView` is a pure calculation over the `encounters` array already in React state — no IPC needed:

```js
function ProgressView({ encounters, mediaTypes }) {
  const allReviews = encounters.flatMap(e => e.media.flatMap(m => m.reviews))
  const submitted = allReviews.filter(r => r.status === 'submitted').length
  const total = allReviews.length

  // Group reviews by reviewer_name
  const byReviewer = {}
  for (const r of allReviews) {
    if (!byReviewer[r.reviewer_name]) byReviewer[r.reviewer_name] = { submitted: 0, total: 0 }
    byReviewer[r.reviewer_name].total++
    if (r.status === 'submitted') byReviewer[r.reviewer_name].submitted++
  }
  // render stat cards, bars, etc.
}
```

**The Activity view:**

`ActivityView` creates a flat list of events from reviews across all encounters, sorted by timestamp, then groups them by calendar date for display:

```js
function ActivityView({ encounters }) {
  const events = encounters.flatMap(enc =>
    enc.media.flatMap(m =>
      m.reviews.map(r => ({
        type: r.status === 'submitted' ? 'submitted' : 'started',
        reviewer: r.reviewer_name,
        encounter: enc.name,
        media: m.name,
        time: new Date(r.status === 'submitted' ? r.submitted_at : r.created_at),
      }))
    )
  ).sort((a, b) => b.time - a.time)

  // Group by date label ("Today", "Yesterday", "Jun 25", etc.)
}
```

**Media health check:**

`api.mediaHealthCheck(projectId)` calls `electron/ipc/media.js` which runs:

```js
ipcMain.handle('media:healthCheck', (_, projectId) => {
  const allFiles = db.prepare(`
    SELECT mf.id, mf.file_path, mf.name
    FROM media_files mf
    JOIN encounters e ON mf.encounter_id = e.id
    WHERE e.project_id=?
  `).all(projectId)

  let unlinked = 0, broken = 0, ok = 0
  for (const f of allFiles) {
    if (!f.file_path) unlinked++
    else if (!fs.existsSync(f.file_path)) broken++
    else ok++
  }
  return { unlinked, broken, ok, total: allFiles.length, hasMediaFolder: !!project.media_folder }
})
```

"Unlinked" means the `file_path` column is empty — the file was added via config sync but hasn't been matched to a local file yet. "Broken" means there's a file path recorded but the file doesn't exist at that path on this machine. The warning banner shown on the Project page is driven by this data.

**Excel export:**

`api.exportExcel(projectId)` (handler `export:excel` in `electron/ipc/projects.js`) calls `buildReviewsWorkbook` in `sync.js`, which builds a multi-sheet workbook with the `xlsx` library and saves it to a path the user picks. This export is **on demand only** — earlier versions rewrote and re-uploaded the spreadsheet on every sync, which was the slowest part of cloud sync; that auto-write was removed and the button is now the single way to produce the file.

The workbook is structured for analysis, not just display:

- **README** — a guide to the other sheets.
- **Codebook** — one row per question/component, with stable IDs, type, valid values, the matching wide-sheet column header, the form's current version, and an **In Current Form** flag.
- **Reviews** — one row per non-deleted review with join keys.
- **Responses_Long** — the canonical, tool-friendly sheet: one row per answer.
- **Media_Files**, **Timestamps** — normalized supporting sheets.
- **`<Media Type>` Reviews / Timestamps** — readable "wide" convenience sheets, one column per question.

Crucially, the export is **version-aware**. It reads each review's `form_snapshot` (Part 5), so an answer keeps the question label it had when it was given, and a question that was later removed from the form still appears — its wide-sheet column is suffixed `(removed)` and its codebook row is flagged `In Current Form = No`. No answered data is dropped when forms change. Form elements are always iterated as `sec.elements` (never `sec.questions`).

---

### Setup Page (`src/pages/SetupPage.jsx`)

**What it shows:** Ten tabs of project configuration, behind an optional password gate. The tab indices are **not** hardcoded — they come from `SETUP_SECTIONS` in `src/lib/setupSections.js`, which is the single source of truth: `OVERVIEW (0)`, `FORMS (1)`, `INSTRUCTIONS (2)`, `MEDIA_TYPES (3)`, `ENCOUNTERS (4)`, `FILES (5)`, `SYNC (6)`, `KEYBINDS (7)`, `ACCESS (8)`, `DELETED_REVIEWS (9)`. Always reference these constants rather than a literal number, since inserting a tab shifts the rest. (Note: the subsection headings below were written against an earlier ordering — trust `setupSections.js` for the current numbers.)

**The password gate:**

On load, `getSyncStatus(projectId)` returns `{ hasPassword: boolean, isUnlocked: boolean }`. `hasPassword` comes from checking if `projects.owner_password_hash` is non-null. `isUnlocked` comes from checking an in-memory `Set` in the main process:

```js
// electron/ipc/projects.js
const unlockedProjects = new Set()

ipcMain.handle('project:verifyPassword', (_, projectId, password) => {
  const hash = crypto.createHash('sha256').update(password).digest('hex')
  const project = db.prepare('SELECT owner_password_hash FROM projects WHERE id=?').get(projectId)
  if (hash === project.owner_password_hash) {
    unlockedProjects.add(String(projectId))
    return true
  }
  return false
})
```

The `unlockedProjects` Set exists only in memory. When the app restarts, it's empty. The PI needs to re-enter their password each session. The hash is SHA-256 — a one-way function so the actual password is never stored anywhere.

The React side avoids re-prompting on every save using a functional state update:

```js
setIsUnlocked(prev => {
  if (!hasPw) return true      // no password set, always unlocked
  if (prev) return true        // already unlocked this session
  setShowUnlock(true)          // show the password modal
  return false
})
```

By checking `prev` (the current value), the function only shows the modal if the session isn't already unlocked. Without this pattern, every call to `setIsUnlocked(false)` would show the modal.

**Tab navigation:**

The active tab is a number (0–9) in state. Each tab button sets it:

```jsx
<button onClick={() => setSection(6)}>Sync</button>
```

The URL can also carry a section: `?section=6`. This lets the rest of the app link directly to a specific tab (e.g. the media health warning links to "Setup → Sync").

**Overview tab (0):**

Simple text fields for project name and description. Saving calls `api.updateProject(projectId, { name, description })` which runs `UPDATE projects SET name=?, description=? WHERE id=?`, then calls `bumpConfigVersion` + `scheduleSync`. Every structural change bumps the version so other machines know to pull the new config.

**Forms tab (1):**

Forms are stored as a JSON schema:

```json
{
  "sections": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "title": "Patient Behavior",
      "elements": [
        {
          "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
          "type": "select",
          "label": "Engagement level",
          "options": ["Low", "Medium", "High"]
        },
        {
          "id": "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
          "type": "text",
          "label": "Notes"
        }
      ]
    }
  ]
}
```

Every section and element has a UUID generated when created (`crypto.randomUUID()`). UUIDs are used as keys in `form_responses.responses` — this means if you reorder or rename fields, existing responses (keyed by UUID) still match the right fields. If you used array indices instead, reordering would corrupt old responses.

The form builder UI is a nested list of draggable sections and elements. Adding an element calls `setForm(f => ({ ...f, sections: f.sections.map(s => s.id === sectionId ? { ...s, elements: [...s.elements, newElement] } : s) }))` — immutably inserting into the nested structure.

Saving calls `api.saveForm(projectId, { name, schema })` which upserts by name: if a form with that name exists, update its schema; otherwise insert. Each save bumps `schema_version` and snapshots the previous schema into `form_versions` (see Part 5). The tab surfaces this history — you can view or restore an earlier version — and, when a form that already has responses is edited, offers the opt-in structure-migration prompt rather than silently re-aligning existing reviews.

Beyond simple text and choice fields, the form builder supports a range of element `type`s, all rendered by `src/components/forms/FormRenderer.jsx`: `short_answer`, `paragraph`, `multiple_choice`, `multiselect`, `checkbox`, `rating`, `slider`, `likert`, `likert_group` (a shared scale applied to a list of items), `timestamp_select` (capture a video time + optional tag), `table` (a grid whose columns can themselves be text/number/select/timestamp), and `text_block` (display-only, not a question). The Excel export knows how to flatten each of these into analysis-friendly columns.

**Instructions tab (2):**

Instructions can be markdown or PDF. Markdown is stored directly in the `instructions.content` column. PDFs are uploaded to the local app data folder (`~/Library/Application Support/SDMo/projects/{projectId}/`) and the path is stored in `instructions.file_path`. The PDF binary is base64-encoded into the synced `project-state.json` snapshot so it can travel to other machines:

```js
pdf_data = fs.readFileSync(i.file_path).toString('base64')
// On import:
fs.writeFileSync(filePath, Buffer.from(i.pdf_data, 'base64'))
```

**Media Types tab (3):**

Each media type has a list of timestamp tags and a list of workspace tabs. Saving replaces them completely:

```js
db.prepare('DELETE FROM timestamp_tags WHERE media_type_id=?').run(mtId)
for (const tag of mt.tags) {
  db.prepare('INSERT INTO timestamp_tags (media_type_id, label, color, description) VALUES (?,?,?,?)').run(...)
}
db.prepare('DELETE FROM workspace_tabs WHERE media_type_id=?').run(mtId)
for (const tab of mt.workspace_tabs) {
  // resolve ref_name to ref_id (form or instruction id)
  db.prepare('INSERT INTO workspace_tabs (media_type_id, tab_type, ref_id, label, sort_order) VALUES (?,?,?,?,?)').run(...)
}
```

Workspace tabs store the referenced item's `sync_id` and name in the synced snapshot and resolve it to a local `ref_id` (the form's or instruction's database ID) on each machine. This is necessary because those IDs differ between machines.

Like forms, media types are versioned: saving bumps `config_version` and snapshots the previous config (tags + tabs) into `media_type_versions`, so the tab can show history and restore a prior version. Deleting a media type that media files still reference sets `archived_at` rather than hard-deleting.

**Encounters (4) and Files (5) tabs:**

The encounter list and the media-file list were split into two tabs, but they share the same media-folder scan flow described here. Picking a folder calls `api.selectFolder()` → `dialog.showOpenDialog({ properties: ['openDirectory'] })` — Electron's built-in folder picker. The selected path is stored in `projects.media_folder`.

Clicking Scan calls `api.scanMediaFolder(folderPath, projectId)` which:

1. Reads the folder's subdirectories — each is treated as a potential encounter folder
2. For each subdirectory, looks for a matching encounter by folder name or encounter name
3. If found, reads the files inside and links them to media_file rows in the database
4. If an encounter doesn't exist yet, creates it
5. If a media_file record exists but has an empty `file_path`, fills it in
6. Returns counts: `encountersAdded`, `filesAdded`, `stillUnlinked`, `stillBroken`

```js
const folderName = path.basename(subdir)
let enc = db.prepare('SELECT id FROM encounters WHERE project_id=? AND (name=? OR folder_path=?)').get(projectId, folderName, subdir)
if (!enc) {
  const r = db.prepare('INSERT INTO encounters (project_id, name, folder_path, sync_id) VALUES (?,?,?,?)').run(projectId, folderName, subdir, crypto.randomUUID())
  enc = { id: r.lastInsertRowid }
}
```

**Sync tab (6):**

Three modes:

**None:** No sync. Only manual export/import. Existing projects that haven't set up sync stay here.

**Local folder:** The user picks a shared folder path. The path is saved to `projects.sync_folder`. After saving, `doLocalSync` runs immediately to write the initial `project-state.json` + `manifest.json` (see Part 5 for the layout).

**Cloud:** The user clicks "Connect to OneDrive" or "Connect to Google Drive." This opens the OAuth flow in the system browser (not inside the app — Electron uses `shell.openExternal(authUrl)` to open the real browser). A local HTTP server catches the OAuth redirect. After authentication, the user picks a folder from a tree picker modal. The folder ID is saved to `projects.cloud_folder_id` and `projects.cloud_provider`.

"Join by share link" parses a OneDrive or Google Drive share URL, resolves it to a folder ID via the respective API, and saves it as the sync folder — letting coders join a project by pasting a URL instead of navigating a folder tree.

**Keybinds tab (7):**

Keybinds are stored as a JSON array on `projects.keybinds`:

```json
[
  { "key": "1", "tag_label": "Positive Behavior", "tag_color": "#22c55e" },
  { "key": "2", "tag_label": "Negative Behavior", "tag_color": "#ef4444" }
]
```

The UI renders each timestamp tag from all media types and lets you assign a key to each. Saving serializes the array and runs `UPDATE projects SET keybinds=?`.

**Access tab (8):**

Setting a password calls `api.setOwnerPassword(projectId, password)` which:

```js
const hash = crypto.createHash('sha256').update(password).digest('hex')
db.prepare('UPDATE projects SET owner_password_hash=? WHERE id=?').run(hash, projectId)
```

The plain-text password never touches the database. Only its hash is stored. Since SHA-256 is one-way, even someone who opens `sdmo.db` directly cannot recover the password.

**Deleted Reviews tab (9):**

Shows all soft-deleted reviews. `reviews:listDeleted` queries:

```js
SELECT r.id, r.reviewer_name, r.status, r.deleted_at, mf.name as media_name, e.name as encounter_name
FROM reviews r
JOIN media_files mf ON r.media_file_id = mf.id
JOIN encounters e ON mf.encounter_id = e.id
WHERE e.project_id=? AND r.deleted_at IS NOT NULL
ORDER BY r.deleted_at DESC
```

Restoring a review sets `deleted_at = NULL` and `restored_at = datetime('now')`, then deletes the tombstone record from `deleted_reviews` by `review_sync_id` so the restore propagates to other machines (they'll see the tombstone is gone and won't re-delete it on next sync).

---

### Review Page (`src/pages/ReviewPage.jsx`)

**What it shows:** A video (or document) player on the left and a tabbed workspace on the right containing the timestamp logger and any configured forms or instructions.

**Loading a review and resolving the media file:**

The renderer doesn't hand a raw file path to the player. It asks the main process to resolve where *this machine* has the file and how to serve it:

```js
const review = await api.getReview(reviewId)
const playback = await api.getPlaybackInfo(review.media_file_id)
// playback = { status, resolved_path, url, file_type }
```

`media:getPlaybackInfo` (`electron/ipc/media.js`) calls `resolveLink()` (`electron/mediaLinks.js`), which consults the per-machine `media_file_links` table and the machine's media base folder. If the file isn't linked locally yet, `status` is something other than `'linked'` and `url` is null — the UI shows an "unlinked" state instead of a broken player. If it *is* linked, the handler returns a `url` to play.

**Two different serving mechanisms, by file type:**

- **Video and audio** are served by a small local **HTTP media server** (`electron/mediaServer.js`). `getMediaUrl(resolved_path)` registers the path behind a single-use-ish token and returns a `http://127.0.0.1:<port>/media/<token>` URL. This server implements HTTP **range requests** — the browser's mechanism for fetching a specific byte range (e.g. "bytes 5,000,000–6,000,000"), which is how video seeking works without downloading the whole file first. Serving through a real HTTP server (rather than a custom protocol) gives correct, well-tested range behavior for large media.
- **PDFs and other documents** are served through the `localfile://` protocol registered in `electron/main.js` with `protocol.registerFileProtocol`. Do **not** "modernize" this to `protocol.handle` + `net.fetch` — that path streams through Node and breaks range requests.

Both mechanisms enforce an allowlist of resolved paths; neither will serve an arbitrary path the renderer makes up.

**Video player:**

React Player wraps an HTML `<video>` element. Time tracking uses a ref to avoid re-renders:

```js
const currentTimeRef = useRef(0)

<ReactPlayer
  ref={playerRef}
  onProgress={({ playedSeconds }) => { currentTimeRef.current = playedSeconds }}
  url={videoUrl}
/>
```

Calling `playerRef.current.seekTo(seconds)` jumps to a time. Toggling fullscreen uses Electron's `window:setFullscreen` IPC and hides the top bar.

**Timestamp logging:**

When you click a tag button:

```js
async function handleTag(tag) {
  const time = currentTimeRef.current
  const ts = await api.saveTimestamp(reviewId, {
    time_seconds: time,
    tag_label: tag.label,
    tag_color: tag.color,
    notes: '',
  })
  setTimestamps(prev => [...prev, { ...ts, time_seconds: time, tag_label: tag.label }])
}
```

The timestamp is saved to the database immediately and added to local state. `scheduleSyncForReview(reviewId)` is called inside the IPC handler, which traces up through the foreign keys (review → media_file → encounter → project) to get the `project_id`, then calls `scheduleSync(projectId)` with a 2-second debounce.

Clicking a timestamp in the list seeks the video:

```js
playerRef.current.seekTo(ts.time_seconds, 'seconds')
```

Editing a timestamp note calls `api.updateTimestamp(id, { notes })` which runs `UPDATE timestamps SET notes=? WHERE id=?`.

**Keyboard shortcuts:**

On load, keybinds are fetched and stored in a ref (not state — they don't need to trigger re-renders). A `keydown` listener is added:

```js
useEffect(() => {
  function handleKeyDown(e) {
    // Don't fire shortcuts when typing in a text field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
    const bind = keybindsRef.current.find(k => k.key === e.key)
    if (bind) handleTag({ label: bind.tag_label, color: bind.tag_color })
  }
  window.addEventListener('keydown', handleKeyDown)
  return () => window.removeEventListener('keydown', handleKeyDown)
}, [])
```

The `e.target.tagName` check prevents shortcuts from firing when you're typing in a form field.

**Forms in the workspace:**

Each form tab fetches the form schema and the existing response for this review:

```js
const form = await api.getForm(formId)
const formResponse = await api.getFormResponse(reviewId, formId)
const responses = JSON.parse(formResponse?.responses || '{}')
```

Every field renders from the schema `elements` array. On change, the entire `responses` object is updated:

```js
function handleFieldChange(elementId, value) {
  const updated = { ...responses, [elementId]: value }
  setResponses(updated)
  api.saveFormResponse(reviewId, { form_id: formId, responses: updated })
}
```

This is an upsert: `INSERT INTO form_responses ... ON CONFLICT DO UPDATE SET responses=?`. The whole response object is overwritten each time — simpler than tracking individual field changes.

**Submitting:**

Clicking Submit opens a notes modal. On confirm:

```js
await api.submitReview(reviewId, { notes })
// UPDATE reviews SET status='submitted', notes=?, submitted_at=datetime('now') WHERE id=?
navigate(-1)  // go back to the previous page
```

`navigate(-1)` is React Router's equivalent of the browser Back button.

**Popping the workspace into its own window:**

The forms/instructions/timestamp workspace can be detached into a second window so a coder can put the video on one monitor and the forms on another. The review page calls `window:openWorkspace` with a `#/workspace/<reviewId>` URL; `electron/main.js` opens a new `BrowserWindow` (tracked in a `workspaceWindows` map keyed by review id, so re-opening focuses the existing one instead of spawning duplicates). The two windows stay in step through one-way IPC events — `review:notifyUpdate` tells the other window to reload, and `workspace:closed` tells the review window the pop-out went away.

---

### Workspace Page (`src/pages/WorkspacePage.jsx`)

**What it shows:** The detached workspace — the same tabbed forms, instructions, and timestamp logger that can appear beside the player, rendered in its own window for `/workspace/:reviewId`.

The important detail is *where its form definitions come from*. Instead of fetching the current forms, it hydrates from the review's **`workspace_snapshot`** (`hydrateWorkspaceSnapshot`): the media type, tags, workspace tabs, and full form schemas exactly as they were when the review began. This is the user-facing payoff of the snapshot system in Part 5 — a coder always sees and answers the instrument as it existed for *their* review, even if the PI has since edited the form. Form answers still save through the normal `form_responses` upsert, and the page validates required fields before allowing submit.

---

## Part 5: The Sync System

All sync logic lives in `electron/sync.js`. It's the most complex file in the app.

### The Problem It Solves

Multiple coders on different computers need to:
1. Share project structure (encounters, forms, media types) — defined by the PI
2. Share their individual review data — each coder's work is their own
3. Handle deletions — if a review is deleted on one machine, it should disappear on others

The constraints are:
- Machines may be offline for hours or days
- No central server — communication is only via files in a shared folder
- No machine should be able to accidentally overwrite another's reviews

### The File Layout (protocol v3)

The sync system was rewritten. The oldest design split data across many independent files (`project-config.json`, a `reviews/<uuid>.json` per machine, `deleted-reviews.json`) and used a `config_version` counter to decide who won. Protocol v2 replaced that with one monolithic project snapshot. Protocol v3 keeps the stable part of that idea — one canonical index/comparison surface — but moves large payloads out of the index:

```
sync-folder/
  project-state.json     ← canonical compact index: structure + entity hashes/paths + tombstones
  manifest.json          ← { protocol_version, config_version, fingerprint }
  reviews/
    <review_sync_id>.json
  form-versions/
    <form_sync_id>-vN.json
  media-type-versions/
    <media_type_sync_id>-vN.json
  reviews-export.xlsx     (no longer written automatically — see Part 4)
```

`project-state.json` holds the project structure, tombstones, and an index of split payloads with hashes. Reviews and version payloads are separate files, but they are not independent sources of truth: their hashes and paths ride in the index, and sync hydrates them back into the same per-entity merge pipeline before applying changes. Existing protocol-v2 monolithic folders are still accepted and republished as protocol v3 on the next sync.

Each machine still has a UUID (`user_uuid` in `app-settings.json`, created once on first launch). But a machine no longer "owns" a file — every machine publishes the full merged state whenever its local content differs from the folder. There is no `isOwner` / owner-gating anymore; the old concept was removed.

### Fingerprint-Driven, Per-Entity Merge (last-writer-wins)

Sync is **bidirectional** and merges **per entity**, not per file. Two ideas drive it:

1. **Fingerprint** — `projectStateFingerprint()` hashes the meaningful content of the compact index, including split payload hashes, ignoring row order. On each sync the local fingerprint is compared to the folder's `manifest.json` fingerprint. If they match, there is nothing to do and the sync is essentially free. If they differ, a merge runs and the result is written back.

2. **Per-entity clocks** — every structural row carries a `sync_id` and an `updated_at` modification clock; every review carries a `review_sync_id`. When the same entity exists on both sides, the one with the newer `updated_at` wins (**last-writer-wins**). Different entities added on different machines both survive — a merge never drops an entity just because the other side hasn't seen it yet.

`config_version` still exists in the manifest but is **legacy back-compat only**. It does *not* gate which side wins. Don't write new logic that uses it to decide a merge.

### `applyStructure` and its two modes

Structure merging goes through `applyStructure`, which has two modes and **neither ever prunes**:

- `merge: true` — last-writer-wins by `updated_at`. This is the automatic sync path.
- `merge: false` — authoritative replace, used for manual import/join flows.

Crucially, **absence is never deletion.** If an entity is missing from the incoming snapshot, `applyStructure` leaves the local copy alone. The only way a structural deletion propagates is a tombstone (next section).

### Tombstones — the only way deletions travel

- **Structural entities** (encounter, media file, form, instruction, media type): deleting one records a row in `deleted_structure` via `recordStructureTombstone(db, projectId, kind, id)` *before* the row is removed. That tombstone rides along in `project-state.json`; peers that see it delete their local copy. If you ever add a new delete path for a structural entity and forget the tombstone, the deletion silently won't sync.
- **Reviews**: soft-delete only. `deleted_at` is set and the row is **kept** (so it can still be inspected/restored). The soft-deleted review travels in its split review payload, indexed by `project-state.json`, and the LWW clock resolves restore-vs-delete races. The legacy `deleted_reviews` table is still written but not consulted in the v3 path.

### Reviews carry their snapshot

Because forms and media types are versioned, a review payload carries the `workspace_snapshot` and per-response `form_snapshot` captured when it was filled. For sync-size reasons, protocol v3 can compact form schemas in those snapshots to `form_sync_id + version` references when the matching form-version payload is present. On merge, the payload is expanded and `localizeWorkspaceSnapshot` (in `services/snapshots.js`) rewrites embedded form/instruction ids from the sender's local ids to the receiver's local ids (matching by `sync_id`, falling back to name), so the snapshot stays meaningful on every machine.

### Connectivity and auto-sync cadence

- **Local-folder sync** (`doLocalSync` → `syncProjectStateLocal`) has no network check — it reads/writes files in the shared folder directly.
- **Cloud sync** (`doCloudSync` → `syncProjectStateCloud`) checks `net.isOnline()` first. If offline, it emits `sync:offline` once and returns; the periodic pass retries, and when connectivity returns it emits `sync:online`. (See Part 6 for the cloud adapters.)
- **Auto-sync triggers**: `scheduleSync(projectId)` runs ~2s after a structural change (debounced — rapid changes coalesce into one sync). `scheduleSyncForReview(reviewId)` is the review-save variant (walks review → media → encounter → project to find the project id; no `config_version` bump). `startPeriodicAutoSync` runs a pass every 5 minutes plus a ~15s startup pass to catch changes made while the app was closed.

### Auto-Sync Debouncing

```js
const timers = {}

function scheduleSync(projectId) {
  if (timers[projectId]) clearTimeout(timers[projectId])
  timers[projectId] = setTimeout(async () => {
    // run doLocalSync or doCloudSync
  }, 2000)
}
```

`clearTimeout` cancels any pending timer for this project. Each call resets the 2-second countdown. If you submit a review and then immediately add a timestamp (within 2 seconds), only one sync happens. The `timers` object is a module-level variable — it persists as long as the app is running.

`scheduleSyncForReview(reviewId)` walks up the foreign key chain to find the project:

```js
const rev = db.prepare('SELECT media_file_id FROM reviews WHERE id=?').get(reviewId)
const mf = db.prepare('SELECT encounter_id FROM media_files WHERE id=?').get(rev.media_file_id)
const enc = db.prepare('SELECT project_id FROM encounters WHERE id=?').get(mf.encounter_id)
scheduleSync(enc.project_id)
```

Three queries to get from review → project, but they're all indexed primary-key lookups and take microseconds.

### Versioning, Snapshots, and Structure Migration

Research instruments evolve — a PI tweaks a form's wording, adds a question, or changes a media type's tags weeks into a study. Three mechanisms keep that from corrupting data already collected. The first two live in `electron/services/`; all three are exercised by tests in `test/sync.test.js`.

**1. Version history (`services/structure.js`).** Editing a form bumps `forms.schema_version`; editing a media type bumps `media_types.config_version`. Just before the live row is overwritten, the *prior* state is copied into `form_versions` / `media_type_versions` (`captureFormVersion` / `captureMediaTypeVersion`, using `INSERT OR IGNORE` so re-running is safe). The Setup UI can list this history (`setup:listVersionHistory`) and restore any prior version — restoring writes the old content back as a *new* latest version (it never rewrites history). Deleting a form or media type that has data sets `archived_at` instead of hard-deleting, so existing responses keep a valid reference.

**2. Review-time snapshots (`services/snapshots.js`).** When a coder opens a media file to review, `buildWorkspaceSnapshot` captures the exact instrument they will see — the media type, its tags, its workspace tabs, and the full JSON schema of every form on those tabs — into `reviews.workspace_snapshot`. Each saved form response also stores the form's schema at answer time in `form_responses.form_snapshot`. This is why a later edit to a form never changes what an in-progress or submitted review shows, and why the Excel export can keep old question labels and never drop answers to questions that were since removed (see Part 4). `WorkspacePage` renders directly from the snapshot rather than from the current form definitions.

**3. Opt-in structure migration.** Sometimes you *do* want existing reviews re-aligned to the current structure (e.g. you fixed a typo and want everyone's drafts to pick it up). This is deliberate, never automatic. `setup:previewStructureMigration` reports how many reviews match a given form/media type (split into drafts vs. submitted) by comparing snapshots and responses; `setup:migrateStructureReviews` then rewrites those reviews' snapshots to the current version inside a transaction. Submitted reviews are left untouched unless the scope explicitly includes them. Nothing here runs on a normal save — editing a form does not retroactively touch any review.

> All three `setup:*` channels above are registered in `electron/ipc/projects.js` (there is no separate `setup.js`), validated in `electron/ipc/contracts.js`, exposed in `preload.js`, and mocked in `src/lib/api.js` — the standard four-touch path for any IPC method.

---

## Part 6: Cloud Integration

### OneDrive (`electron/cloud/onedrive.js`)

Uses the **Microsoft Graph API** with a **PKCE OAuth 2.0 flow**. PKCE (Proof Key for Code Exchange) was designed for desktop and mobile apps where storing a client secret is unsafe (anyone could decompile the app and extract it). With PKCE, the app proves its identity with a cryptographic challenge instead:

```js
// 1. Generate random secret and its hash
const codeVerifier = crypto.randomBytes(32).toString('base64url')
const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')

// 2. Open browser with the challenge
const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?
  client_id=${CLIENT_ID}&
  code_challenge=${codeChallenge}&
  code_challenge_method=S256&
  ...`
shell.openExternal(authUrl)

// 3. Start local server to catch the redirect
const server = http.createServer((req, res) => {
  const code = new URL(req.url, 'http://localhost').searchParams.get('code')
  // Exchange code + verifier for tokens
})
server.listen(3877)

// 4. Exchange: send code + verifier to Microsoft
const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
  method: 'POST',
  body: new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,  // proves we originated the request
    redirect_uri: 'http://localhost:3877',
  })
})
const { access_token, refresh_token } = await response.json()
```

Microsoft verifies that the `code_verifier` hashes to the `code_challenge` sent in step 2. Since only the original app knows the verifier, this proves identity without a secret.

**Tokens** are stored in `app-settings.json` (not the database). Access tokens expire after 1 hour. When an API call returns 401 (unauthorized), the refresh token is used to get a new access token:

```js
async function refreshTokens() {
  const settings = getSettings()
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: settings.onedrive_tokens.refresh_token,
    })
  })
  const tokens = await response.json()
  saveSettings({ onedrive_tokens: tokens })
  return tokens.access_token
}
```

**API calls** all go through a shared `graphRequest` function that handles auth headers and automatic token refresh on 401:

```js
async function graphRequest(url, options = {}, retry = true) {
  const settings = getSettings()
  const token = settings.onedrive_tokens?.access_token
  const res = await fetch(url, {
    ...options,
    headers: { 'Authorization': `Bearer ${token}`, ...options.headers }
  })
  if (res.status === 401 && retry) {
    const newToken = await refreshTokens()
    return graphRequest(url, options, false)  // retry once with new token
  }
  return res
}
```

Files are addressed by drive ID + item ID. The root folder is identified by `cloud_folder_id` (stored in `projects`). Subfolders and files are found by listing children:

```js
async function listFiles(folderId) {
  const res = await graphRequest(`${DRIVE_BASE}/items/${folderId}/children?$select=id,name,size`)
  const data = await res.json()
  return data.value.map(f => ({ id: f.id, name: f.name }))
}

async function writeFile(folderId, filename, content) {
  const res = await graphRequest(
    `${DRIVE_BASE}/items/${folderId}:/${encodeURIComponent(filename)}:/content`,
    { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: content }
  )
}
```

`ensureFolder` creates a subfolder if it doesn't exist, using `conflictBehavior: 'fail'` so it doesn't accidentally create duplicates:

```js
async function ensureFolder(parentId, name) {
  const children = await listFiles(parentId)
  const existing = children.find(f => f.name === name)
  if (existing) return existing.id

  const res = await graphRequest(`${DRIVE_BASE}/items/${parentId}/children`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })
  })
  const data = await res.json()
  return data.id
}
```

### Google Drive (`electron/cloud/googledrive.js`)

Very similar structure but uses **OAuth2 with a client secret** (the installed-app flow). For Google, using a client secret in a desktop app is documented and accepted — Google understands that the secret in a distributed binary isn't truly secret, but it still narrows the attack surface.

The key difference from OneDrive: Google Drive doesn't use paths. Everything is addressed by file ID. Finding a file by name requires querying:

```js
async function findFile(parentId, name) {
  const q = encodeURIComponent(`'${parentId}' in parents and name='${name}' and trashed=false`)
  const res = await driveRequest(`${DRIVE_BASE}/files?q=${q}&fields=files(id,name)`)
  const data = await res.json()
  return data.files?.[0] || null
}
```

Creating a file uses multipart upload (metadata + content in one request):

```js
async function writeFile(folderId, filename, content) {
  const existing = await findFile(folderId, filename)
  if (existing) {
    // Update existing file
    await driveRequest(`${UPLOAD_BASE}/files/${existing.id}?uploadType=media`, {
      method: 'PATCH', body: content
    })
  } else {
    // Create new file with metadata
    const metadata = JSON.stringify({ name: filename, parents: [folderId] })
    const boundary = '-------SDMoBoundary'
    const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--`
    await driveRequest(`${UPLOAD_BASE}/files?uploadType=multipart`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    })
  }
}
```

### The Adapter Pattern (`electron/cloud/cloudSync.js`)

Both providers expose the same interface: `listFiles(folderId)`, `readFile(fileId)`, `writeFile(folderId, name, content)`, `ensureFolder(parentId, name)`.

```js
function getAdapter(provider) {
  if (provider === 'onedrive') return require('./onedrive')
  if (provider === 'googledrive') return require('./googledrive')
  throw new Error(`Unknown provider: ${provider}`)
}
module.exports = { getAdapter }
```

`doCloudSync` in `sync.js` uses only these four methods — it doesn't know or care whether it's talking to OneDrive or Google Drive. Adding a new cloud provider in the future means implementing these four functions and adding a case to `getAdapter`.

---

## Part 7: Settings Storage (`electron/settings.js`)

`app-settings.json` lives in the app's data folder alongside `sdmo.db`. It stores machine-wide, non-database settings:

```json
{
  "reviewer_name": "Nihanth",
  "user_uuid": "a1b2c3d4-...",
  "project_names": { "1": "Nihanth", "3": "Dr. Pinnaka" },
  "onedrive_tokens": { "access_token": "...", "refresh_token": "..." },
  "onedrive_email": "nihanth@example.com",
  "googledrive_tokens": { "access_token": "...", "refresh_token": "..." }
}
```

`project_names` is a map from project ID to the reviewer name used on this machine for that project. Different projects can have different display names (e.g. you're "Nihanth" in one study and "Dr. Pinnaka" in another).

`user_uuid` is generated once with `crypto.randomUUID()` and never changes. It's the machine's identity for review file naming and reviewer UUID matching.

`getOrCreateUUID()` reads this UUID and creates it if it doesn't exist:

```js
function getOrCreateUUID() {
  const settings = getSettings()
  if (!settings.user_uuid) {
    settings.user_uuid = crypto.randomUUID()
    saveSettings(settings)
  }
  return settings.user_uuid
}
```

Settings are read and written synchronously using `fs.readFileSync` / `fs.writeFileSync`. There's no concurrency issue because the main process is single-threaded and settings calls are fast (tiny file, no parsing overhead worth worrying about).

---

## Part 8: The Build System

### Vite — Development and Bundling

Vite handles the React side. In development (`npm run dev`), Vite starts a local server at `localhost:5173` with **hot module replacement (HMR)** — when you save a React file, only the changed module is replaced in the running browser without a full page reload. State is often preserved. This makes iteration extremely fast.

`npm run dev` uses `concurrently` to run both Vite and Electron simultaneously, and `wait-on` to delay Electron startup until Vite is serving:

```json
"dev": "concurrently \"npm run vite\" \"wait-on http://localhost:5173 && electron .\""
```

For production (`npm run build`), Vite bundles all React code into static files in `dist/`:
- `dist/index.html` — the entry point
- `dist/assets/index-[hash].js` — all JavaScript, minified and bundled
- `dist/assets/index-[hash].css` — all CSS

The hash in the filename is based on the content — if nothing changed, the hash doesn't change, and browsers can cache aggressively.

### Electron Builder — Packaging

`electron-builder` packages the app into platform-specific installers. Its config lives in the `build` key of `package.json`.

The key challenge is `better-sqlite3` — it's a **native module**, meaning it contains compiled C++ code (`.node` file) that must be compiled for the exact version of Electron and operating system being targeted. `@electron/rebuild` handles this:

```json
"postinstall": "electron-rebuild -f -w better-sqlite3"
```

This runs automatically after `npm install`. It downloads the correct Electron headers and recompiles `better-sqlite3` specifically for the Electron version in use. Without this, the module won't load.

The built native module is listed in `asarUnpack`:

```json
"asarUnpack": [
  "node_modules/better-sqlite3/**/*",
  "node_modules/bindings/**/*",
  "node_modules/file-uri-to-path/**/*"
]
```

An **asar** file is Electron's equivalent of a zip — all app files are bundled into a single `app.asar` archive for efficiency. But native modules (`.node` files) cannot be `require()`d from inside a zip because the OS's dynamic linker needs to load them from a real filesystem path. `asarUnpack` copies these files outside the asar archive while keeping everything else bundled.

`app.setName('SDMo')` in `main.js` sets the app name for data directory purposes. Without this, the dev app uses `sdmo-app` as the data folder name (from `package.json`'s `name` field), but the packaged app uses `SDMo`. This keeps dev and production data completely separate.

### GitHub Actions — Automated Builds

`.github/workflows/build.yml` defines a CI pipeline triggered by pushing a version tag (`v0.1.0`, `v1.0.0`, etc.) or manually via the GitHub UI.

The pipeline runs three jobs in parallel, each on a different virtual machine:

```yaml
strategy:
  matrix:
    include:
      - os: macos-latest   # arm64 Mac runner
        platform: mac
      - os: windows-latest # x64 Windows runner
        platform: win
      - os: ubuntu-latest  # x64 Linux runner
        platform: linux
```

Each job:
1. Checks out the code
2. Installs Node.js 20
3. Runs `npm ci --ignore-scripts` (clean install, skipping postinstall scripts — which would try to run `electron-rebuild` before Electron is properly set up)
4. **Writes `credentials.js`** from GitHub repository secrets (encrypted values set in repo settings, never in source code)
5. Runs `npx electron-rebuild` explicitly to compile `better-sqlite3` for Electron
6. Runs `npm run build` (Vite build)
7. Runs `electron-builder` for the platform
8. Uploads the artifact (`.dmg`, `.exe`, or `.AppImage`)

The `release` job runs after all three build jobs finish. It downloads all artifacts and creates a GitHub Release with them attached.

`GITHUB_TOKEN` is automatically provided by GitHub Actions with `contents: write` permission (added to the job), allowing electron-builder to create the Release and upload files to it.

---

## Part 9: Key Design Decisions and Why

**Why a `project-state.json` index plus split payload files?**
The original design split data into a config file, a per-machine reviews file, and a deletions file, with a `config_version` counter deciding who won. It worked but was fragile: the counter could gate the wrong side, "who owns this" was ambiguous, and adding an entity on two machines at once could silently lose one. Protocol v2 fixed that with a single snapshot merged **per entity** by `sync_id` + `updated_at` (last-writer-wins). Protocol v3 keeps the same coordinated merge model but makes `project-state.json` a compact index containing hashes/paths for large payloads. Different entities added on different machines all survive; the merge never infers deletion from absence; and one large review/form no longer bloats the central comparison file.

**Why soft-delete reviews and use tombstones for structure?**
If you hard-delete a row and then sync, other machines still have it — and there's no way to distinguish "deleted" from "not synced yet." Reviews are soft-deleted (`deleted_at` set, row kept) so the deletion travels inside the snapshot and can even be undone. Structural deletions record a `deleted_structure` tombstone, which is the *only* signal that propagates them — `applyStructure` never prunes, so without the tombstone the item would just reappear from a peer.

**Why store form responses as a single JSON blob instead of one row per field?**
Forms change over time — fields get added, removed, reordered. A row-per-field schema would need complex migrations and risk orphaned rows. A JSON blob keyed by field UUID accommodates any schema change without schema migration: missing keys are treated as no answer, extra keys are ignored.

**Why use `review_sync_id` in addition to `reviewer_uuid`?**
`reviewer_uuid` identifies the machine, not the review. One machine can have multiple reviews for the same media file (e.g. a reviewer re-did a review after un-submitting). `review_sync_id` is a UUID for the specific review row, making sync matching and deletion precise regardless of how many reviews exist per reviewer per file.

**Why a tiny `manifest.json` next to the snapshot?**
`manifest.json` is a few bytes and carries the content **fingerprint**; comparing fingerprints first lets a sync (or a poll) cheaply decide whether anything actually changed before reading the compact index or split payload files. It's the same idea as a CDN's `ETag`.

**Why snapshot the instrument at review time, and version forms/media types?**
Studies run for months and PIs revise forms mid-stream. If reviews referenced only the *live* form, an edit would retroactively change what past reviews appear to have asked — corrupting the record. Instead, each review captures a `workspace_snapshot`/`form_snapshot` of the exact instrument it was filled with, and every edit is preserved in `form_versions`/`media_type_versions`. Coders always see their own version, the Excel export keeps original labels and never drops removed questions, and re-aligning old reviews to a new version is an explicit, opt-in migration rather than a side effect of saving.

**Why serve video over a local HTTP server but documents over `localfile://`?**
Both need HTTP **range requests** so the player can seek without downloading the whole file. For video/audio the app runs a small local HTTP server (`mediaServer.js`) that implements ranges correctly and is easy to reason about for large files. PDFs and other documents use the `localfile://` custom protocol (`protocol.registerFileProtocol`), which also supports ranges through Chromium's native file handler. The newer `protocol.handle` + `net.fetch` API is deliberately avoided — it streams through Node and breaks range support.
