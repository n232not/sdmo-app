import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, FolderOpen, Trash2, Settings, ChevronRight, Calendar, User, Upload, HelpCircle, Link2, Cloud, ArrowLeft, Folder, GraduationCap } from 'lucide-react'
import { api, formatDate } from '../lib/api'
import Modal from '../components/ui/Modal'
import useTour from '../components/ui/useTour'

const TUTORIAL_KEY = 'sdmo_tutorial_v1'

const TUTORIAL_STEPS = [
  {
    targetId: 'tut-name',
    placement: 'bottom',
    title: 'Your Reviewer Name',
    body: 'This name is attached to every review you create. Use the same name on every device, spelled the same way, so synced reviews stay grouped under the right person.',
  },
  {
    targetId: 'tut-import',
    placement: 'bottom',
    title: 'Joining an Existing Project',
    body: "A colleague already set up the project? Click Import to join from the shared sync folder or a project .json file. You'll then link your own local media files; videos stay on your machine and are never uploaded by SDMo.",
  },
  {
    targetId: 'tut-new',
    placement: 'bottom',
    title: 'Creating a New Project',
    body: "Start fresh. After creating a project you'll be taken to Settings. The Overview tab walks through forms, instructions, media types, files, and sync in the order most teams set them up.",
  },
  {
    targetId: 'tut-help',
    placement: 'bottom',
    title: 'Reopen This Tour',
    body: "Click the ? button any time to run this tutorial again.",
  },
]

