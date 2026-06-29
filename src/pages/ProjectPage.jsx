import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import {
  ChevronLeft, Settings, Filter, ChevronDown, ChevronRight,
  Video, FileText, File, Plus, CheckCircle2, Circle,
  Search, X, Play, RefreshCw, Share2, FolderDown, AlertTriangle, Cloud, User,
  LayoutList, BarChart2, Activity, LineChart, HelpCircle
} from 'lucide-react'
import { api, formatDate } from '../lib/api'
import { SETUP_SECTIONS } from '../lib/setupSections'
import Modal from '../components/ui/Modal'
import NewReviewModal from '../components/encounters/NewReviewModal'
import FilterPanel from '../components/encounters/FilterPanel'
import useTour from '../components/ui/useTour'

const PAGE_SIZE = 15

const PROJECT_TOUR_STEPS = [
  {
    targetId: 'tut-proj-nav',
    placement: 'right',
    title: 'Your Project',
    body: 'Welcome to your project. Encounters are listed in the main area. Use this sidebar to switch between Encounters, Progress, and Activity views. Settings live at the bottom.',
  },
  {
    targetId: 'tut-proj-encounters',
    placement: 'bottom',
    title: 'Encounters',
    body: 'Each encounter represents one patient or session. Click any encounter card to expand it and see its media files. Sync shares the project structure and coding data; actual video files stay on each coder\'s computer.',
  },
  {
    targetId: 'tut-proj-mediatype',
    placement: 'bottom',
    title: 'Media Types',
    body: 'This badge shows the media type — a template that defines which forms and timestamp tags are available during review. You set up media types in Settings.',
  },
  {
    targetId: 'tut-proj-addreview',
    placement: 'top',
    title: 'Add Review',
    body: 'Click "Add review" to start coding this media file. You\'ll be taken to the review page where you can watch the video, log timestamps, and fill out the coding form.',
  },
  {
    targetId: 'tut-proj-health',
    placement: 'bottom',
    title: 'Unlinked Files',
    body: "This warning is local to this machine. The sample links the first video so you can try reviewing right away; the other sample slots stay unlinked so you can practice Auto-link or manual Link without changing teammates' file paths.",
  },
  {
    targetId: 'tut-proj-autolink',
    placement: 'bottom',
    title: 'Auto-link Files',
    body: 'Have all your videos in one folder? Auto-link scans it (and subfolders) and links every file whose name matches a slot in the project — no manual locating needed. Each teammate does this once on their own machine.',
  },
  {
    targetId: 'tut-proj-sync',
    placement: 'bottom',
    title: 'Sync',
    body: "Sync Now pushes your latest reviews and setup changes, then pulls your teammates' latest work. Use Settings → Sync to choose OneDrive, Google Drive, or a shared local folder. Media files are still linked separately on each machine.",
  },
  {
    targetId: 'tut-proj-export',
    placement: 'bottom',
    title: 'Exporting Data',
    body: 'Export all reviews and timestamps to Excel at any time — organized by media type, one row per review. Snapshots preserve the exact form version each review was coded against.',
  },
]
const MEDIA_ICONS = { video: Video, document: FileText, other: File }

