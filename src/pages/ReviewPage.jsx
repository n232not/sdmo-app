import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ChevronLeft, Plus, Maximize2, Minimize2,
  Clock, Trash2, ChevronDown, ChevronUp, CheckCircle2, Maximize, Edit2, AlertCircle,
  Columns2, Rows2, ExternalLink,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, formatTime } from '../lib/api'
import FormRenderer from '../components/forms/FormRenderer'
import Modal from '../components/ui/Modal'

function parseFormResponses(rev) {
  return Object.fromEntries((rev.form_responses || []).map(fr => [fr.form_id, fr.responses]))
}

export default function ReviewPage() {
  const { reviewId } = useParams()
  const navigate = useNavigate()
  const videoRef = useRef(null)
  const [videoDuration, setVideoDuration] = useState(0)
  const [videoHovered, setVideoHovered] = useState(false)
  const [videoPaused, setVideoPaused] = useState(true)

  const [review, setReview] = useState(null)
  const [mediaFile, setMediaFile] = useState(null)
  const [timestamps, setTimestamps] = useState([])
  const [tags, setTags] = useState([])
  const [workspaceTabs, setWorkspaceTabs] = useState([])
  const [formSchemas, setFormSchemas] = useState({})
  const [instructions, setInstructions] = useState({})
  const [formResponses, setFormResponses] = useState({})

  const [activeTab, setActiveTab] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [videoExpanded, setVideoExpanded] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false)
  const [layoutMode, setLayoutMode] = useState('vertical') // 'vertical' | 'horizontal'
  const [splitPct, setSplitPct] = useState(44) // video height% (vertical) or width% (horizontal)
  const [workspaceMinimized, setWorkspaceMinimized] = useState(false)

  const [keybinds, setKeybinds] = useState([])
  const [videoUrl, setVideoUrl] = useState(null)
  const [showSubmit, setShowSubmit] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [validationErrors, setValidationErrors] = useState([])
  const [linkModal, setLinkModal] = useState(null) // null | 'not_linked' | 'missing'
  const [linkSaving, setLinkSaving] = useState(false)
  const [encProjectId, setEncProjectId] = useState(null)

  const splitDragRef = useRef(null)
  const mainAreaRef = useRef(null)
  const videoPanelRef = useRef(null)

  useEffect(() => { load() }, [reviewId])

  function refreshReviewData(id) {
    api.getReview(id).then(rev => {
      if (!rev) return
      setSubmitted(rev.status === 'submitted')
      setFormResponses(parseFormResponses(rev))
    })
  }

  // Sync with pop-out workspace window
  useEffect(() => {
    function onReviewUpdated(updatedId) {
      if (String(updatedId) === String(reviewId)) refreshReviewData(reviewId)
    }
    function onWorkspaceClosed(closedId) {
      if (String(closedId) === String(reviewId)) setWorkspaceMinimized(false)
      // Data refresh comes via the review:updated event emitted alongside workspace:closed in main.js
    }
    const subReview = api.onReviewUpdated(onReviewUpdated)
    const subWorkspace = api.onWorkspaceClosed(onWorkspaceClosed)
    return () => {
      api.offReviewUpdated(subReview)
      api.offWorkspaceClosed(subWorkspace)
      api.closeWorkspaceWindow(reviewId)
    }
  }, [reviewId])

  // Sync fullscreen state when user exits via Escape
  useEffect(() => {
    async function checkFs() {
      const fs = await api.isFullscreen()
      if (!fs && isFullscreen) { setIsFullscreen(false); setVideoExpanded(false) }
    }
    window.addEventListener('resize', checkFs)
    return () => window.removeEventListener('resize', checkFs)
  }, [isFullscreen])

  async function toggleFullscreen() {
    const entering = !isFullscreen
    setIsFullscreen(entering)
    setVideoExpanded(entering)
    await api.setFullscreen(entering)
  }

  async function handlePopOut() {
    const base = window.location.href.split('#')[0]
    const url = `${base}#/workspace/${reviewId}`
    await api.openWorkspaceWindow(url)
    setWorkspaceMinimized(true)
  }

  // Keybind listener
  useEffect(() => {
    if (submitted || keybinds.length === 0) return
    function onKeyDown(e) {
      // Ignore when typing in an input/textarea/select
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const key = e.key.toLowerCase()
      const bind = keybinds.find(b => b.key.toLowerCase() === key)
      if (!bind) return
      e.preventDefault()
      addTimestampWithTag(bind.tagId ?? null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [submitted, keybinds, tags])

  async function load() {
    setLoading(true)
    const rev = await api.getReview(reviewId)
    if (!rev) { navigate(-1); return }
    setReview(rev)
    setSubmitted(rev.status === 'submitted')
    setTimestamps(rev.timestamps || [])
    setFormResponses(parseFormResponses(rev))

    const mf = await api.getMediaFile(rev.media_file_id)
    setMediaFile(mf)
    if (!mf?.encounter_id) { setLoading(false); return }

    // Check link status — show modal if file not accessible on this machine
    if (mf.link_status === 'not_linked' || mf.link_status === 'missing') {
      setLinkModal(mf.link_status)
      const enc = await api.getEncounter(mf.encounter_id)
      if (enc) setEncProjectId(enc.project_id)
      setLoading(false)
      return
    }
    setLinkModal(null)

    // Parallel: video URL + encounter
    const [url, enc] = await Promise.all([
      api.getVideoUrl(mf.resolved_path || mf.file_path || ''),
      api.getEncounter(mf.encounter_id),
    ])
    setVideoUrl(url)
    if (!enc) { setLoading(false); return }
    setEncProjectId(enc.project_id)

    // Parallel: project + media types
    const [proj, allTypes] = await Promise.all([
      api.getProject(enc.project_id),
      api.listMediaTypes(enc.project_id),
    ])
    if (proj?.keybinds) setKeybinds(proj.keybinds)

    const mt = allTypes.find(t => t.id === mf.media_type_id)
    if (!mt) { setLoading(false); return }
    setTags(mt.tags || [])
    setWorkspaceTabs(mt.workspace_tabs || [])

    // Parallel: fetch all workspace tab content at once
    const formTabs = (mt.workspace_tabs || []).filter(t => t.tab_type === 'form')
    const instrTabs = (mt.workspace_tabs || []).filter(t => t.tab_type === 'instruction')
    const [forms, allInstr] = await Promise.all([
      Promise.all(formTabs.map(tab => api.getForm(tab.ref_id))),
      instrTabs.length > 0 ? api.listInstructions(enc.project_id) : Promise.resolve([]),
    ])
    const newFormSchemas = {}
    formTabs.forEach((tab, i) => { if (forms[i]) newFormSchemas[tab.ref_id] = forms[i] })
    setFormSchemas(newFormSchemas)
    const newInstructions = {}
    instrTabs.forEach(tab => {
      const instr = allInstr.find(i => i.id === tab.ref_id)
      if (instr) newInstructions[tab.ref_id] = instr
    })
    setInstructions(newInstructions)

    setLoading(false)
  }

  async function handleLinkFile() {
    if (!mediaFile) return
    setLinkSaving(true)
    const filePath = await api.browseMediaFile(mediaFile.id)
    if (filePath) {
      await api.setMediaLink(mediaFile.id, encProjectId, filePath)
      setLinkModal(null)
      load()
    }
    setLinkSaving(false)
  }

  async function handleMarkNA() {
    if (!mediaFile) return
    await api.markMediaNotApplicable(mediaFile.id)
    navigate(-1)
  }

  // --- Drag-to-resize split ---
  function onDividerMouseDown(e) {
    e.preventDefault()
    const container = mainAreaRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const isHoriz = layoutMode === 'horizontal'
    const totalSize = isHoriz ? rect.width : rect.height
    const startPos = isHoriz ? e.clientX : e.clientY
    const startPct = splitPct

    function onMove(ev) {
      const delta = (isHoriz ? ev.clientX : ev.clientY) - startPos
      const deltaPct = (delta / totalSize) * 100
      setSplitPct(Math.min(75, Math.max(20, startPct + deltaPct)))
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  async function addTimestamp() {
    return addTimestampWithTag(null)
  }

  async function addTimestampWithTag(tagId) {
    const t = videoRef.current?.currentTime ?? 0
    const tag = tagId != null ? tags.find(tg => tg.id == tagId) : null
    const id = await api.saveTimestamp(reviewId, {
      time_seconds: t,
      notes: '',
      tag_id: tag?.id || null,
      tag_label: tag?.label || null,
      tag_color: tag?.color || null,
    })
    const newTs = { id, time_seconds: t, notes: '', tag_id: tag?.id || null, tag_label: tag?.label || null, tag_color: tag?.color || null }
    setTimestamps(ts => [...ts, newTs].sort((a, b) => a.time_seconds - b.time_seconds))
  }

  async function updateTimestamp(id, changes) {
    if ('tag_id' in changes) {
      const tag = tags.find(t => t.id == changes.tag_id)
      changes.tag_color = tag?.color || null
    }
    await api.updateTimestamp(id, changes)
    setTimestamps(ts => ts.map(t => t.id === id ? { ...t, ...changes } : t))
  }

  async function deleteTimestamp(id) {
    await api.deleteTimestamp(id)
    setTimestamps(ts => ts.filter(t => t.id !== id))
  }

  async function saveFormResponse(formId, responses) {
    await api.saveFormResponse(reviewId, { form_id: formId, responses })
    setFormResponses(r => ({ ...r, [formId]: responses }))
  }

  function getRequiredErrors() {
    const errors = []
    for (const tab of workspaceTabs) {
      if (tab.tab_type !== 'form') continue
      const form = formSchemas[tab.ref_id]
      if (!form?.schema?.sections) continue
      const responses = formResponses[tab.ref_id] || {}
      for (const section of form.schema.sections) {
        for (const el of (section.elements || [])) {
          if (!el.required) continue
          const val = responses[el.id]
          const empty = val === undefined || val === null || val === '' ||
            (Array.isArray(val) && val.length === 0)
          if (empty) errors.push({ tab: tab.label, question: el.label })
        }
      }
    }
    return errors
  }

  function handleSubmitClick() {
    const errors = getRequiredErrors()
    if (errors.length > 0) {
      setValidationErrors(errors)
    } else {
      setValidationErrors([])
      setShowSubmit(true)
    }
  }

  async function handleSubmit() {
    await api.submitReview(reviewId, {})
    setSubmitted(true)
    setShowSubmit(false)
    api.notifyReviewUpdate(reviewId).catch(() => {})
  }

  async function handleUnsubmit() {
    await api.unsubmitReview(reviewId)
    setSubmitted(false)
    api.notifyReviewUpdate(reviewId).catch(() => {})
  }

  function seekTo(sec) {
    if (videoRef.current) {
      videoRef.current.currentTime = sec
      videoRef.current.play()
    }
  }

  const isVideo = mediaFile?.file_type === 'video'

  if (loading) return <div className="empty-state" style={{ height: '100vh' }}><div className="spinner" /></div>

  if (linkModal) {
    const isMissing = linkModal === 'missing'
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: 40 }}>
        <div style={{ maxWidth: 440, width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: 32, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
              {isMissing ? 'File cannot be found' : 'File not linked on this machine'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {isMissing
                ? <>The file <strong>{mediaFile?.name}</strong> was previously linked but cannot be found on disk. It may have been moved or renamed.</>
                : <>The file <strong>{mediaFile?.name}</strong> hasn't been linked to a local path on this machine yet.</>}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-primary" onClick={handleLinkFile} disabled={linkSaving}>
              {linkSaving ? 'Opening…' : isMissing ? 'Locate file…' : 'Browse to file…'}
            </button>
            <button className="btn btn-secondary" onClick={handleMarkNA}>
              I don't have this file (mark N/A)
            </button>
            <button className="btn btn-ghost" onClick={() => navigate(-1)}>
              Go back
            </button>
          </div>
        </div>
      </div>
    )
  }

  const currentTab = workspaceTabs[activeTab]
  const workspaceContent = (
    <WorkspaceTabContent
      tab={currentTab}
      formSchema={currentTab?.tab_type === 'form' ? formSchemas[currentTab?.ref_id] : null}
      instruction={currentTab?.tab_type === 'instruction' ? instructions[currentTab?.ref_id] : null}
      responses={currentTab?.tab_type === 'form' ? formResponses[currentTab?.ref_id] : null}
      onSave={(resp) => saveFormResponse(currentTab.ref_id, resp)}
      readOnly={false}
    />
  )

  const isHoriz = layoutMode === 'horizontal'

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* Top bar */}
      {!videoExpanded && !workspaceExpanded && (
        <div style={{
          height: 48, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
          WebkitAppRegion: 'drag',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' }}>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => navigate(-1)}>
              <ChevronLeft size={16} />
            </button>
            <span className="truncate" style={{ fontWeight: 500, fontSize: 13, maxWidth: 300 }}>
              {mediaFile?.name}
            </span>
            {submitted && <span className="badge badge-success"><CheckCircle2 size={10} /> Submitted</span>}
          </div>
          <div style={{ display: 'flex', gap: 6, WebkitAppRegion: 'no-drag' }}>
            {/* Layout toggle */}
            <button
              className="btn btn-ghost btn-icon btn-sm"
              title={isHoriz ? 'Stack video above workspace' : 'Place workspace beside video'}
              onClick={() => setLayoutMode(m => m === 'vertical' ? 'horizontal' : 'vertical')}
            >
              {isHoriz ? <Rows2 size={15} /> : <Columns2 size={15} />}
            </button>
            {submitted ? (
              <button className="btn btn-secondary btn-sm" onClick={handleUnsubmit}>
                <Edit2 size={13} /> Edit Review
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={handleSubmitClick}>
                Submit Review
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Center: video + workspace (with resizable split) */}
        {!workspaceExpanded && (
          <div
            ref={mainAreaRef}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: isHoriz ? 'row' : 'column',
              overflow: 'hidden',
              minWidth: 0,
            }}
          >
            {/* Video panel */}
            <div
              ref={videoPanelRef}
              style={{
                background: '#000',
                position: 'relative',
                ...(isHoriz
                  ? { width: (videoExpanded || workspaceMinimized) ? '100%' : `${splitPct}%`, height: '100%', flexShrink: videoExpanded || workspaceMinimized ? 0 : 0, flex: workspaceMinimized && !videoExpanded ? 1 : undefined }
                  : { height: videoExpanded ? '100%' : workspaceMinimized ? undefined : `${splitPct}%`, flex: workspaceMinimized && !videoExpanded ? 1 : undefined, width: '100%', flexShrink: 0 }),
              }}
              onMouseEnter={() => setVideoHovered(true)}
              onMouseLeave={() => setVideoHovered(false)}
            >
              {isVideo ? (
                <video
                  ref={videoRef}
                  src={videoUrl}
                  controls
                  style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
                  onLoadedMetadata={e => setVideoDuration(e.target.duration)}
                  onPlay={() => setVideoPaused(false)}
                  onPause={() => setVideoPaused(true)}
                />
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#fff', opacity: 0.5 }}>
                  Non-video file — see workspace tabs
                </div>
              )}

              {/* YouTube-style timestamp markers on the progress bar */}
              {isVideo && videoDuration > 0 && timestamps.length > 0 && (
                <TimestampMarkers
                  timestamps={timestamps}
                  duration={videoDuration}
                  tags={tags}
                  onSeek={seekTo}
                  visible={videoHovered || videoPaused}
                />
              )}

              {isVideo && (
                <button
                  className="btn btn-icon btn-sm"
                  style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.55)', color: '#fff', border: 'none' }}
                  onClick={toggleFullscreen}
                  title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
              )}
            </div>

            {/* Drag divider */}
            {!videoExpanded && !workspaceMinimized && (
              <div
                onMouseDown={onDividerMouseDown}
                style={{
                  flexShrink: 0,
                  background: 'var(--border)',
                  cursor: isHoriz ? 'col-resize' : 'row-resize',
                  ...(isHoriz
                    ? { width: 5, height: '100%' }
                    : { height: 5, width: '100%' }),
                  transition: 'background 0.15s',
                  zIndex: 10,
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--accent)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--border)'}
              />
            )}

            {/* Workspace panel */}
            {!videoExpanded && (
              <div style={{
                display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, background: 'var(--bg)',
                ...(workspaceMinimized
                  ? { flexShrink: 0, height: 82 }
                  : { flex: 1, minHeight: 0 }),
                transition: 'height 0.2s ease',
              }}>
                {/* Add Timestamp bar — hidden when minimized */}
                <div style={{ padding: '7px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  <button className="btn btn-secondary btn-sm" onClick={addTimestamp} disabled={submitted}>
                    <Plus size={13} /> Add Timestamp
                  </button>
                  <span className="text-muted text-sm">at current video position</span>
                </div>

                {workspaceTabs.length > 0 ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                      <div className="tabs" style={{ flex: 1, borderBottom: 'none' }}>
                        {workspaceTabs.map((tab, i) => (
                          <button
                            key={tab.id}
                            className={`tab-btn ${activeTab === i ? 'active' : ''}`}
                            onClick={() => { setActiveTab(i); if (workspaceMinimized) setWorkspaceMinimized(false) }}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                      {/* Workspace controls */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 6px', flexShrink: 0 }}>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          title={workspaceMinimized ? 'Restore workspace' : 'Minimize workspace'}
                          onClick={() => setWorkspaceMinimized(m => !m)}
                        >
                          {workspaceMinimized ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          title="Open workspace in separate window"
                          onClick={handlePopOut}
                        >
                          <ExternalLink size={13} />
                        </button>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          title="Expand workspace fullscreen"
                          onClick={() => setWorkspaceExpanded(true)}
                        >
                          <Maximize size={14} />
                        </button>
                      </div>
                    </div>
                    {!workspaceMinimized && (
                      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
                        {workspaceContent}
                      </div>
                    )}
                  </>
                ) : (
                  !workspaceMinimized && (
                    <div className="empty-state" style={{ flex: 1 }}>
                      <p className="text-sm">No workspace tabs configured for this media type.</p>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        )}

        {/* Workspace fullscreen */}
        {workspaceExpanded && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div className="tabs" style={{ flex: 1, borderBottom: 'none' }}>
                {workspaceTabs.map((tab, i) => (
                  <button key={tab.id} className={`tab-btn ${activeTab === i ? 'active' : ''}`} onClick={() => setActiveTab(i)}>
                    {tab.label}
                  </button>
                ))}
              </div>
              <button className="btn btn-ghost btn-sm" style={{ margin: '0 8px' }} onClick={() => setWorkspaceExpanded(false)}>
                <Minimize2 size={14} /> Restore
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 24, maxWidth: 800, width: '100%', margin: '0 auto' }}>
              {workspaceContent}
            </div>
          </div>
        )}

        {/* Sidebar: timestamps (collapsible) */}
        {!(videoExpanded || workspaceExpanded) && (
        <div style={{ display: 'flex', flexShrink: 0, position: 'relative' }}>
          {/* Toggle tab — lives outside overflow:hidden so it's always visible */}
          <button
            onClick={() => setSidebarOpen(s => !s)}
            title={sidebarOpen ? 'Collapse timestamps' : 'Show timestamps'}
            style={{
              position: 'absolute',
              left: -14,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 14,
              height: 44,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRight: 'none',
              borderRadius: '4px 0 0 4px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 20,
              color: 'var(--text-muted)',
              padding: 0,
              fontSize: 9,
            }}
          >
            {sidebarOpen ? '›' : '‹'}
          </button>

          <div style={{
            width: sidebarOpen ? 280 : 0,
            overflow: 'hidden',
            borderLeft: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            transition: 'width 0.2s ease',
            height: '100%',
          }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Timestamps</span>
            <span className="badge badge-muted">{timestamps.length}</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {timestamps.length === 0 ? (
              <div className="empty-state" style={{ padding: '40px 10px' }}>
                <Clock size={24} />
                <p className="text-sm">No timestamps yet.<br />Click "Add Timestamp" while the video plays.</p>
              </div>
            ) : (
              timestamps.map(ts => (
                <TimestampBubble
                  key={ts.id}
                  ts={ts}
                  tags={tags}
                  onSeek={() => seekTo(ts.time_seconds)}
                  onChange={(changes) => updateTimestamp(ts.id, changes)}
                  onDelete={() => deleteTimestamp(ts.id)}
                  readOnly={false}
                />
              ))
            )}
          </div>
          </div>
        </div>
        )}
      </div>

      {/* Validation errors */}
      {validationErrors.length > 0 && (
        <div className="modal-overlay" onClick={() => setValidationErrors([])}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <AlertCircle size={18} color="var(--danger)" />
                <h2>Required questions unanswered</h2>
              </div>
              <button className="btn btn-ghost btn-icon" onClick={() => setValidationErrors([])}><span>✕</span></button>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 14 }}>
              Please answer the following required questions before submitting:
            </p>
            <ul style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {validationErrors.map((e, i) => (
                <li key={i} style={{ fontSize: 13 }}>
                  <span className="text-secondary">{e.tab} →</span> <strong>{e.question}</strong>
                </li>
              ))}
            </ul>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setValidationErrors([])}>Go back</button>
            </div>
          </div>
        </div>
      )}

      {/* Submit modal */}
      <Modal
        open={showSubmit}
        onClose={() => setShowSubmit(false)}
        title="Submit Review"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowSubmit(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSubmit}>Submit</button>
          </>
        }
      >
        <p>Submit your review for <strong>{mediaFile?.name}</strong>? You can still edit it afterwards by clicking "Edit Review".</p>
        <p style={{ marginTop: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
          Timestamps: {timestamps.length} · Forms filled: {Object.keys(formResponses).length}
        </p>
      </Modal>
    </div>
  )
}

// YouTube-style markers on the native video progress bar
// The Chromium controls bar is ~40px tall; the timeline track sits at about bottom 28px
function TimestampMarkers({ timestamps, duration, tags, onSeek, visible }) {
  return (
    <div
      className="timestamp-markers"
      style={{
        position: 'absolute',
        bottom: 12,
        left: 0,
        right: 0,
        height: 20,
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.2s',
      }}
    >
      {timestamps.map(ts => {
        const tag = tags.find(t => t.id === ts.tag_id)
        const color = tag?.color || '#9ca3af'
        const pct = Math.min(100, Math.max(0, (ts.time_seconds / duration) * 100))
        return (
          <div
            key={ts.id}
            title={`${formatTime(ts.time_seconds)}${ts.tag_label ? ' — ' + ts.tag_label : ''}`}
            style={{
              position: 'absolute',
              left: `${pct}%`,
              bottom: 0,
              transform: 'translateX(-50%)',
              width: 5,
              height: 20,
              background: color,
              borderRadius: '0px 0px 0 0',
              pointerEvents: 'auto',
              cursor: 'pointer',
              zIndex: 10,
              boxShadow: '0 0 0 0px rgba(0,0,0,0.5)',
            }}
            onClick={() => onSeek(ts.time_seconds)}
          />
        )
      })}
    </div>
  )
}

function TimestampBubble({ ts, tags, onSeek, onChange, onDelete, readOnly }) {
  const [expanded, setExpanded] = useState(true)
  const tag = tags.find(t => t.id === ts.tag_id)
  const tagColor = tag?.color || null

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid',
      borderColor: tagColor ? tagColor + '55' : 'var(--border)',
      borderRadius: 8, overflow: 'hidden', flexShrink: 0,
      borderLeft: tagColor ? `3px solid ${tagColor}` : undefined,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', cursor: 'pointer' }} onClick={() => setExpanded(e => !e)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            style={{ padding: 2, color: 'var(--accent)', fontFamily: 'monospace', fontSize: 12, fontWeight: 700 }}
            onClick={e => { e.stopPropagation(); onSeek() }}
            title="Seek to timestamp"
          >
            {formatTime(ts.time_seconds)}
          </button>
          {ts.tag_label && (
            <span style={{
              fontSize: 10, fontWeight: 500, padding: '1px 6px', borderRadius: 99,
              background: (tagColor || '#9ca3af') + '22', color: tagColor || 'var(--accent)',
              border: `1px solid ${(tagColor || '#9ca3af')}55`,
            }}>
              {ts.tag_label}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          {!readOnly && (
            <button className="btn btn-ghost btn-icon btn-sm" onClick={e => { e.stopPropagation(); onDelete() }}>
              <Trash2 size={11} />
            </button>
          )}
          <ChevronDown size={12} color="var(--text-muted)" style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }} />
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {tags.length > 0 && (
            <select
              value={ts.tag_id || ''}
              disabled={readOnly}
              onChange={e => {
                const tag = tags.find(t => t.id == e.target.value)
                onChange({ tag_id: tag?.id || null, tag_label: tag?.label || null, tag_color: tag?.color || null })
              }}
              style={{ fontSize: 12, padding: '3px 6px', height: 28 }}
            >
              <option value="">No tag</option>
              {tags.map(t => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          )}
          <textarea
            placeholder="Notes…"
            value={ts.notes || ''}
            disabled={readOnly}
            onChange={e => onChange({ notes: e.target.value })}
            rows={2}
            style={{ fontSize: 12, resize: 'none', minHeight: 'unset' }}
          />
        </div>
      )}
    </div>
  )
}

function WorkspaceTabContent({ tab, formSchema, instruction, responses, onSave, readOnly }) {
  if (!tab) return null
  if (tab.tab_type === 'form') {
    if (!formSchema) return <div className="empty-state"><p className="text-sm">Form not found.</p></div>
    return <FormRenderer schema={formSchema.schema} responses={responses || {}} onSave={onSave} readOnly={readOnly} />
  }
  if (tab.tab_type === 'instruction') {
    if (instruction?.content_type === 'pdf' && instruction?.file_path) {
      const pdfUrl = `localfile://${encodeURIComponent(instruction.file_path)}`
      return (
        <iframe
          src={pdfUrl}
          style={{ width: '100%', height: '100%', border: 'none', minHeight: 500, display: 'block' }}
          title={instruction.name}
        />
      )
    }
    const content = instruction?.content || ''
    return (
      <div className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    )
  }
  return null
}