export default function HomePage() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', description: '' })
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [reviewerName, setReviewerName] = useState(null)
  const [showIdentity, setShowIdentity] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [importedProject, setImportedProject] = useState(null) // { id, name, syncHint, alreadySynced? }
  const [importMediaFolder, setImportMediaFolder] = useState('')
  const [importSyncFolder, setImportSyncFolder] = useState('')
  // Join flow
  const [joinStep, setJoinStep] = useState(null) // null | 'choose' | 'local' | 'cloud-auth' | 'cloud-browse'
  const [joinLocalFolder, setJoinLocalFolder] = useState('')
  const [joinCloudProvider, setJoinCloudProvider] = useState(null)
  const [joinCloudBreadcrumb, setJoinCloudBreadcrumb] = useState([])
  const [joinCloudFolders, setJoinCloudFolders] = useState([])
  const [joinCloudLoading, setJoinCloudLoading] = useState(false)
  const [joinError, setJoinError] = useState(null)
  const [joinLoading, setJoinLoading] = useState(false)
  const tour = useTour(TUTORIAL_STEPS, TUTORIAL_KEY)
  const navigate = useNavigate()

  useEffect(() => {
    load()
    api.getAppSettings().then(s => {
      setReviewerName(s.reviewer_name || null)
      if (!s.reviewer_name) setShowIdentity(true)
    })
  }, [])

  async function handleTrySample() {
    const result = await api.createSampleProject()
    if (result?.id && result?.tutorialReviewId) navigate(`/project/${result.id}?sampleTour=1&sampleReviewId=${result.tutorialReviewId}`)
    else if (result?.id) navigate(`/project/${result.id}`)
  }

  async function handleSaveName() {
    if (!nameInput.trim()) return
    await api.setAppSettings({ reviewer_name: nameInput.trim() })
    setReviewerName(nameInput.trim())
    setShowIdentity(false)
  }

  function resetJoin() {
    setJoinStep(null)
    setJoinLocalFolder('')
    setJoinCloudProvider(null)
    setJoinCloudBreadcrumb([])
    setJoinCloudFolders([])
    setJoinError(null)
    setJoinLoading(false)
    setJoinCloudLoading(false)
  }

  async function handleJoinLocalFolder() {
    if (!joinLocalFolder) return
    setJoinLoading(true)
    setJoinError(null)
    const result = await api.joinFromLocalFolder(joinLocalFolder)
    setJoinLoading(false)
    if (result?.ok) {
      await load()
      resetJoin()
      setImportMediaFolder('')
      setImportSyncFolder('')
      setImportedProject({ id: result.projectId, name: result.projectName, syncHint: { mode: 'local', provider: null }, alreadySynced: true })
    } else {
      setJoinError(result?.error || 'Failed to join project')
    }
  }

  async function handleCloudConnect(provider) {
    setJoinCloudLoading(true)
    setJoinError(null)
    const result = provider === 'onedrive' ? await api.cloudConnectOneDrive() : await api.cloudConnectGoogleDrive()
    if (result?.error) { setJoinError(result.error); setJoinCloudLoading(false); return }
    setJoinCloudProvider(provider)
    const foldersResult = await api.cloudListFolders(provider, null)
    setJoinCloudFolders(foldersResult?.folders || [])
    setJoinCloudBreadcrumb([])
    setJoinCloudLoading(false)
    setJoinStep('cloud-browse')
  }

  async function handleCloudNavigate(folder) {
    setJoinCloudLoading(true)
    const result = await api.cloudListFolders(joinCloudProvider, folder.id)
    setJoinCloudFolders(result?.folders || [])
    setJoinCloudBreadcrumb(b => [...b, { id: folder.id, name: folder.name }])
    setJoinCloudLoading(false)
  }

  async function handleCloudBreadcrumbClick(idx) {
    setJoinCloudLoading(true)
    const crumb = joinCloudBreadcrumb[idx]
    const result = await api.cloudListFolders(joinCloudProvider, crumb ? crumb.id : null)
    setJoinCloudFolders(result?.folders || [])
    setJoinCloudBreadcrumb(b => idx < 0 ? [] : b.slice(0, idx + 1))
    setJoinCloudLoading(false)
  }

  async function handleJoinCloudFolder(folder) {
    setJoinLoading(true)
    setJoinError(null)
    const result = await api.joinFromCloudFolder(joinCloudProvider, folder.id, folder.name)
    setJoinLoading(false)
    if (result?.ok) {
      await load()
      resetJoin()
      setImportMediaFolder('')
      setImportSyncFolder('')
      setImportedProject({ id: result.projectId, name: result.projectName, syncHint: { mode: 'cloud', provider: joinCloudProvider }, alreadySynced: true })
    } else {
      setJoinError(result?.error || 'Failed to join project')
    }
  }

  async function handleImportProject() {
    const result = await api.importProjectAsNew()
    if (result?.ok) {
      await load()
      const projects = await api.listProjects()
      const proj = projects.find(p => p.id === result.projectId)
      setImportMediaFolder('')
      setImportSyncFolder('')
      setImportedProject({
        id: result.projectId,
        name: proj?.name || 'Imported Project',
        syncHint: result.syncHint || { mode: 'none', provider: null },
      })
    }
  }

  async function handleFinishImport() {
    const proj = await api.getProject(importedProject.id)
    const syncMode = importedProject.syncHint?.mode
    if (importedProject.alreadySynced) {
      await api.updateProject(importedProject.id, { ...proj, media_folder: importMediaFolder || null })
    } else {
      await api.updateProject(importedProject.id, {
        ...proj,
        media_folder: importMediaFolder || null,
        sync_folder: syncMode === 'local' ? (importSyncFolder || null) : null,
      })
    }
    if (importMediaFolder) {
      await api.scanMediaFolder(importMediaFolder, importedProject.id)
    }
    setImportedProject(null)
    navigate(`/project/${importedProject.id}`)
  }

  async function load() {
    setLoading(true)
    const data = await api.listProjects()
    setProjects(data)
    setLoading(false)
  }

  async function handleCreate(e) {
    e.preventDefault()
    if (!form.name.trim()) return
    const project = await api.createProject({ name: form.name.trim(), description: form.description.trim() })
    setShowCreate(false)
    setForm({ name: '', description: '' })
    navigate(`/project/${project.id}/setup`)
  }

  async function handleDelete() {
    if (!deleteTarget) return
    await api.deleteProject(deleteTarget.id)
    setDeleteTarget(null)
    load()
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Top bar */}
      <div style={{
        height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 28px', borderBottom: '1px solid var(--border)',
        WebkitAppRegion: 'drag',
      }}>
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.2px' }}>SDMo</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' }}>
          <button
            id="tut-name"
            onClick={() => { setNameInput(reviewerName || ''); setShowIdentity(true) }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border)', cursor: 'pointer', fontFamily: 'var(--font)' }}
          >
            <User size={12} color="var(--text-muted)" />
            <span style={{ fontSize: 12, color: reviewerName ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
              {reviewerName || 'Set your name'}
            </span>
          </button>
          <button id="tut-import" className="btn btn-secondary btn-sm" onClick={() => setJoinStep('choose')} title="Join an existing project by connecting to its sync folder">
            <Link2 size={14} /> Join Project
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleImportProject} title="Import a project from a .json export file">
            <Upload size={14} /> Import File
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleTrySample} title="Open a ready-made example project with a guided walkthrough">
            <GraduationCap size={14} /> Sample Project
          </button>
          <button id="tut-new" className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> New Project
          </button>
          <button id="tut-help" className="btn btn-ghost btn-icon btn-sm" onClick={tour.start} title="Show tutorial">
            <HelpCircle size={15} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 780, margin: '0 auto', padding: '40px 28px' }}>
        <div style={{ marginBottom: 28 }}>
          <h1>Projects</h1>
          <p className="text-secondary" style={{ marginTop: 4, fontSize: 13 }}>
            Open an existing project or create a new one to start coding encounters.
          </p>
        </div>

        {loading ? (
          <div className="empty-state"><div className="spinner" /></div>
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <FolderOpen size={40} />
            <div>
              <p style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>No projects yet</p>
              <p className="text-sm" style={{ marginTop: 4 }}>Create a project to get started</p>
            </div>
            <p className="text-sm" style={{ marginTop: -2, color: 'var(--text-muted)' }}>
              New to SDMo? Open the sample project for a guided walkthrough.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" onClick={handleTrySample}>
                <GraduationCap size={14} /> Try Sample Project
              </button>
              <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
                <Plus size={14} /> Create Project
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {projects.map(p => (
              <div
                key={p.id}
                className="card"
                style={{ cursor: 'pointer', transition: 'box-shadow 0.15s', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px' }}
                onClick={() => navigate(`/project/${p.id}`)}
                onMouseEnter={e => e.currentTarget.style.boxShadow = 'var(--shadow-sm)'}
                onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 8, background: 'var(--accent-light)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <FolderOpen size={16} color="var(--accent)" />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }} className="truncate">{p.name}</div>
                    {p.description && (
                      <div className="text-secondary text-sm truncate" style={{ marginTop: 1 }}>{p.description}</div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
                      <Calendar size={10} color="var(--text-muted)" />
                      <span className="text-muted text-sm">{formatDate(p.created_at)}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: 12 }}>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    title="Settings"
                    onClick={e => { e.stopPropagation(); navigate(`/project/${p.id}/setup`) }}
                  >
                    <Settings size={14} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    title="Delete"
                    onClick={e => { e.stopPropagation(); setDeleteTarget(p) }}
                  >
                    <Trash2 size={14} />
                  </button>
                  <ChevronRight size={16} color="var(--text-muted)" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Modal */}
      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); setForm({ name: '', description: '' }) }}
        title="New Project"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={!form.name.trim()}>Create & Configure</button>
          </>
        }
      >
        <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-field">
            <label>Project Name *</label>
            <input
              autoFocus
              placeholder="e.g. Pediatric Consultation Study"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label>Description</label>
            <textarea
              placeholder="Optional description or notes about this study"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={3}
            />
          </div>
        </form>
      </Modal>

      {/* Identity Modal */}
      <Modal
        open={showIdentity}
        onClose={() => reviewerName && setShowIdentity(false)}
        title="Your Name"
        footer={
          <>
            {reviewerName && <button className="btn btn-secondary" onClick={() => setShowIdentity(false)}>Cancel</button>}
            <button className="btn btn-primary" onClick={handleSaveName} disabled={!nameInput.trim()}>Save</button>
          </>
        }
      >
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
          Your name is attached to all reviews you create.
        </p>
        <div className="form-field">
          <label>Your Name</label>
          <input
            autoFocus
            placeholder="e.g. Alice Chen"
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSaveName()}
          />
        </div>
      </Modal>

      {/* Delete Confirm */}
      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete Project"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={handleDelete}>Delete</button>
          </>
        }
      >
        <p>Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This will permanently remove all encounters, reviews, and timestamps. The media files on disk will not be affected.</p>
      </Modal>

      {/* Join Project Modal */}
      {joinStep && (() => {
        const providerLabel = joinCloudProvider === 'onedrive' ? 'OneDrive' : joinCloudProvider === 'googledrive' ? 'Google Drive' : ''
        const currentFolderName = joinCloudBreadcrumb.length > 0 ? joinCloudBreadcrumb[joinCloudBreadcrumb.length - 1].name : null

        const footer = joinStep === 'local' ? (
          <>
            <button className="btn btn-secondary" onClick={() => { setJoinStep('choose'); setJoinError(null) }}>
              <ArrowLeft size={14} /> Back
            </button>
            <button className="btn btn-primary" onClick={handleJoinLocalFolder} disabled={!joinLocalFolder || joinLoading}>
              {joinLoading ? 'Joining…' : 'Join Project'}
            </button>
          </>
        ) : joinStep === 'cloud-auth' ? (
          <button className="btn btn-secondary" onClick={() => { setJoinStep('choose'); setJoinError(null) }}>
            <ArrowLeft size={14} /> Back
          </button>
        ) : joinStep === 'cloud-browse' ? (
          <button className="btn btn-secondary" onClick={() => { setJoinStep('cloud-auth'); setJoinCloudProvider(null); setJoinError(null) }}>
            <ArrowLeft size={14} /> Back
          </button>
        ) : null

        return (
          <Modal
            open
            onClose={joinLoading || joinCloudLoading ? null : resetJoin}
            title="Join a Project"
            footer={footer}
          >
            {joinStep === 'choose' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Connect to an existing project's sync folder. The project setup is pulled automatically — no file sharing needed.
                </p>
                <button
                  className="btn btn-secondary"
                  style={{ justifyContent: 'flex-start', gap: 12, padding: '14px 16px', height: 'auto', textAlign: 'left' }}
                  onClick={() => setJoinStep('local')}
                >
                  <Folder size={18} style={{ flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Local / Network Folder</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                      Shared drive, Dropbox, OneDrive local sync, or network folder
                    </div>
                  </div>
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ justifyContent: 'flex-start', gap: 12, padding: '14px 16px', height: 'auto', textAlign: 'left' }}
                  onClick={() => setJoinStep('cloud-auth')}
                >
                  <Cloud size={18} style={{ flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Cloud (OneDrive / Google Drive)</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                      Connect directly via API — no local sync client required
                    </div>
                  </div>
                </button>
              </div>
            )}

            {joinStep === 'local' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  Browse to the shared sync folder for this project. Ask the project owner which folder to point to.
                </p>
                <div className="form-field">
                  <label>Sync Folder</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      value={joinLocalFolder}
                      onChange={e => setJoinLocalFolder(e.target.value)}
                      placeholder="/path/to/shared/ProjectName"
                    />
                    <button className="btn btn-secondary" style={{ flexShrink: 0 }} onClick={async () => {
                      const p = await api.selectFolder(); if (p) setJoinLocalFolder(p)
                    }}>
                      <FolderOpen size={14} /> Browse
                    </button>
                  </div>
                </div>
                {joinError && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{joinError}</p>}
              </div>
            )}

            {joinStep === 'cloud-auth' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Sign in to the cloud service the project owner used, then select the shared folder.
                </p>
                <button
                  className="btn btn-secondary"
                  style={{ justifyContent: 'flex-start', gap: 10, padding: '12px 14px', height: 'auto' }}
                  onClick={() => handleCloudConnect('onedrive')}
                  disabled={joinCloudLoading}
                >
                  <span style={{ fontSize: 18 }}>☁</span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>Connect with OneDrive</span>
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ justifyContent: 'flex-start', gap: 10, padding: '12px 14px', height: 'auto' }}
                  onClick={() => handleCloudConnect('googledrive')}
                  disabled={joinCloudLoading}
                >
                  <span style={{ fontSize: 18 }}>📁</span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>Connect with Google Drive</span>
                </button>
                {joinCloudLoading && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Connecting…</p>}
                {joinError && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{joinError}</p>}
              </div>
            )}

            {joinStep === 'cloud-browse' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  Navigate to the project's sync folder in {providerLabel}, then click <strong>Join</strong>.
                </p>
                {/* Breadcrumb */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '2px 6px', fontSize: 12 }}
                    onClick={() => handleCloudBreadcrumbClick(-1)}
                  >
                    {providerLabel}
                  </button>
                  {joinCloudBreadcrumb.map((crumb, i) => (
                    <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <ChevronRight size={12} />
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ padding: '2px 6px', fontSize: 12 }}
                        onClick={() => handleCloudBreadcrumbClick(i)}
                      >
                        {crumb.name}
                      </button>
                    </span>
                  ))}
                </div>

                {/* Folder list */}
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', minHeight: 120, maxHeight: 260, overflowY: 'auto' }}>
                  {joinCloudLoading ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><div className="spinner" /></div>
                  ) : joinCloudFolders.length === 0 ? (
                    <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>No folders found</div>
                  ) : joinCloudFolders.map(folder => (
                    <div
                      key={folder.id}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}
                    >
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ justifyContent: 'flex-start', gap: 8, flex: 1, padding: '2px 0', fontWeight: 400 }}
                        onClick={() => handleCloudNavigate(folder)}
                      >
                        <Folder size={14} color="var(--text-muted)" />
                        <span style={{ fontSize: 13 }}>{folder.name}</span>
                        <ChevronRight size={12} color="var(--text-muted)" style={{ marginLeft: 'auto' }} />
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        style={{ marginLeft: 8, flexShrink: 0 }}
                        onClick={() => handleJoinCloudFolder(folder)}
                        disabled={joinLoading}
                      >
                        Join
                      </button>
                    </div>
                  ))}
                </div>

                {/* Join current folder button */}
                {currentFolderName && (
                  <button
                    className="btn btn-primary"
                    onClick={() => handleJoinCloudFolder(joinCloudBreadcrumb[joinCloudBreadcrumb.length - 1])}
                    disabled={joinLoading}
                  >
                    {joinLoading ? 'Joining…' : `Join "${currentFolderName}"`}
                  </button>
                )}

                {joinError && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{joinError}</p>}
              </div>
            )}
          </Modal>
        )
      })()}

      {/* Tutorial */}
      {tour.node}

      {/* Post-import folder setup */}
      {importedProject && (() => {
        const hint = importedProject.syncHint || { mode: 'none', provider: null }
        const providerLabel = hint.provider === 'onedrive' ? 'OneDrive' : hint.provider === 'googledrive' ? 'Google Drive' : 'cloud storage'

        return (
          <Modal
            open
            onClose={null}
            title={`Set up "${importedProject.name}" on this computer`}
            footer={<button className="btn btn-primary" onClick={handleFinishImport}>Open Project</button>}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

              {/* Media folder — always shown */}
              <div className="form-field">
                <label>Media Folder</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={importMediaFolder}
                    onChange={e => setImportMediaFolder(e.target.value)}
                    placeholder="/path/to/local/media"
                  />
                  <button className="btn btn-secondary" style={{ flexShrink: 0 }} onClick={async () => {
                    const p = await api.selectFolder(); if (p) setImportMediaFolder(p)
                  }}>
                    <FolderOpen size={14} /> Browse
                  </button>
                </div>
                <span className="text-muted text-sm" style={{ marginTop: 4 }}>
                  The folder on <strong>this computer</strong> containing the encounter subfolders and video files.
                  Every team member needs their own local copy of the same videos — the folder name and subfolder structure must match across all machines.
                </span>
              </div>

              {/* Sync is already configured for joined projects */}
              {importedProject.alreadySynced && (
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--text-secondary)' }}>
                  Sync is already configured — this project will sync automatically.
                </div>
              )}

              {/* Sync setup — varies by hint (file import only) */}
              {!importedProject.alreadySynced && hint.mode === 'cloud' && (
                <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: '#1d4ed8' }}>
                  <strong>This project syncs via {providerLabel}.</strong>
                  <br /><br />
                  After opening the project, go to <strong>Setup → Sync</strong> and sign in to {providerLabel} to connect to the shared folder.
                  Ask the project owner which folder to select — everyone on the team must connect to the same one.
                </div>
              )}

              {!importedProject.alreadySynced && hint.mode === 'local' && (
                <div className="form-field">
                  <label>Sync Folder</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      value={importSyncFolder}
                      onChange={e => setImportSyncFolder(e.target.value)}
                      placeholder="/path/to/shared/drive/ProjectName"
                    />
                    <button className="btn btn-secondary" style={{ flexShrink: 0 }} onClick={async () => {
                      const p = await api.selectFolder(); if (p) setImportSyncFolder(p)
                    }}>
                      <FolderOpen size={14} /> Browse
                    </button>
                  </div>
                  <span className="text-muted text-sm" style={{ marginTop: 4 }}>
                    Point to <strong>your local copy</strong> of the shared sync folder — the same OneDrive, Dropbox, or Google Drive folder the project owner is using, wherever it appears on this machine.
                    Everyone on the team must point to the same underlying folder.
                  </span>
                </div>
              )}

              {!importedProject.alreadySynced && hint.mode === 'none' && (
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: 'var(--text-secondary)' }}>
                  No automatic sync configured. You can set this up later in <strong>Setup → Sync</strong>, or exchange reviews manually using <strong>Share File</strong> and <strong>Import File</strong> on the project page.
                </div>
              )}

              <p className="text-muted text-sm">You can change any of these later in the project's Setup page.</p>
            </div>
          </Modal>
        )
      })()}
    </div>
  )
}