const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316']
function colorFor(name) { let h = 0; for (const c of (name || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffff; return COLORS[h % COLORS.length] }
function sampleProjectTourKey(projectId) { return `sdmo_sample_project_tour_started_v1:${projectId}` }

export default function ProjectPage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [project, setProject] = useState(null)
  const [encounters, setEncounters] = useState([])
  const [mediaTypes, setMediaTypes] = useState([])
  const [expanded, setExpanded] = useState({})
  const [loading, setLoading] = useState(true)
  const [newReview, setNewReview] = useState(null)
  const [deleteReviewTarget, setDeleteReviewTarget] = useState(null) // { id, reviewer_name }
  const [showFilter, setShowFilter] = useState(false)
  const [filters, setFilters] = useState({})
  const [search, setSearch] = useState('')
  const [syncStatus, setSyncStatus] = useState({ syncMode: 'none', syncFolder: null, lastSyncAt: null })
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState(null)
  const [toast, setToast] = useState(null) // { message, isError }
  const [pendingConfigData, setPendingConfigData] = useState(null)
  const [acceptingConfig, setAcceptingConfig] = useState(false)
  const [reviewerName, setReviewerName] = useState(null)
  const [showNameModal, setShowNameModal] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [mediaHealth, setMediaHealth] = useState(null)
  const [activePage, setActivePage] = useState('encounters')
  const [currentPage, setCurrentPage] = useState(1)
  const [autolinking, setAutolinking] = useState(false)
  const [linkSaving, setLinkSaving] = useState(null)
  const [showAutolinkModal, setShowAutolinkModal] = useState(false)
  const [autolinkFolder, setAutolinkFolder] = useState('')
  const [autolinkResult, setAutolinkResult] = useState(null)
  const [syncOffline, setSyncOffline] = useState(false)
  const [sampleTourStarted, setSampleTourStarted] = useState(false)
  const query = new URLSearchParams(location.search)
  const isSampleTour = query.get('sampleTour') === '1'
  const sampleReviewId = query.get('sampleReviewId')
  const tour = useTour(PROJECT_TOUR_STEPS, 'sdmo_tour_project_v1', {
    ready: !loading && encounters.length > 0,
    onStart: useCallback(() => {
      // Expand the first encounter so media-type and add-review anchors are in the DOM.
      if (encounters[0]) setExpanded(e => ({ ...e, [encounters[0].id]: true }))
    }, [encounters]),
    onComplete: () => {
      if (isSampleTour && sampleReviewId) navigate(`/review/${sampleReviewId}?sampleTour=1`)
    },
  })

  useEffect(() => { load() }, [projectId, location.pathname])

  useEffect(() => {
    if (!isSampleTour || sampleTourStarted || loading || encounters.length === 0) return
    const key = sampleProjectTourKey(projectId)
    if (localStorage.getItem(key)) {
      setSampleTourStarted(true)
      return
    }
    localStorage.setItem(key, '1')
    setSampleTourStarted(true)
    tour.start()
  }, [isSampleTour, sampleTourStarted, loading, encounters.length, projectId, tour])

  // Periodic refresh every 15s — checks manifest.json first (tiny file),
  // only downloads full config if version changed
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const manifest = await api.checkManifest(projectId)
        if (manifest && manifest.config_version > manifest.local_version) {
          await api.fetchProjectStructure(projectId)
          const encs = await api.listEncounters(projectId)
          setEncounters(encs)
        }
      } catch {}
    }, 15000)
    return () => clearInterval(interval)
  }, [projectId])

  useEffect(() => {
    const handler = (data) => {
      if (String(data.projectId) === String(projectId)) setPendingConfigData(data.configData)
    }
    const subId = api.onConfigUpdateAvailable(handler)
    return () => api.offConfigUpdateAvailable(subId)
  }, [projectId])

  // A structural edit collided with another machine's during sync. LWW already
  // picked a winner deterministically; just let the user know and refresh.
  useEffect(() => {
    const handler = (data) => {
      if (!data?.message) return
      showToast(data.message, true)
      load()
    }
    const subId = api.onSyncConflict(handler)
    return () => api.offSyncConflict(subId)
  }, [projectId])

  useEffect(() => {
    const handler = (data) => {
      if (String(data?.projectId) !== String(projectId)) return
      setSyncOffline(true)
    }
    const subId = api.onSyncOffline(handler)
    return () => api.offSyncOffline(subId)
  }, [projectId])

  useEffect(() => {
    const handler = (data) => {
      if (String(data?.projectId) !== String(projectId)) return
      setSyncOffline(false)
      showToast('Internet restored — back online and syncing.')
      api.getSyncStatus(projectId).then(setSyncStatus)
    }
    const subId = api.onSyncOnline(handler)
    return () => api.offSyncOnline(subId)
  }, [projectId])

  async function load() {
    setLoading(true)
    const [proj, encs, types, status, name] = await Promise.all([
      api.getProject(projectId),
      api.listEncounters(projectId),
      api.listMediaTypes(projectId),
      api.getSyncStatus(projectId),
      api.getProjectName(projectId),
    ])
    setProject(proj)
    setEncounters(encs)
    setMediaTypes(types)
    setSyncStatus(status)
    setReviewerName(name || '')
    setLoading(false)
    refreshMediaHealth()
    refreshProjectStructure()
    // Auto-sync on open if sync is configured
    if (status.syncMode === 'local' || status.syncMode === 'cloud') {
      const syncFn = status.syncMode === 'cloud'
        ? () => api.cloudSyncNow(projectId)
        : () => api.syncNow(projectId)
      syncFn().then(() => api.getSyncStatus(projectId).then(setSyncStatus))
    }
  }

  async function refreshMediaHealth() {
    try {
      setMediaHealth(await api.mediaHealthCheck(projectId))
    } catch {}
  }

  async function refreshProjectStructure() {
    try {
      await api.fetchProjectStructure(projectId)
      const [encs, types] = await Promise.all([
        api.listEncounters(projectId),
        api.listMediaTypes(projectId),
      ])
      setEncounters(encs)
      setMediaTypes(types)
    } catch {}
  }

  async function handleSaveReviewerName() {
    const trimmed = nameInput.trim()
    if (!trimmed) return
    await api.setProjectName(projectId, trimmed)
    setReviewerName(trimmed)
    setShowNameModal(false)
  }

  function showToast(message, isError = false) {
    setToast({ message, isError })
    setTimeout(() => setToast(null), 4000)
  }

  async function handleDeleteReview() {
    if (!deleteReviewTarget) return
    await api.deleteReview(deleteReviewTarget.id)
    setDeleteReviewTarget(null)
    const encs = await api.listEncounters(projectId)
    setEncounters(encs)
  }

  async function handleSyncNow() {
    setSyncing(true)
    // Pull latest structure from cloud first, then run full sync
    try { await api.fetchProjectStructure(projectId) } catch {}
    const result = syncStatus.syncMode === 'cloud'
      ? await api.cloudSyncNow(projectId)
      : await api.syncNow(projectId)
    setSyncing(false)
    if (result.error) { setSyncError(result.error); return }
    setSyncError(null)
    const [status, encs] = await Promise.all([
      api.getSyncStatus(projectId),
      api.listEncounters(projectId),
    ])
    setSyncStatus(status)
    setEncounters(encs)
  }

  async function handleAcceptConfigUpdate() {
    if (!pendingConfigData) return
    setAcceptingConfig(true)
    await api.syncAcceptConfigUpdate(Number(projectId), pendingConfigData)
    setPendingConfigData(null)
    setAcceptingConfig(false)
    load()
  }

  function formatSyncAge(ts) {
    if (!ts) return null
    const secs = Math.floor((Date.now() - ts) / 1000)
    if (secs < 60) return 'just now'
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    return `${Math.floor(secs / 3600)}h ago`
  }

  function toggle(encId) {
    setExpanded(e => ({ ...e, [encId]: !e[encId] }))
  }

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
    if (filters.mediaType) result = result.filter(e => e.media?.some(m => m.media_type_id == filters.mediaType))
    return result
  }

  const filtered = useMemo(() => applyFilters(encounters), [encounters, filters, search])

  useEffect(() => setCurrentPage(1), [search, filters])

  async function handleOpenAutolinkModal() {
    const folder = await api.getBaseFolder(projectId)
    setAutolinkFolder(folder || '')
    setAutolinkResult(null)
    setShowAutolinkModal(true)
  }

  async function handleRunAutolink() {
    if (autolinkFolder) await api.setBaseFolder(Number(projectId), autolinkFolder)
    setAutolinking(true)
    const result = await api.autolink(projectId)
    setAutolinking(false)
    setAutolinkResult(result)
    const [encs, health] = await Promise.all([api.listEncounters(projectId), api.mediaHealthCheck(projectId)])
    setEncounters(encs)
    setMediaHealth(health)
  }

  async function handleManualLink(mediaFileId) {
    setLinkSaving(mediaFileId)
    const filePath = await api.browseMediaFile(mediaFileId)
    if (filePath) {
      await api.setMediaLink(mediaFileId, projectId, filePath)
      const [encs, health] = await Promise.all([api.listEncounters(projectId), api.mediaHealthCheck(projectId)])
      setEncounters(encs)
      setMediaHealth(health)
    }
    setLinkSaving(null)
  }

  async function handleMarkNA(mediaFileId) {
    await api.markMediaNotApplicable(mediaFileId)
    const [encs, health] = await Promise.all([api.listEncounters(projectId), api.mediaHealthCheck(projectId)])
    setEncounters(encs)
    setMediaHealth(health)
  }

  async function handleClearLink(mediaFileId) {
    await api.clearMediaLink(mediaFileId)
    const [encs, health] = await Promise.all([api.listEncounters(projectId), api.mediaHealthCheck(projectId)])
    setEncounters(encs)
    setMediaHealth(health)
  }

  async function handleSaveFile() {
    const p = await api.saveProjectFile(projectId)
    if (p) showToast(`File saved — share it with teammates.`)
  }

  async function handleLoadFile() {
    const result = await api.loadProjectFile(projectId)
    if (!result) return
    if (result.error) { showToast(`Import failed: ${result.error}`, true); return }
    const parts = []
    if (result.reviewsImported) parts.push(`${result.reviewsImported} new review${result.reviewsImported !== 1 ? 's' : ''}`)
    if (result.reviewsUpdated) parts.push(`${result.reviewsUpdated} updated`)
    if (result.formsAdded) parts.push(`${result.formsAdded} new form${result.formsAdded !== 1 ? 's' : ''}`)
    if (result.typesAdded) parts.push(`${result.typesAdded} new media type${result.typesAdded !== 1 ? 's' : ''}`)
    showToast(parts.length ? `Imported: ${parts.join(', ')}` : 'Nothing new to import.')
    load()
  }

  if (loading) return <div className="empty-state" style={{ height: '100vh' }}><div className="spinner" /></div>

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Top bar */}
      <div style={{
        height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 20px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        WebkitAppRegion: 'drag',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' }}>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => navigate('/')}>
            <ChevronLeft size={16} />
          </button>
          <span className="text-secondary text-sm">SDMo</span>
          <ChevronRight size={12} color="var(--text-muted)" />
          <span style={{ fontWeight: 600, fontSize: 14 }}>{project?.name}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', WebkitAppRegion: 'no-drag' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { setNameInput(reviewerName || ''); setShowNameModal(true) }}
            title="Change your reviewer name for this project"
            style={{ color: reviewerName ? 'var(--text-secondary)' : 'var(--danger)' }}
          >
            <User size={13} />
            {reviewerName || 'Set your name'}
          </button>
          {(syncStatus.syncMode === 'local' || syncStatus.syncMode === 'cloud') && (
            <button id="tut-proj-sync" className="btn btn-ghost btn-sm" onClick={handleSyncNow} disabled={syncing} title="Sync now">
              {syncStatus.syncMode === 'cloud' ? <Cloud size={13} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} /> : <RefreshCw size={13} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />}
              {syncing ? 'Syncing…' : 'Sync Now'}
              {syncStatus.lastSyncAt && !syncing && (
                <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 2 }}>· {formatSyncAge(syncStatus.lastSyncAt)}</span>
              )}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={handleLoadFile} title="Import project file (from email or shared folder)">
            <FolderDown size={13} /> Import File
          </button>
          <button className="btn btn-ghost btn-sm" onClick={handleSaveFile} title="Save project file to share with teammates">
            <Share2 size={13} /> Share File
          </button>
          <button id="tut-proj-export" className="btn btn-ghost btn-sm" onClick={() => api.exportExcel(projectId)} title="Export all reviews and timestamps to Excel">
            <FileText size={13} /> Export Excel
          </button>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={tour.start} title="Show tutorial">
            <HelpCircle size={15} />
          </button>
        </div>
      </div>

      {/* Toast notification */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: toast.isError ? 'var(--danger)' : '#1a1a1a',
          color: 'white', padding: '10px 18px', borderRadius: 8, fontSize: 13,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)', zIndex: 9999,
          display: 'flex', alignItems: 'center', gap: 8, maxWidth: 480,
        }}>
          {toast.message}
        </div>
      )}

      {/* Warning banners */}
      {syncOffline && syncStatus.syncMode === 'cloud' && (
        <div style={{ background: '#fff7ed', borderBottom: '1px solid #fed7aa', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#92400e' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
          No internet — working in local mode. Retrying every 5 minutes.
        </div>
      )}
      {syncError && (
        <div style={{ background: '#fef2f2', borderBottom: '1px solid #fecaca', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#b91c1c' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
          Sync failed: {syncError}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', color: '#b91c1c' }} onClick={() => setSyncError(null)}>
            <X size={12} />
          </button>
        </div>
      )}
      {syncStatus.syncMode === 'local' && syncStatus.syncFolderExists === false && (
        <div style={{ background: '#fff7ed', borderBottom: '1px solid #fed7aa', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#92400e' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
          Sync folder not found — check the path in <button className="btn btn-ghost btn-sm" style={{ color: '#92400e', textDecoration: 'underline', padding: '0 4px' }} onClick={() => navigate(`/project/${projectId}/setup?section=${SETUP_SECTIONS.SYNC}`)}>Setup → Sync</button>
        </div>
      )}
      {syncStatus.syncMode === 'cloud' && syncStatus.tokenExpired && (
        <div style={{ background: '#fff7ed', borderBottom: '1px solid #fed7aa', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#92400e' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
          Cloud connection expired — reconnect in <button className="btn btn-ghost btn-sm" style={{ color: '#92400e', textDecoration: 'underline', padding: '0 4px' }} onClick={() => navigate(`/project/${projectId}/setup?section=${SETUP_SECTIONS.SYNC}`)}>Setup → Sync</button>
        </div>
      )}
      {pendingConfigData && (
        <div style={{ background: '#eff6ff', borderBottom: '1px solid #bfdbfe', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#1d4ed8' }}>
          <RefreshCw size={14} style={{ flexShrink: 0 }} />
          <span>Project settings were updated by the project owner.</span>
          <button
            className="btn btn-primary btn-sm"
            style={{ marginLeft: 8 }}
            onClick={handleAcceptConfigUpdate}
            disabled={acceptingConfig}
          >
            {acceptingConfig ? 'Applying…' : 'Apply Updates'}
          </button>
        </div>
      )}

      {/* Main area: sidebar + content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Sidebar */}
        <div style={{
          width: 220, flexShrink: 0, borderRight: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-secondary)', overflowY: 'auto',
          userSelect: 'none',
        }}>
          {/* Project name header */}
          <div style={{ padding: '20px 14px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 4 }}>Project</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4, wordBreak: 'break-word' }}>{project?.name}</div>
          </div>

          {/* Nav items */}
          <div id="tut-proj-nav" style={{ padding: '2px 6px', display: 'flex', flexDirection: 'column', gap: 1 }}>
            {[
              { id: 'encounters', icon: LayoutList, label: 'Encounters' },
              { id: 'progress',   icon: BarChart2,  label: 'Progress' },
              { id: 'activity',   icon: Activity,   label: 'Activity' },
              { id: 'dataviz',    icon: LineChart,  label: 'Data Visualization' },
            ].map(({ id, icon: Icon, label }) => {
              const active = activePage === id
              return (
                <button key={id} onClick={() => setActivePage(id)}
                  className="btn btn-ghost btn-sm"
                  style={{
                    justifyContent: 'flex-start', width: '100%',
                    fontWeight: active ? 600 : 400,
                    color: active ? 'var(--text)' : 'var(--text-secondary)',
                    background: active ? 'var(--bg-hover, rgba(0,0,0,0.06))' : 'transparent',
                  }}>
                  <Icon size={13} />
                  {label}
                </button>
              )
            })}
          </div>

          {/* Bottom: Settings */}
          <div style={{ marginTop: 'auto', padding: '8px 6px', borderTop: '1px solid var(--border)' }}>
            <button onClick={() => navigate(`/project/${projectId}/setup`)}
              className="btn btn-ghost btn-sm"
              style={{ justifyContent: 'flex-start', width: '100%' }}>
              <Settings size={13} />
              Settings
            </button>
          </div>
        </div>

        {/* Content area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '32px 36px' }}>

          {/* Media health warning — shown on all views */}
          {mediaHealth && (mediaHealth.unlinked + mediaHealth.broken) > 0 && (
            <div id="tut-proj-health" style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '10px 14px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
              <AlertTriangle size={15} style={{ color: '#d97706', flexShrink: 0 }} />
              <span style={{ color: '#92400e', flex: 1 }}>
                {mediaHealth.unlinked + mediaHealth.broken} of {mediaHealth.total} media file{mediaHealth.total !== 1 ? 's' : ''} {mediaHealth.broken > 0 && mediaHealth.unlinked > 0 ? 'are not linked or missing' : mediaHealth.broken > 0 ? 'cannot be found on disk' : 'are not linked on this machine'}.
                {!mediaHealth.hasBaseFolder ? ' Set a base folder in Settings → Media Folder.' : ' Go to Settings → Media Folder to auto-link or manually locate files.'}
              </span>
              <button className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }} onClick={() => navigate(`/project/${projectId}/setup?section=${SETUP_SECTIONS.FILES}`)}>Fix</button>
            </div>
          )}

          {/* ── ENCOUNTERS ── */}
          {activePage === 'encounters' && (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
                <div id="tut-proj-encounters">
                  <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Encounters</h1>
                  <p className="text-secondary text-sm" style={{ marginTop: 3 }}>
                    {filtered.length} encounter{filtered.length !== 1 ? 's' : ''}{filtered.length !== encounters.length ? ` (filtered from ${encounters.length})` : ''} · {encounters.filter(e => e.completed).length} complete
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button id="tut-proj-autolink" className="btn btn-secondary btn-sm" onClick={handleOpenAutolinkModal} disabled={autolinking}>
                    <RefreshCw size={13} style={{ animation: autolinking ? 'spin 1s linear infinite' : 'none' }} />
                    {autolinking ? 'Linking…' : 'Auto-link Files'}
                  </button>
                  <div style={{ position: 'relative' }}>
                    <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                    <input placeholder="Search encounters…" value={search} onChange={e => setSearch(e.target.value)} style={{ paddingLeft: 28, width: 200, height: 32, fontSize: 13 }} />
                    {search && <button style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }} onClick={() => setSearch('')}><X size={12} color="var(--text-muted)" /></button>}
                  </div>
                  <button className={`btn btn-sm ${showFilter ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowFilter(s => !s)}>
                    <Filter size={13} /> Filter {Object.keys(filters).length > 0 && `(${Object.keys(filters).length})`}
                  </button>
                </div>
              </div>
              {showFilter && <FilterPanel filters={filters} setFilters={setFilters} mediaTypes={mediaTypes} onClose={() => setShowFilter(false)} />}
              {filtered.length === 0 ? (
                <div className="empty-state">
                  <FolderOpenIcon />
                  <p>No encounters found</p>
                  {encounters.length === 0 && <p className="text-sm">Add encounters in <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/project/${projectId}/setup?section=${SETUP_SECTIONS.ENCOUNTERS}`)}>Setup → Encounters</button></p>}
                </div>
              ) : (
                <>
                  <div id="tut-proj-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map(enc => (
                      <EncounterRow key={enc.id} encounter={enc} expanded={!!expanded[enc.id]} onToggle={() => toggle(enc.id)} mediaTypes={mediaTypes} onAddReview={(mf) => setNewReview({ mediaFile: mf })} onOpenReview={(reviewId) => navigate(`/review/${reviewId}`)} onDeleteReview={(r) => setDeleteReviewTarget(r)} onManualLink={handleManualLink} onMarkNA={handleMarkNA} onClearLink={handleClearLink} linkSaving={linkSaving} />
                    ))}
                  </div>
                  <Pagination currentPage={currentPage} totalPages={Math.ceil(filtered.length / PAGE_SIZE)} total={filtered.length} pageSize={PAGE_SIZE} onPageChange={setCurrentPage} />
                </>
              )}
            </>
          )}

          {/* ── PROGRESS ── */}
          {activePage === 'progress' && <ProgressView encounters={encounters} mediaTypes={mediaTypes} />}

          {/* ── ACTIVITY ── */}
          {activePage === 'activity' && <ActivityView encounters={encounters} />}

          {/* ── DATA VISUALIZATION ── */}
          {activePage === 'dataviz' && <DataVizView />}

        </div>
      </div>

      <Modal
        open={!!deleteReviewTarget}
        onClose={() => setDeleteReviewTarget(null)}
        title="Delete Review"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDeleteReviewTarget(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={handleDeleteReview}>Delete</button>
          </>
        }
      >
        <p>Delete the review by <strong>{deleteReviewTarget?.reviewer_name}</strong>? All timestamps and form responses in this review will be permanently removed.</p>
      </Modal>

      <Modal
        open={showAutolinkModal}
        onClose={() => { if (!autolinking) { setShowAutolinkModal(false); setAutolinkResult(null) } }}
        title="Auto-link Files"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => { setShowAutolinkModal(false); setAutolinkResult(null) }} disabled={autolinking}>
              {autolinkResult ? 'Close' : 'Cancel'}
            </button>
            {!autolinkResult && (
              <button className="btn btn-primary" onClick={handleRunAutolink} disabled={autolinking || !autolinkFolder}>
                <RefreshCw size={13} style={{ animation: autolinking ? 'spin 1s linear infinite' : 'none' }} />
                {autolinking ? 'Linking…' : 'Auto-link'}
              </button>
            )}
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!autolinkResult ? (
            <>
              <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--text)', display: 'block', marginBottom: 4 }}>How auto-link works</strong>
                Auto-link searches a folder (and all its subfolders) for files whose names match the media slots in this project. Matching is done by filename — the file name on disk must match the slot name in the project exactly (case-insensitive). Already-linked files are skipped.
                <div style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 11, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', lineHeight: 1.7 }}>
                  Slot: <strong>consult_video.mp4</strong><br />
                  Match: <strong>/your/folder/Patient001/consult_video.mp4</strong> ✓<br />
                  No match: <strong>/your/folder/ConsultVideo.mp4</strong> ✗
                </div>
              </div>
              <div className="form-field" style={{ margin: 0 }}>
                <label>Base Folder</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={autolinkFolder}
                    onChange={e => setAutolinkFolder(e.target.value)}
                    placeholder="/path/to/your/media/folder"
                    style={{ flex: 1 }}
                  />
                  <button className="btn btn-secondary" style={{ flexShrink: 0 }}
                    onClick={async () => { const p = await api.selectFolder(); if (p) setAutolinkFolder(p) }}>
                    Browse
                  </button>
                </div>
                <span className="text-muted text-sm" style={{ marginTop: 4 }}>
                  The folder (and subfolders) to search. This is saved per project so you only set it once.
                </span>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {autolinkResult.error ? (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#b91c1c' }}>
                  {autolinkResult.error}
                </div>
              ) : (
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {autolinkResult.linked > 0
                    ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>✓ {autolinkResult.linked} file{autolinkResult.linked !== 1 ? 's' : ''} linked</span>
                    : <span style={{ color: 'var(--text-muted)' }}>No new files linked</span>}
                  {autolinkResult.skipped > 0 && <span style={{ color: 'var(--text-muted)' }}>· {autolinkResult.skipped} already linked (skipped)</span>}
                  {autolinkResult.ambiguous > 0 && <span style={{ color: '#d97706' }}>· {autolinkResult.ambiguous} ambiguous — multiple files matched the same name, link manually using the button on each file</span>}
                  {autolinkResult.notFound > 0 && <span style={{ color: 'var(--text-muted)' }}>· {autolinkResult.notFound} not found in folder</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {newReview && (
        <NewReviewModal
          mediaFile={newReview.mediaFile}
          projectId={projectId}
          onClose={() => setNewReview(null)}
          onCreated={(reviewId) => { setNewReview(null); navigate(`/review/${reviewId}`) }}
        />
      )}

      {/* Reviewer name modal */}
      <Modal
        open={showNameModal}
        onClose={() => setShowNameModal(false)}
        title="Your Name for This Project"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowNameModal(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSaveReviewerName} disabled={!nameInput.trim()}>Save</button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            This name is attached to every review you create on this project. Use the same name on every device.
            <br /><br />
            <strong>Sharing this computer?</strong> Each person should set their own name here before creating reviews.
          </p>
          <div className="form-field">
            <label>Your Name</label>
            <input
              autoFocus
              placeholder="e.g. Alice Chen"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSaveReviewerName()}
            />
          </div>
        </div>
      </Modal>

      {tour.node}
    </div>
  )
}

function FolderOpenIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>
  )
}

function Pagination({ currentPage, totalPages, total, pageSize, onPageChange }) {
  if (totalPages <= 1) return null
  const start = (currentPage - 1) * pageSize + 1
  const end = Math.min(currentPage * pageSize, total)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <button className="btn btn-ghost btn-sm" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1}>
        ← Prev
      </button>
      <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
        {start}–{end} of {total}
      </span>
      <button className="btn btn-ghost btn-sm" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages}>
        Next →
      </button>
    </div>
  )
}

function EncounterRow({ encounter, expanded, onToggle, mediaTypes, onAddReview, onOpenReview, onDeleteReview, onManualLink, onMarkNA, onClearLink, linkSaving }) {
  const completedMedia = encounter.media?.filter(m => {
    if (!m.reviews_required) return m.reviews?.some(r => r.status === 'submitted')
    return m.reviews_completed >= m.reviews_required
  }) || []
  const total = encounter.media?.length || 0
  const complete = encounter.completed

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      {/* Encounter header */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', cursor: 'pointer', background: expanded ? 'var(--bg-secondary)' : 'var(--bg)',
          transition: 'background 0.1s',
        }}
        onMouseEnter={e => !expanded && (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={e => !expanded && (e.currentTarget.style.background = 'var(--bg)')}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {expanded ? <ChevronDown size={15} color="var(--text-secondary)" /> : <ChevronRight size={15} color="var(--text-secondary)" />}
          {complete
            ? <CheckCircle2 size={15} color="var(--success)" />
            : <Circle size={15} color="var(--text-muted)" />
          }
          <span style={{ fontWeight: 500, fontSize: 14 }}>{encounter.name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="text-muted text-sm">{total} media file{total !== 1 ? 's' : ''}</span>
          <span className={`badge ${complete ? 'badge-success' : 'badge-muted'}`}>
            {complete ? 'Complete' : `${completedMedia.length}/${total}`}
          </span>
        </div>
      </div>

      {/* Media list */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg)' }}>
          {(encounter.media || []).map((mf, idx) => (
            <MediaRow
              key={mf.id}
              mediaFile={mf}
              mediaTypes={mediaTypes}
              onAddReview={() => onAddReview(mf)}
              onOpenReview={onOpenReview}
              onDeleteReview={onDeleteReview}
              onManualLink={onManualLink}
              onMarkNA={onMarkNA}
              onClearLink={onClearLink}
              linkSaving={linkSaving}
              isFirst={idx === 0}
            />
          ))}
          {encounter.media?.length === 0 && (
            <div style={{ padding: '16px 20px', color: 'var(--text-muted)', fontSize: 13 }}>No media files in this encounter folder.</div>
          )}
        </div>
      )}
    </div>
  )
}

function linkStatusBadge(status) {
  if (!status || status === 'linked') return null
  if (status === 'missing') return <span style={{ fontSize: 10, fontWeight: 600, color: '#ef4444', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 3, padding: '1px 5px' }}>File missing</span>
  if (status === 'not_applicable') return <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>N/A</span>
  return <span style={{ fontSize: 10, fontWeight: 600, color: '#d97706', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 3, padding: '1px 5px' }}>Not linked</span>
}

function MediaRow({ mediaFile, mediaTypes, onAddReview, onOpenReview, onDeleteReview, onManualLink, onMarkNA, onClearLink, linkSaving, isFirst }) {
  const Icon = MEDIA_ICONS[mediaFile.file_type] || File
  const required = mediaFile.reviews_required
  const completed = mediaFile.reviews_completed || 0
  const mediaType = mediaTypes.find(t => t.id === mediaFile.media_type_id)
  const status = mediaFile.link_status
  const busy = linkSaving === mediaFile.id

  return (
    <div id={isFirst ? 'tut-proj-mediarow' : undefined} style={{
      padding: '12px 20px 12px 40px',
      borderBottom: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Icon size={14} color="var(--text-secondary)" style={{ flexShrink: 0 }} />
          <span style={{ fontWeight: 500, fontSize: 13 }} className="truncate">{mediaFile.name}</span>
          {linkStatusBadge(status)}
          {status !== 'linked' && status !== 'not_applicable' && (
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', height: 22, flexShrink: 0 }}
              onClick={() => onManualLink(mediaFile.id)} disabled={busy}>
              {busy ? '…' : status === 'missing' ? 'Locate' : 'Link'}
            </button>
          )}
          {status === 'linked' && (
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', height: 22, flexShrink: 0 }}
              onClick={() => onManualLink(mediaFile.id)} disabled={busy}>
              {busy ? '…' : 'Relink'}
            </button>
          )}
          {status !== 'not_applicable' && (
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', height: 22, color: 'var(--text-muted)', flexShrink: 0 }}
              onClick={() => onMarkNA(mediaFile.id)} title="Mark as not applicable">
              N/A
            </button>
          )}
          {status === 'not_applicable' && (
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', height: 22, flexShrink: 0 }}
              onClick={() => onClearLink(mediaFile.id)}>
              Clear
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {mediaType && (
            <span id={isFirst ? 'tut-proj-mediatype' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 7px' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: mediaType.color, flexShrink: 0 }} />
              {mediaType.name}
            </span>
          )}
          {required && (
            <span className={`badge ${completed >= required ? 'badge-success' : 'badge-muted'}`}>
              {completed}/{required} reviews
            </span>
          )}
        </div>
      </div>

      {/* Reviews */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span className="text-muted text-sm">Reviewed by:</span>
        {(mediaFile.reviews || []).length === 0 && (
          <span className="text-muted text-sm">—</span>
        )}
        {(mediaFile.reviews || []).map(r => (
          <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 0, background: 'var(--accent-light)', borderRadius: 4, overflow: 'hidden' }}>
            <button
              className="badge badge-accent"
              onClick={() => onOpenReview(r.id)}
              style={{ cursor: 'pointer', border: 'none', borderRadius: 0, display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent' }}
            >
              <Play size={9} />
              {r.reviewer_name}
              {r.status === 'submitted' && <CheckCircle2 size={9} color="var(--success)" />}
            </button>
            <button
              onClick={() => onDeleteReview(r)}
              title="Delete review"
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 5px', display: 'inline-flex', alignItems: 'center', color: 'var(--text-muted)' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--danger)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <button id={isFirst ? 'tut-proj-addreview' : undefined} className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', height: 22 }} onClick={onAddReview}>
          <Plus size={11} /> Add review
        </button>
      </div>
    </div>
  )
}

// ── Progress View ─────────────────────────────────────────────────────────────
function ProgressView({ encounters, mediaTypes }) {
  const allMedia = encounters.flatMap(e => (e.media || []))
  const allReviews = allMedia.flatMap(m => (m.reviews || []))
  const submitted = allReviews.filter(r => r.status === 'submitted')
  const totalEnc = encounters.length
  const completeEnc = encounters.filter(e => e.completed).length

  // Per-reviewer stats
  const reviewerMap = {}
  for (const r of allReviews) {
    const name = r.reviewer_name || 'Unknown'
    if (!reviewerMap[name]) reviewerMap[name] = { total: 0, submitted: 0 }
    reviewerMap[name].total++
    if (r.status === 'submitted') reviewerMap[name].submitted++
  }
  const reviewers = Object.entries(reviewerMap).sort((a, b) => b[1].submitted - a[1].submitted)
  const maxSubmitted = Math.max(1, ...reviewers.map(([, v]) => v.submitted))

  // Per media type stats
  const typeMap = {}
  for (const m of allMedia) {
    const name = m.media_type_name || 'Untyped'
    const color = m.media_type_color || '#6366f1'
    if (!typeMap[name]) typeMap[name] = { total: 0, submitted: 0, color }
    typeMap[name].total += m.reviews_required || 1
    typeMap[name].submitted += m.reviews_completed || 0
  }
  const types = Object.entries(typeMap)

  const Stat = ({ label, value, sub }) => (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: 10, padding: '18px 22px', minWidth: 140 }}>
      <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 6px' }}>Progress</h1>
      <p className="text-secondary text-sm" style={{ marginBottom: 28 }}>Completion overview across all encounters and reviewers.</p>

      {/* Top stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 32, flexWrap: 'wrap' }}>
        <Stat label="Encounters Complete" value={`${completeEnc}/${totalEnc}`} sub={totalEnc > 0 ? `${Math.round(completeEnc / totalEnc * 100)}%` : '—'} />
        <Stat label="Reviews Submitted" value={submitted.length} sub={`of ${allReviews.length} total`} />
        <Stat label="Active Reviewers" value={reviewers.length} />
      </div>

      {/* Overall progress bar */}
      {allReviews.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, fontWeight: 500 }}>
            <span>Overall Completion</span>
            <span style={{ color: 'var(--text-muted)' }}>{Math.round(submitted.length / allReviews.length * 100)}%</span>
          </div>
          <div style={{ height: 8, background: 'var(--border)', borderRadius: 99 }}>
            <div style={{ height: '100%', borderRadius: 99, background: 'var(--primary)', width: `${submitted.length / allReviews.length * 100}%`, transition: 'width 0.4s' }} />
          </div>
        </div>
      )}

      {/* Per-reviewer breakdown */}
      {reviewers.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>By Reviewer</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {reviewers.map(([name, stats]) => (
              <div key={name}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                  <span style={{ fontWeight: 500 }}>{name}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{stats.submitted} submitted · {stats.total} total</span>
                </div>
                <div style={{ height: 6, background: 'var(--border)', borderRadius: 99 }}>
                  <div style={{ height: '100%', borderRadius: 99, background: 'var(--primary)', width: `${stats.submitted / maxSubmitted * 100}%`, transition: 'width 0.4s' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per encounter completion */}
      {encounters.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>By Encounter</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {encounters.map(enc => {
              const total = (enc.media || []).reduce((s, m) => s + (m.reviews_required || 1), 0)
              const done = (enc.media || []).reduce((s, m) => s + Math.min(m.reviews_completed || 0, m.reviews_required || 1), 0)
              const pct = total > 0 ? done / total * 100 : 0
              return (
                <div key={enc.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 160, fontSize: 12, color: enc.completed ? 'var(--success)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {enc.completed && <CheckCircle2 size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} />}{enc.name}
                  </div>
                  <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 99 }}>
                    <div style={{ height: '100%', borderRadius: 99, background: enc.completed ? 'var(--success)' : 'var(--primary)', width: `${pct}%`, transition: 'width 0.4s' }} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', width: 40, textAlign: 'right' }}>{Math.round(pct)}%</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {encounters.length === 0 && <div className="empty-state"><p>No encounters yet.</p></div>}
    </div>
  )
}

// ── Activity View ─────────────────────────────────────────────────────────────
function ActivityView({ encounters }) {
  const events = []
  for (const enc of encounters) {
    for (const m of (enc.media || [])) {
      for (const r of (m.reviews || [])) {
        if (r.submitted_at) events.push({ type: 'submitted', date: new Date(r.submitted_at), reviewer: r.reviewer_name, encounter: enc.name, file: m.name })
        else events.push({ type: 'in_progress', date: new Date(r.created_at), reviewer: r.reviewer_name, encounter: enc.name, file: m.name })
      }
    }
  }
  events.sort((a, b) => b.date - a.date)

  function groupByDate(events) {
    const groups = {}
    for (const e of events) {
      const key = e.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      if (!groups[key]) groups[key] = []
      groups[key].push(e)
    }
    return Object.entries(groups)
  }

  function initials(name) {
    return (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  }



  const groups = groupByDate(events)

  return (
    <div style={{ maxWidth: 620 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 6px' }}>Activity</h1>
      <p className="text-secondary text-sm" style={{ marginBottom: 28 }}>Review events across all encounters, newest first.</p>

      {groups.length === 0 && <div className="empty-state"><p>No review activity yet.</p></div>}

      {groups.map(([date, evts]) => (
        <div key={date} style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>{date}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {evts.map((e, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', borderRadius: 7, background: 'var(--bg-secondary)' }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: colorFor(e.reviewer), color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                  {initials(e.reviewer)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span>{e.reviewer}</span>
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {e.encounter} / {e.file}</span>
                  </div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  {e.type === 'submitted'
                    ? <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--success)', background: 'var(--success-light)', padding: '2px 7px', borderRadius: 99 }}>Submitted</span>
                    : <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--border)', padding: '2px 7px', borderRadius: 99 }}>In progress</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                  {e.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Data Visualization View ───────────────────────────────────────────────────
function DataVizView() {
  return (
    <div style={{ maxWidth: 600 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 6px' }}>Data Visualization</h1>
      <p className="text-secondary text-sm" style={{ marginBottom: 32 }}>Charts and analysis coming soon.</p>
      <div style={{
        border: '2px dashed var(--border)', borderRadius: 12,
        padding: '64px 32px', textAlign: 'center', color: 'var(--text-muted)',
      }}>
        <LineChart size={40} style={{ margin: '0 auto 16px', opacity: 0.3 }} />
        <p style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Nothing here yet</p>
        <p style={{ fontSize: 13 }}>This is where charts and data analysis will live.</p>
      </div>
    </div>
  )
}
