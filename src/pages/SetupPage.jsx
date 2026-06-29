import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { ChevronLeft, Plus, FolderOpen, ChevronRight, Trash2, Copy, Edit2, Check, Lock, Unlock, Cloud, HardDrive, X, RefreshCw, AlertTriangle, User, HelpCircle } from 'lucide-react'
import { api } from '../lib/api'
import FormBuilder from '../components/setup/FormBuilder'
import MediaTypeEditor from '../components/setup/MediaTypeEditor'
import InstructionEditor from '../components/setup/InstructionEditor'
import Modal from '../components/ui/Modal'
import useTour from '../components/ui/useTour'

<<<<<<< Updated upstream
const SECTIONS = ['Overview', 'Forms', 'Instructions', 'Media Types', 'Encounters', 'Files', 'Sync', 'Keybinds', 'Access', 'Versions', 'Deleted Reviews']
=======
const SECTIONS = ['Overview', 'Forms', 'Instructions', 'Media Types', 'Encounters', 'Files', 'Sync', 'Keybinds', 'Access', 'Versions', 'Deleted Reviews', 'About']
const SAMPLE_PROJECT_NAME = '📘 Sample Tutorial Project'
>>>>>>> Stashed changes

const FILES_TOUR_STEPS = [
  {
    targetId: 'tut-files-base',
    placement: 'bottom',
    title: 'Why Linking Is Needed',
    body: "SDMo stores the project structure (encounters, media slots, reviews) in the cloud — but your actual video files stay on your own computer, never uploaded. Since file paths are device-specific, everyone on the team links their own local copies here. Set your base folder to get started.",
  },
  {
    targetId: 'tut-files-autolink',
    placement: 'bottom',
    title: 'Auto-link: Fastest Setup',
    body: "Point Auto-link at the folder where your local copy of the media lives. Its file structure should mirror the project's encounters and file names. SDMo scans it (and any subfolders) and links every matching file automatically — no manual locating needed.",
  },
  {
    targetId: 'tut-files-status',
    placement: 'top',
    title: 'Manual Linking',
    body: "See every media file and its link status on this machine. If Auto-link missed a file, use Link / Locate to browse to it manually. Mark N/A for files you intentionally don't have (they'll be skipped in your export).",
  },
]

export default function SetupPage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [section, setSection] = useState(() => {
    const s = new URLSearchParams(location.search).get('section')
    const n = parseInt(s, 10)
    return (!isNaN(n) && n >= 0 && n < SECTIONS.length) ? n : 0
  })
  const [project, setProject] = useState(null)
  const [forms, setForms] = useState([])
  const [instructions, setInstructions] = useState([])
  const [mediaTypes, setMediaTypes] = useState([])
  const [mediaFolder, setMediaFolder] = useState('')
  const [syncFolder, setSyncFolder] = useState('')
  const [keybinds, setKeybinds] = useState([])
  const [scanResult, setScanResult] = useState(null)
  const [encounters, setEncounters] = useState([])
  const [editingForm, setEditingForm] = useState(null)
  const [editingInstr, setEditingInstr] = useState(null)
  const [editingType, setEditingType] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const isSampleProject = project?.name === SAMPLE_PROJECT_NAME
  const filesTour = useTour(FILES_TOUR_STEPS, 'sdmo_tour_files_v1', {
    ready: section === 5 && !loading,
    autoStart: isSampleProject,
  })
  // Password / lock state
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [hasPassword, setHasPassword] = useState(false)
  const [showUnlock, setShowUnlock] = useState(false)
  const [unlockInput, setUnlockInput] = useState('')
  const [unlockError, setUnlockError] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPwConfirm, setNewPwConfirm] = useState('')
  const [pwSaved, setPwSaved] = useState(false)
  // Delete confirmation modal state
  const [deleteConfirm, setDeleteConfirm] = useState(null) // { type, item, count }
  const [deleteLoading, setDeleteLoading] = useState(false)
  // Per-project reviewer name
  const [projectReviewerName, setProjectReviewerName] = useState('')
  const [projectReviewerNameSaved, setProjectReviewerNameSaved] = useState(false)
  // Sync mode state
  const [syncMode, setSyncMode] = useState('none') // 'none' | 'local' | 'cloud'
  const [cloudStatus, setCloudStatus] = useState(null)
  const [cloudConnecting, setCloudConnecting] = useState(false)
  const [cloudError, setCloudError] = useState('')
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [folderPickerFolders, setFolderPickerFolders] = useState([])
  const [folderPickerParent, setFolderPickerParent] = useState(null)
  const [folderPickerLoading, setFolderPickerLoading] = useState(false)
  const [folderBreadcrumbs, setFolderBreadcrumbs] = useState([])
  const [folderLinkInput, setFolderLinkInput] = useState('')
  const [folderLinkError, setFolderLinkError] = useState('')
  const [folderLinkLoading, setFolderLinkLoading] = useState(false)
  // File linking
  const [baseFolder, setBaseFolder] = useState('')
  const [autolinkResult, setAutolinkResult] = useState(null)
  const [autolinking, setAutolinking] = useState(false)
  const [linkSaving, setLinkSaving] = useState(null) // mediaFileId being linked
  const forcedLockOnEntryRef = useRef(false)

  useEffect(() => {
    forcedLockOnEntryRef.current = false
    load()
  }, [projectId])

  async function load() {
    setLoading(true)
    const [proj, fs, ins, types, encs] = await Promise.all([
      api.getProject(projectId),
      api.listForms(projectId),
      api.listInstructions(projectId),
      api.listMediaTypes(projectId),
      api.listEncounters(projectId),
    ])
    // Load media files for each encounter
    const encsWithMedia = await Promise.all(
      (encs || []).map(async enc => ({
        ...enc,
        media: await api.listMediaFiles(enc.id),
      }))
    )
    setProject(proj)
    setForms(fs)
    setInstructions(ins)
    setMediaTypes(types)
    setEncounters(encsWithMedia)
    setMediaFolder(proj?.media_folder || '')
    setSyncFolder(proj?.sync_folder || '')
    setKeybinds(proj?.keybinds || [])
    // Load sync/cloud status
    const status = await api.getSyncStatus(Number(projectId))
    setSyncMode(status.syncMode || 'none')
    if (status.cloudProvider) {
      const [cs, folderName] = await Promise.all([
        api.cloudStatus(Number(projectId)),
        api.getCloudFolderName(Number(projectId)),
      ])
      setCloudStatus(cs ? { ...cs, folderName } : null)
    } else {
      setCloudStatus(null)
    }
    // Load per-project reviewer name
    const projName = await api.getProjectName(Number(projectId))
    setProjectReviewerName(projName || '')

    // Load base folder for file linking
    const bf = await api.getBaseFolder(Number(projectId))
    setBaseFolder(bf || '')

    const hasPw = proj?.has_password ?? false
    let unlocked = !hasPw || !!proj?.is_unlocked
    if (hasPw && !forcedLockOnEntryRef.current) {
      await api.lockProject(Number(projectId))
      forcedLockOnEntryRef.current = true
      unlocked = false
    }
    setHasPassword(hasPw)
    setIsUnlocked(unlocked)
    setShowUnlock(hasPw && !unlocked)
    setLoading(false)
  }

  async function handleUnlock(e) {
    e?.preventDefault()
    const ok = await api.verifyOwnerPassword(Number(projectId), unlockInput)
    if (ok) {
      setIsUnlocked(true)
      setShowUnlock(false)
      setUnlockInput('')
      setUnlockError('')
    } else {
      setUnlockError('Incorrect password')
    }
  }

  async function handleLock() {
    await api.lockProject(Number(projectId))
    setIsUnlocked(false)
  }

  async function handleSetPassword() {
    if (newPw !== newPwConfirm) return
    await api.setOwnerPassword(Number(projectId), newPw || null)
    setHasPassword(!!newPw)
    setIsUnlocked(true)
    setNewPw('')
    setNewPwConfirm('')
    setPwSaved(true)
    setTimeout(() => setPwSaved(false), 2000)
  }

  function handleEditorLocked() {
    setEditingForm(null)
    setEditingType(null)
    setEditingInstr(null)
    setIsUnlocked(false)
    setUnlockInput('')
    setUnlockError('')
    setShowUnlock(true)
  }

  async function handleSwitchMode(newMode) {
    // Disconnect old mode first
    if (syncMode === 'cloud' && cloudStatus?.connected) {
      await api.cloudDisconnect(Number(projectId))
      setCloudStatus(null)
    }
    if (syncMode === 'local') {
      await api.updateProject(projectId, { ...project, media_folder: mediaFolder, sync_folder: null, keybinds })
      setSyncFolder('')
    }
    setSyncMode(newMode)
  }

  async function handleCloudConnect(provider) {
    setCloudConnecting(true)
    setCloudError('')
    try {
      const result = provider === 'onedrive'
        ? await api.cloudConnectOneDrive()
        : await api.cloudConnectGoogleDrive()
      if (result.error) { setCloudError(result.error); return }
      // cloud_provider isn't in the DB yet (folder not selected), so build status manually
      setCloudStatus({ provider, connected: true, email: result.email || '', tokenExpired: false, cloudFolderId: null })
      setShowFolderPicker(true)
      setFolderBreadcrumbs([])
      handleLoadFolders(provider, null)
    } catch (e) {
      setCloudError(e.message || 'Connection failed')
    } finally {
      setCloudConnecting(false)
    }
  }

  async function handleFolderLinkSubmit() {
    setFolderLinkError('')
    setFolderLinkLoading(true)
    const result = await api.cloudResolveFolderLink(cloudStatus?.provider, folderLinkInput.trim())
    setFolderLinkLoading(false)
    if (result.error) { setFolderLinkError(result.error); return }
    await api.cloudSelectFolder(Number(projectId), cloudStatus?.provider, result.folderId)
    if (result.folderName) await api.setCloudFolderName(Number(projectId), result.folderName)
    setFolderLinkInput('')
    const [cs, folderName] = await Promise.all([
      api.cloudStatus(Number(projectId)),
      api.getCloudFolderName(Number(projectId)),
    ])
    setCloudStatus(cs ? { ...cs, folderName } : null)
    setSyncMode('cloud')
  }

  async function handleCancelAuth() {
    await api.cloudCancelAuth()
    setCloudConnecting(false)
    setCloudError('')
  }

  async function handleCloudDisconnect() {
    await api.cloudDisconnect(Number(projectId))
    setCloudStatus(null)
    setSyncMode('none')
    setCloudError('')
  }

  async function handleLoadFolders(provider, parentId) {
    setFolderPickerLoading(true)
    const result = await api.cloudListFolders(cloudStatus?.provider || provider, parentId)
    setFolderPickerFolders(result.folders || [])
    setFolderPickerParent(parentId)
    setFolderPickerLoading(false)
  }

  async function handleSelectCloudFolder(folder) {
    const folderId = folder.id || 'root'
    await api.cloudSelectFolder(Number(projectId), cloudStatus?.provider, folderId)
    if (folder.name) await api.setCloudFolderName(Number(projectId), folder.name)
    setShowFolderPicker(false)
    const cs = await api.cloudStatus(Number(projectId))
    setCloudStatus({ ...cs, folderName: folder.name })
    setSyncMode('cloud')
  }

  function handleFolderPickerDrillIn(folder) {
    setFolderBreadcrumbs(bc => [...bc, { id: folderPickerParent, name: bc.length === 0 ? 'Root' : folderPickerFolders.find(f => f.id === folderPickerParent)?.name }])
    handleLoadFolders(cloudStatus?.provider, folder.id)
  }

  function handleFolderPickerRefresh() {
    handleLoadFolders(cloudStatus?.provider, folderPickerParent)
  }

  function handleFolderPickerBack() {
    const prev = folderBreadcrumbs[folderBreadcrumbs.length - 1]
    setFolderBreadcrumbs(bc => bc.slice(0, -1))
    handleLoadFolders(cloudStatus?.provider, prev?.id || null)
  }

  async function handleSaveProjectReviewerName() {
    await api.setProjectName(Number(projectId), projectReviewerName.trim())
    setProjectReviewerNameSaved(true)
    setTimeout(() => setProjectReviewerNameSaved(false), 2000)
  }

  async function handleDeleteRequest(type, item) {
    setDeleteLoading(true)
    let count = 0
    if (type === 'form') count = await api.countFormResponses(item.id)
    if (type === 'mediaType') count = await api.countMediaTypeReviews(item.id)
    setDeleteLoading(false)
    setDeleteConfirm({ type, item, count })
  }

  async function handleDeleteConfirm() {
    if (!deleteConfirm) return
    const { type, item } = deleteConfirm
    setDeleteLoading(true)
    if (type === 'form') await api.deleteForm(projectId, item.id)
    if (type === 'instruction') await api.deleteInstruction(projectId, item.id)
    if (type === 'mediaType') await api.deleteMediaType(projectId, item.id)
    setDeleteLoading(false)
    setDeleteConfirm(null)
    load()
  }

  async function handleCreateMediaFile(encounterId, name) {
    await api.createMediaFile(projectId, encounterId, name)
    load()
  }

  async function handleBatchCreate(names, slots) {
    await api.batchCreateEncounters(projectId, names, slots)
    load()
  }

  async function handleExportStructure() {
    await api.exportStructure(projectId)
  }

  async function handleScanFolder() {
    if (!mediaFolder) return
    setSaving(true)
    const result = await api.scanMediaFolder(mediaFolder, projectId)
    setScanResult(result)
    setSaving(false)
    await load()
  }

  async function handleSaveKeybinds(newBinds) {
    setKeybinds(newBinds)
    await api.updateProject(projectId, { ...project, media_folder: mediaFolder, sync_folder: syncFolder, keybinds: newBinds })
  }

  async function handleSaveSyncFolder(folder) {
    setSyncFolder(folder)
    await api.updateProject(projectId, { ...project, media_folder: mediaFolder, sync_folder: folder, keybinds })
  }

  async function handleSelectSyncFolder() {
    const folder = await api.selectSyncFolder()
    if (folder) handleSaveSyncFolder(folder)
  }

  async function handleSelectFolder() {
    const path = await api.selectFolder()
    if (path) setMediaFolder(path)
  }

  async function handleSelectBaseFolder() {
    const p = await api.selectFolder()
    if (p) setBaseFolder(p)
  }

  async function handleSaveBaseFolder() {
    if (!baseFolder) return
    setSaving(true)
    await api.setBaseFolder(Number(projectId), baseFolder)
    setSaving(false)
    setAutolinkResult(null)
    load()
  }

  async function handleAutolink() {
    setAutolinking(true)
    setAutolinkResult(null)
    const result = await api.autolink(Number(projectId))
    setAutolinkResult(result)
    setAutolinking(false)
    load()
  }

  async function handleManualLink(mediaFileId) {
    setLinkSaving(mediaFileId)
    const filePath = await api.browseMediaFile(mediaFileId)
    if (filePath) {
      await api.setMediaLink(mediaFileId, Number(projectId), filePath)
      load()
    }
    setLinkSaving(null)
  }

  async function handleMarkNA(mediaFileId) {
    await api.markMediaNotApplicable(mediaFileId)
    load()
  }

  async function handleClearLink(mediaFileId) {
    await api.clearMediaLink(mediaFileId)
    load()
  }

  if (loading) return <div className="empty-state" style={{ height: '100vh' }}><div className="spinner" /></div>

  // Editing a form
  if (editingForm !== null) {
    return (
      <FormBuilder
        projectId={projectId}
        form={editingForm}
        onSave={async (saved) => { await load(); setEditingForm(null) }}
        onCancel={() => setEditingForm(null)}
        onLocked={handleEditorLocked}
      />
    )
  }

  // Editing an instruction
  if (editingInstr !== null) {
    return (
      <InstructionEditor
        projectId={projectId}
        instruction={editingInstr}
        onSave={async () => { await load(); setEditingInstr(null) }}
        onCancel={() => setEditingInstr(null)}
      />
    )
  }

  // Editing a media type
  if (editingType !== null) {
    return (
      <MediaTypeEditor
        projectId={projectId}
        mediaType={editingType}
        forms={forms}
        instructions={instructions}
        onSave={async () => { await load(); setEditingType(null) }}
        onCancel={() => setEditingType(null)}
        onLocked={handleEditorLocked}
      />
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Top bar */}
      <div style={{
        height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 20px', borderBottom: '1px solid var(--border)',
        WebkitAppRegion: 'drag', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' }}>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => navigate(`/project/${projectId}`)}>
            <ChevronLeft size={16} />
          </button>
          <span className="text-secondary text-sm">{project?.name}</span>
          <ChevronRight size={12} color="var(--text-muted)" />
          <span style={{ fontWeight: 600, fontSize: 14 }}>Setup</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', WebkitAppRegion: 'no-drag' }}>
          {hasPassword && isUnlocked && (
            <button className="btn btn-secondary btn-sm" onClick={handleLock} title="Lock setup">
              <Lock size={13} /> Lock
            </button>
          )}
          {hasPassword && !isUnlocked && (
            <button className="btn btn-secondary btn-sm" onClick={() => { setUnlockInput(''); setUnlockError(''); setShowUnlock(true) }}>
              <Unlock size={13} /> Unlock
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => navigate(`/project/${projectId}`)}>
            <Check size={13} /> Done
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar nav */}
        <div style={{ width: 200, borderRight: '1px solid var(--border)', padding: '16px 0', flexShrink: 0 }}>
          {SECTIONS.map((s, i) => (
            <button
              key={s}
              onClick={() => setSection(i)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '8px 16px', border: 'none',
                background: section === i ? 'var(--accent-light)' : 'transparent',
                color: section === i ? 'var(--accent)' : 'var(--text)',
                fontWeight: section === i ? 600 : 400, fontSize: 13,
                cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font)',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '28px 32px' }}>
          {!isUnlocked && hasPassword && (
            <div style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '10px 14px', marginBottom: 20, fontSize: 13, color: 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <Lock size={14} color="var(--text-muted)" />
              <span>This project is owner-locked. Enter the owner password to edit settings.</span>
              <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => { setUnlockInput(''); setUnlockError(''); setShowUnlock(true) }}>
                <Unlock size={12} /> Unlock
              </button>
            </div>
          )}
          {section === 0 && <OverviewSection />}

          {section === 1 && (
            <SetupSection
              title="Forms"
              description="Create forms for coders to fill out during review. Forms are composed of sections with questions."
              items={forms}
              locked={!isUnlocked}
              onNew={() => setEditingForm({ id: null, name: '', schema: { sections: [] } })}
              onEdit={async (f) => { const full = await api.getForm(f.id); setEditingForm(full) }}
              onDuplicate={async (f) => {
                const full = await api.getForm(f.id)
                await api.saveForm(projectId, { name: `${full.name} (copy)`, schema: full.schema })
                load()
              }}
              onDelete={(f) => handleDeleteRequest('form', f)}
              newLabel="New Form"
            />
          )}

          {section === 2 && (
            <SetupSection
              title="Instructions"
              description="Write instruction pages in Markdown. These can be added as tabs in the workspace."
              items={instructions}
              locked={!isUnlocked}
              onNew={() => setEditingInstr({ id: null, name: '', content: '' })}
              onEdit={(i) => setEditingInstr(i)}
              onDuplicate={async (i) => {
                await api.saveInstruction(projectId, { name: `${i.name} (copy)`, content: i.content })
                load()
              }}
              onDelete={(i) => setDeleteConfirm({ type: 'instruction', item: i, count: 0 })}
              newLabel="New Instruction Page"
            />
          )}

          {section === 3 && (
            <SetupSection
              title="Media Types"
              description="Define types of media (e.g. 'Consultation Video', 'Debrief Audio'). Each type sets review requirements, timestamp tags, and the workspace layout."
              items={mediaTypes}
              locked={!isUnlocked}
              onNew={() => setEditingType({ id: null, name: '', reviews_required: 1, allow_custom_tags: true, color: '#6366f1', tags: [], workspace_tabs: [] })}
              onEdit={(t) => setEditingType(t)}
              onDuplicate={async (t) => {
                await api.saveMediaType(projectId, { ...t, id: null, name: `${t.name} (copy)` })
                load()
              }}
              onDelete={(t) => handleDeleteRequest('mediaType', t)}
              newLabel="New Media Type"
            />
          )}

          {section === 4 && (
            <MediaFilesSection
              project={project}
              encounters={encounters}
              mediaTypes={mediaTypes}
              locked={!isUnlocked}
              hasPassword={hasPassword}
              projectId={projectId}
              mediaFolder={mediaFolder}
              setMediaFolder={setMediaFolder}
              saving={saving}
              scanResult={scanResult}
              onReload={load}
              onTypeChange={load}
              onAddFile={handleCreateMediaFile}
              onBatchCreate={handleBatchCreate}
              onExportStructure={handleExportStructure}
              onSelectFolder={handleSelectFolder}
              onHandleScanFolder={handleScanFolder}
            />
          )}

          {section === 6 && (
            <SyncSection
              syncMode={syncMode}
              syncFolder={syncFolder}
              setSyncFolder={setSyncFolder}
              cloudStatus={cloudStatus}
              cloudConnecting={cloudConnecting}
              cloudError={cloudError}
              showFolderPicker={showFolderPicker}
              setShowFolderPicker={setShowFolderPicker}
              folderPickerFolders={folderPickerFolders}
              folderPickerParent={folderPickerParent}
              folderPickerLoading={folderPickerLoading}
              folderBreadcrumbs={folderBreadcrumbs}
              onSwitchMode={handleSwitchMode}
              onSaveSyncFolder={handleSaveSyncFolder}
              onSelectSyncFolder={handleSelectSyncFolder}
              onCloudConnect={handleCloudConnect}
              onCancelAuth={handleCancelAuth}
              onCloudDisconnect={handleCloudDisconnect}
              onSelectCloudFolder={handleSelectCloudFolder}
              onDrillIn={handleFolderPickerDrillIn}
              onFolderBack={handleFolderPickerBack}
              onFolderRefresh={handleFolderPickerRefresh}
              folderLinkInput={folderLinkInput}
              setFolderLinkInput={setFolderLinkInput}
              folderLinkError={folderLinkError}
              folderLinkLoading={folderLinkLoading}
              onFolderLinkSubmit={handleFolderLinkSubmit}
              isOwner={isUnlocked}
              hasPassword={hasPassword}
            />
          )}

          {section === 7 && (
            <KeybindsEditor
              keybinds={keybinds}
              mediaTypes={mediaTypes}
              onChange={handleSaveKeybinds}
            />
          )}

          {section === 8 && (
            <div style={{ maxWidth: 480 }}>
              <h2 style={{ marginBottom: 6 }}>Access</h2>

              {/* Per-project reviewer name */}
              <div style={{ marginBottom: 28, padding: '16px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <User size={15} color="var(--accent)" />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>Your Name for This Project</span>
                </div>
                <p className="text-secondary" style={{ fontSize: 13, marginBottom: 12 }}>
                  This name appears on your reviews and is used to match your data across devices. Use the same name every time — even a small spelling difference will create a separate reviewer record.
                  {' '}<strong>If multiple people share this computer</strong>, each person should set their own name here before creating reviews.
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    value={projectReviewerName}
                    onChange={e => { setProjectReviewerName(e.target.value); setProjectReviewerNameSaved(false) }}
                    placeholder="e.g. Alice Chen"
                    style={{ flex: 1 }}
                    onKeyDown={e => e.key === 'Enter' && handleSaveProjectReviewerName()}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleSaveProjectReviewerName}
                    disabled={!projectReviewerName.trim()}
                  >
                    Save
                  </button>
                  {projectReviewerNameSaved && <span className="text-sm" style={{ color: 'var(--success)' }}>Saved</span>}
                </div>
              </div>

              <p className="text-secondary" style={{ marginBottom: 20, fontSize: 13 }}>
                Set an owner password to lock project settings. Anyone who knows the password can unlock and edit settings. Leave blank to remove the password.
              </p>
              {!isUnlocked ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8 }}>
                  <Lock size={16} color="var(--text-muted)" />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Unlock to manage the owner password.</span>
                  <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => { setUnlockInput(''); setUnlockError(''); setShowUnlock(true) }}>
                    <Unlock size={12} /> Unlock
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div className="form-field">
                    <label>{hasPassword ? 'New password' : 'Set password'}</label>
                    <input
                      type="password"
                      placeholder={hasPassword ? 'Enter new password (blank to remove)' : 'Enter a password'}
                      value={newPw}
                      onChange={e => { setNewPw(e.target.value); setPwSaved(false) }}
                    />
                  </div>
                  {newPw && (
                    <div className="form-field">
                      <label>Confirm password</label>
                      <input
                        type="password"
                        placeholder="Re-enter password"
                        value={newPwConfirm}
                        onChange={e => setNewPwConfirm(e.target.value)}
                      />
                      {newPwConfirm && newPw !== newPwConfirm && (
                        <span className="text-sm" style={{ color: 'var(--danger)', marginTop: 4 }}>Passwords don't match</span>
                      )}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      className="btn btn-primary"
                      onClick={handleSetPassword}
                      disabled={newPw !== newPwConfirm || (newPw === '' && !hasPassword)}
                    >
                      {newPw ? 'Set Password' : 'Remove Password'}
                    </button>
                    {pwSaved && <span className="text-sm" style={{ color: 'var(--success)' }}>Saved</span>}
                  </div>
                  {hasPassword && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <p className="text-muted text-sm">
                        The password syncs to all machines — everyone will need it to edit settings.
                      </p>
                      <p className="text-muted text-sm">
                        <strong>On another computer:</strong> open Settings, enter your password at the unlock prompt. The machine will remember you until the app is restarted.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {section === 5 && (
            <div style={{ maxWidth: 600 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <h2 style={{ margin: 0 }}>Files</h2>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={filesTour.start} title="Show tutorial">
                  <HelpCircle size={15} />
                </button>
              </div>
              <p className="text-secondary" style={{ marginBottom: 24, fontSize: 13 }}>
                Link your local media files to this project. The app reads files directly — nothing is copied or uploaded.
              </p>

              {/* ── YOUR LOCAL FILES (all users) ── */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 28 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Your Files on This Machine</h3>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                  Set a base folder and click <strong>Auto-link</strong> — the app will match files by name. You can also link individual files manually below.
                </p>
                <div id="tut-files-base" className="form-field">
                  <label>Base Folder</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input value={baseFolder} onChange={e => setBaseFolder(e.target.value)} placeholder="/path/to/your/media/folder" />
                    <button className="btn btn-secondary" style={{ flexShrink: 0 }} onClick={handleSelectBaseFolder}>
                      <FolderOpen size={14} /> Browse
                    </button>
                  </div>
                  <span className="text-muted text-sm" style={{ marginTop: 4 }}>
                    Auto-link searches this folder (and any subfolders) for files matching the project's media names.
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-secondary" onClick={handleSaveBaseFolder} disabled={!baseFolder || saving}>
                    {saving ? 'Saving…' : 'Save Base Folder'}
                  </button>
                  <button id="tut-files-autolink" className="btn btn-primary" onClick={handleAutolink} disabled={!baseFolder || autolinking}>
                    <RefreshCw size={13} style={{ animation: autolinking ? 'spin 1s linear infinite' : 'none' }} />
                    {autolinking ? 'Linking…' : 'Auto-link Files'}
                  </button>
                </div>
                {autolinkResult && !autolinkResult.error && (
                  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
                    {autolinkResult.linked > 0
                      ? <span style={{ color: 'var(--success)' }}>✓ {autolinkResult.linked} file{autolinkResult.linked !== 1 ? 's' : ''} linked</span>
                      : <span style={{ color: 'var(--text-muted)' }}>No new files linked</span>}
                    {autolinkResult.skipped > 0 && <span style={{ color: 'var(--text-muted)', marginLeft: 10 }}>· {autolinkResult.skipped} already linked</span>}
                    {autolinkResult.ambiguous > 0 && <span style={{ color: '#d97706', marginLeft: 10 }}>· {autolinkResult.ambiguous} ambiguous (multiple matches) — link manually below</span>}
                    {autolinkResult.notFound > 0 && <span style={{ color: 'var(--text-muted)', marginLeft: 10 }}>· {autolinkResult.notFound} not found in folder</span>}
                  </div>
                )}
                {autolinkResult?.error && (
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#b91c1c' }}>
                    {autolinkResult.error}
                  </div>
                )}
              </div>

              {/* ── PER-FILE LINK STATUS ── */}
              {encounters.length > 0 && (
                <div id="tut-files-status" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>File Link Status</h3>
                  {encounters.map(enc => (
                    <div key={enc.id} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                      <div style={{ padding: '8px 12px', background: 'var(--bg-secondary)', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                        {enc.name}
                      </div>
                      {(enc.media || []).length === 0 && (
                        <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--text-muted)' }}>No media files</div>
                      )}
                      {(enc.media || []).map(mf => {
                        const status = mf.link_status || 'not_linked'
                        const busy = linkSaving === mf.id
                        return (
                          <div key={mf.id} style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                            <LinkStatusDot status={status} />
                            <span style={{ fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mf.name}</span>
                            <span style={{ fontSize: 11, color: statusColor(status), flexShrink: 0 }}>
                              {status === 'linked' ? 'Linked' : status === 'missing' ? 'File missing' : status === 'not_applicable' ? 'N/A' : 'Not linked'}
                            </span>
                            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                              {status !== 'not_applicable' && (
                                <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', height: 22 }}
                                  onClick={() => handleManualLink(mf.id)} disabled={busy}>
                                  {busy ? '…' : status === 'linked' ? 'Relink' : status === 'missing' ? 'Locate' : 'Link'}
                                </button>
                              )}
                              {status !== 'not_applicable' && (
                                <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', height: 22, color: 'var(--text-muted)' }}
                                  onClick={() => handleMarkNA(mf.id)} title="Mark as not applicable — I don't have this file">
                                  N/A
                                </button>
                              )}
                              {status === 'not_applicable' && (
                                <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', height: 22 }}
                                  onClick={() => handleClearLink(mf.id)}>
                                  Clear
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              )}

            </div>
          )}

          {section === 9 && (
            <VersionManagementSection projectId={projectId} forms={forms} mediaTypes={mediaTypes} locked={!isUnlocked} onChanged={load} />
          )}

          {section === 10 && (
            <DeletedReviewsSection projectId={projectId} />
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <Modal
        open={!!deleteConfirm}
        onClose={() => !deleteLoading && setDeleteConfirm(null)}
        title={`${deleteConfirm?.count > 0 && deleteConfirm?.type !== 'instruction' ? 'Archive' : 'Delete'} ${deleteConfirm?.type === 'form' ? 'Form' : deleteConfirm?.type === 'instruction' ? 'Instruction' : 'Media Type'}`}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)} disabled={deleteLoading}>Cancel</button>
            <button className="btn btn-danger" onClick={handleDeleteConfirm} disabled={deleteLoading}>
              {deleteLoading ? 'Working…' : deleteConfirm?.count > 0 && deleteConfirm?.type !== 'instruction' ? 'Archive' : 'Delete'}
            </button>
          </>
        }
      >
        {deleteConfirm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p>Delete <strong>{deleteConfirm.item.name}</strong>?</p>
            {deleteConfirm.type === 'mediaType' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {deleteConfirm.count > 0 && (
                  <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#92400e', display: 'flex', gap: 8 }}>
                    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span><strong>{deleteConfirm.count} review{deleteConfirm.count !== 1 ? 's' : ''}</strong> exist on files assigned to this type. This media type will be archived for existing reviews and hidden from new setup choices.</span>
                  </div>
                )}
                {deleteConfirm.count === 0 && (
                  <p className="text-secondary" style={{ fontSize: 13 }}>No reviews exist for this type. Only its tag definitions and workspace layout will be removed.</p>
                )}
              </div>
            )}
            {deleteConfirm.type === 'form' && deleteConfirm.count > 0 && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#b91c1c', display: 'flex', gap: 8 }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <span><strong>{deleteConfirm.count} saved response{deleteConfirm.count !== 1 ? 's' : ''}</strong> use this form. The form will be archived and removed from future workspaces, but existing answers are kept for export and review history.</span>
              </div>
            )}
            {deleteConfirm.type === 'form' && deleteConfirm.count === 0 && (
              <p className="text-secondary" style={{ fontSize: 13 }}>No responses have been saved for this form. It is safe to delete.</p>
            )}
            {deleteConfirm.type === 'instruction' && (
              <p className="text-secondary" style={{ fontSize: 13 }}>This instruction page will be removed from all media type workspaces that reference it.</p>
            )}
          </div>
        )}
      </Modal>

      {/* Unlock Modal */}
      <Modal
        open={showUnlock}
        onClose={() => setShowUnlock(false)}
        title="Owner Password"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowUnlock(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleUnlock} disabled={!unlockInput}>Unlock</button>
          </>
        }
      >
        <form onSubmit={handleUnlock} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Enter the owner password to edit project settings.</p>
          <div className="form-field">
            <label>Password</label>
            <input
              type="password"
              autoFocus
              placeholder="Owner password"
              value={unlockInput}
              onChange={e => { setUnlockInput(e.target.value); setUnlockError('') }}
            />
            {unlockError && <span className="text-sm" style={{ color: 'var(--danger)', marginTop: 4 }}>{unlockError}</span>}
          </div>
        </form>
      </Modal>

      {filesTour.node}
    </div>
  )
}

function VersionManagementSection({ projectId, forms, mediaTypes, locked, onChanged }) {
  const [pending, setPending] = useState(null)
  const [restorePending, setRestorePending] = useState(null)
  const [history, setHistory] = useState({})
  const [expanded, setExpanded] = useState({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function openMigration(kind, item, scope) {
    setBusy(true)
    setMessage('')
    try {
      const preview = await api.previewStructureMigration(projectId, { kind, id: item.id, scope })
      setPending({ kind, item, scope, preview })
    } catch (e) {
      console.error('[VersionManagement] preview failed:', e)
      setMessage(e?.message || 'Could not check review versions.')
    } finally {
      setBusy(false)
    }
  }

  async function applyMigration() {
    if (!pending) return
    setBusy(true)
    setMessage('')
    try {
      const result = await api.migrateStructureReviews(projectId, { kind: pending.kind, id: pending.item.id, scope: pending.scope })
      setMessage(`Updated ${result.updated || 0} review${result.updated === 1 ? '' : 's'}.`)
      setPending(null)
    } catch (e) {
      console.error('[VersionManagement] migration failed:', e)
      setMessage(e?.message || 'Could not update review versions.')
    } finally {
      setBusy(false)
    }
  }

  async function toggleHistory(kind, item) {
    const key = `${kind}:${item.id}`
    if (expanded[key]) {
      setExpanded(prev => ({ ...prev, [key]: false }))
      return
    }
    setExpanded(prev => ({ ...prev, [key]: true }))
    if (history[key]) return
    setBusy(true)
    setMessage('')
    try {
      const rows = await api.listVersionHistory(projectId, { kind, id: item.id })
      setHistory(prev => ({ ...prev, [key]: rows }))
    } catch (e) {
      console.error('[VersionManagement] history failed:', e)
      setMessage(e?.message || 'Could not load version history.')
    } finally {
      setBusy(false)
    }
  }

  async function restoreVersion() {
    if (!restorePending) return
    const { kind, item, version } = restorePending
    const key = `${kind}:${item.id}`
    setBusy(true)
    setMessage('')
    try {
      const result = await api.restoreVersion(projectId, { kind, id: item.id, version })
      setHistory(prev => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      setMessage(`Restored ${item.name} v${version} as version ${result.current_version}.`)
      await onChanged?.()
      setRestorePending(null)
    } catch (e) {
      console.error('[VersionManagement] restore failed:', e)
      setMessage(e?.message || 'Could not restore that version.')
    } finally {
      setBusy(false)
    }
  }

  function versionSummary(kind, row) {
    if (kind === 'form') {
      const sections = row.schema?.sections || []
      const questions = sections.reduce((n, s) => n + (s.elements || []).length, 0)
      return `${sections.length} section${sections.length === 1 ? '' : 's'}, ${questions} item${questions === 1 ? '' : 's'}`
    }
    const tags = row.config?.tags || []
    const tabs = row.config?.workspace_tabs || []
    return `${tags.length} tag${tags.length === 1 ? '' : 's'}, ${tabs.length} workspace tab${tabs.length === 1 ? '' : 's'}`
  }

  function rows(kind, items) {
    return items.map(item => {
      const key = `${kind}:${item.id}`
      const isExpanded = !!expanded[key]
      const versions = history[key] || []
      return (
        <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{item.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Version {kind === 'form' ? item.schema_version || 1 : item.config_version || 1}
              </div>
            </div>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => toggleHistory(kind, item)}>
              {isExpanded ? 'Hide History' : 'History'}
            </button>
            <button className="btn btn-secondary btn-sm" disabled={busy || locked} onClick={() => openMigration(kind, item, 'drafts')}>
              Update Drafts
            </button>
            <button className="btn btn-danger btn-sm" disabled={busy || locked} onClick={() => openMigration(kind, item, 'all')}>
              Update All
            </button>
          </div>
          {isExpanded && (
            <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {versions.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No saved prior versions yet.</div>}
              {versions.map(v => (
                <div key={`${key}:v${v.version}:${v.is_current ? 'current' : 'old'}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      Version {v.version}{v.is_current ? ' · Current' : ''}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {versionSummary(kind, v)}
                    </div>
                  </div>
                  {!v.is_current && (
                    <button className="btn btn-secondary btn-sm" disabled={busy || locked} onClick={() => setRestorePending({ kind, item, version: v.version })}>
                      Restore
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )
    })
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={{ marginBottom: 4 }}>Versions</h2>
      <p className="text-secondary" style={{ fontSize: 13, marginBottom: 20 }}>
        Move existing reviews onto the current form or media type version. New reviews already use the latest version automatically.
      </p>
      {locked && (
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Unlock the project to migrate review versions.
        </div>
      )}
      {message && (
        <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 16 }}>
          {message}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <section>
          <h3 style={{ marginBottom: 10 }}>Forms</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{rows('form', forms)}</div>
        </section>
        <section>
          <h3 style={{ marginBottom: 10 }}>Media Types</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{rows('mediaType', mediaTypes)}</div>
        </section>
      </div>

      <Modal
        open={!!pending}
        onClose={() => !busy && setPending(null)}
        title={pending?.scope === 'all' ? 'Update All Reviews?' : 'Update Draft Reviews?'}
        footer={
          <>
            <button className="btn btn-secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
            <button className={pending?.scope === 'all' ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy || (pending?.preview?.total || 0) === 0} onClick={applyMigration}>
              {busy ? 'Updating…' : pending?.scope === 'all' ? 'Update All Reviews' : 'Update Drafts'}
            </button>
          </>
        }
      >
        {pending && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, lineHeight: 1.5 }}>
            <p style={{ margin: 0 }}>
              <strong>{pending.item.name}</strong> will be applied to <strong>{pending.preview.total}</strong> matching review{pending.preview.total !== 1 ? 's' : ''}.
            </p>
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
              <div><strong>{pending.preview.drafts}</strong> draft review{pending.preview.drafts !== 1 ? 's' : ''}</div>
              <div><strong>{pending.preview.submitted}</strong> submitted review{pending.preview.submitted !== 1 ? 's' : ''}</div>
            </div>
            {pending.scope === 'all' && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, color: '#991b1b' }}>
                This changes version metadata used to interpret submitted reviews. Answers are preserved, but this should be treated as a deliberate research-data migration.
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={!!restorePending}
        onClose={() => !busy && setRestorePending(null)}
        title="Restore Version?"
        footer={
          <>
            <button className="btn btn-secondary" disabled={busy} onClick={() => setRestorePending(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || locked} onClick={restoreVersion}>
              {busy ? 'Restoring…' : 'Restore as Latest'}
            </button>
          </>
        }
      >
        {restorePending && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, lineHeight: 1.5 }}>
            <p style={{ margin: 0 }}>
              Restore <strong>{restorePending.item.name}</strong> version <strong>{restorePending.version}</strong> as the new latest version.
            </p>
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
              Existing reviews keep their current snapshots until you use Update Drafts or Update All.
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function DeletedReviewsSection({ projectId }) {
  const [deleted, setDeleted] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.listDeletedReviews(projectId).then(rows => { setDeleted(rows); setLoading(false) })
  }, [projectId])

  async function handleRestore(id) {
    await api.restoreReview(id)
    setDeleted(d => d.filter(r => r.id !== id))
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h2 style={{ marginBottom: 6 }}>Deleted Reviews</h2>
      <p className="text-secondary" style={{ marginBottom: 20, fontSize: 13 }}>
        Reviews deleted from this project. You can restore them — restoring removes the deletion from sync so other machines keep the review too.
      </p>
      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : deleted.length === 0 ? (
        <div className="empty-state" style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '40px 20px' }}>
          <p className="text-sm">No deleted reviews.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {deleted.map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{r.reviewer_name}</div>
                <div className="text-muted text-sm" style={{ marginTop: 2 }}>
                  {r.encounter_name} / {r.media_name} · {r.status} · deleted {new Date(r.deleted_at).toLocaleDateString()}
                </div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => handleRestore(r.id)}>
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MediaFilesSection({
  project, encounters, mediaTypes, locked, hasPassword, projectId, mediaFolder, setMediaFolder,
  saving, scanResult, onReload, onTypeChange, onAddFile, onBatchCreate, onExportStructure,
  onSelectFolder, onHandleScanFolder,
}) {
  const [renaming, setRenaming] = useState(null) // { type: 'encounter'|'file', id, projectId, name }
  const [deleteTarget, setDeleteTarget] = useState(null) // { type, id, name, reviewCount }
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [showAddEncounter, setShowAddEncounter] = useState(false)
  const [newEncounterName, setNewEncounterName] = useState('')
  const [showAddFile, setShowAddFile] = useState(false)
  const [addFileEncounterId, setAddFileEncounterId] = useState(null)
  const [newFileName, setNewFileName] = useState('')
  const [showBatchAdd, setShowBatchAdd] = useState(false)
  const [importPreview, setImportPreview] = useState(null)
  const [importingFile, setImportingFile] = useState(false)
  const [applyingImport, setApplyingImport] = useState(false)
  const isOwner = !locked

  // ── Multi-select for bulk delete / set media type ──
  const [selEnc, setSelEnc] = useState(() => new Set())
  const [selFiles, setSelFiles] = useState(() => new Set())
  const [bulkType, setBulkType] = useState('')
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const selCount = selEnc.size + selFiles.size

  function toggleEnc(id) {
    setSelEnc(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleFile(id) {
    setSelFiles(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function clearSelection() { setSelEnc(new Set()); setSelFiles(new Set()); setBulkType('') }

  async function handleBulkSetType() {
    if (!selFiles.size || !bulkType) return
    const typeArg = bulkType === '__none__' ? null : Number(bulkType)
    setBulkBusy(true)
    await api.bulkUpdateMediaType(projectId, [...selFiles], typeArg)
    setBulkBusy(false)
    clearSelection()
    onReload()
  }

  async function handleBulkDeleteConfirm() {
    setBulkBusy(true)
    // Files under a selected encounter are removed by the cascade, so only delete
    // files whose encounter isn't itself selected.
    const fileIds = [...selFiles].filter(fid => {
      const enc = encounters.find(e => (e.media || []).some(m => m.id === fid))
      return !enc || !selEnc.has(enc.id)
    })
    if (selEnc.size) await api.bulkDeleteEncounters(projectId, [...selEnc])
    if (fileIds.length) await api.bulkDeleteMediaFiles(projectId, fileIds)
    setBulkBusy(false)
    setBulkDeleteOpen(false)
    clearSelection()
    onReload()
  }

  async function handleTypeChange(mediaFile, newVal) {
    await api.updateMediaType(mediaFile.id, newVal || null)
    onTypeChange()
  }

  async function handleRenameCommit() {
    if (!renaming || !renaming.name.trim()) { setRenaming(null); return }
    if (renaming.type === 'encounter') {
      await api.renameEncounter(projectId, renaming.id, renaming.name)
    } else {
      await api.renameMediaFile(projectId, renaming.id, renaming.name)
    }
    setRenaming(null)
    onReload()
  }

  async function handleDeleteClick(type, item) {
    const count = type === 'encounter'
      ? await api.countEncounterReviews(item.id)
      : await api.countMediaReviews(item.id)
    setDeleteTarget({ type, id: item.id, name: item.name, reviewCount: count })
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return
    setDeleteLoading(true)
    if (deleteTarget.type === 'encounter') {
      await api.deleteEncounter(projectId, deleteTarget.id)
    } else {
      await api.deleteMediaFile(projectId, deleteTarget.id)
    }
    setDeleteLoading(false)
    setDeleteTarget(null)
    onReload()
  }

  async function handleAddEncounter() {
    if (!newEncounterName.trim()) return
    await api.createEncounter(projectId, newEncounterName.trim())
    setNewEncounterName('')
    setShowAddEncounter(false)
    onReload()
  }

  async function handleAddFile() {
    if (!newFileName.trim() || !addFileEncounterId) return
    await onAddFile(addFileEncounterId, newFileName.trim())
    setNewFileName('')
    setShowAddFile(false)
    setAddFileEncounterId(null)
  }

  async function handleImportFromFile() {
    setImportingFile(true)
    const preview = await api.previewImport(projectId)
    setImportingFile(false)
    if (preview) setImportPreview(preview)
  }

  async function handleApplyImport() {
    if (!importPreview) return
    setApplyingImport(true)
    try {
      await api.applyImport(projectId, importPreview.toCreate, importPreview.toAddFiles)
      setImportPreview(null)
      onReload()
    } catch (err) {
      console.error('Import failed:', err)
    } finally {
      setApplyingImport(false)
    }
  }

  async function handleMove(mediaFileId, newEncounterId) {
    await api.moveMediaFile(projectId, mediaFileId, parseInt(newEncounterId))
    onReload()
  }

  const TrashIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
    </svg>
  )

  return (
    <div style={{ maxWidth: 980, width: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 6, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, flexShrink: 0 }}>Encounters</h2>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {isOwner && (
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => { setNewEncounterName(''); setShowAddEncounter(true) }}>
                + Add Encounter
              </button>
            </>
          )}
        </div>
      </div>
      <p className="text-secondary" style={{ marginBottom: 20, fontSize: 13 }}>
        {isOwner
          ? 'Import your folder structure, then manage encounters and media file slots here. Scans only add new items or relink missing ones; they do not delete existing review data.'
          : 'Assign a media type to each file slot. The type determines how many reviews are required and which tags are available.'}
      </p>

      {isOwner && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 16, background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Import or Scan Folder</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
              Point SDMo at your encounter folder once, then rescan it anytime new encounters or files appear. Each subfolder becomes an encounter; files inside become media files.
            </p>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>Source Folder</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input value={mediaFolder} onChange={e => setMediaFolder(e.target.value)} placeholder="/path/to/media/folder" style={{ flex: '1 1 320px', minWidth: 240 }} />
              <button className="btn btn-secondary" style={{ flexShrink: 0 }} onClick={onSelectFolder}>
                <FolderOpen size={14} /> Browse
              </button>
            </div>
            <span className="text-muted text-sm" style={{ marginTop: 4 }}>Expected: ScanFolder / EncounterName / mediafile.mp4</span>
          </div>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--text-secondary)' }}>
            Scans are additive. They create new encounters and file slots, and can relink missing files, but they do not delete encounters, files, or reviews already in the project.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={async () => {
              if (!mediaFolder) return
              await api.updateProject(projectId, { ...project, media_folder: mediaFolder })
              onReload()
            }} disabled={!mediaFolder || saving}>
              {saving ? 'Saving…' : 'Save Folder'}
            </button>
            <button className="btn btn-primary" onClick={onHandleScanFolder} disabled={!mediaFolder || saving}>
              {saving ? 'Scanning…' : 'Scan for New Encounters'}
            </button>
          </div>
          {scanResult && <ScanResultSummary scanResult={scanResult} />}
        </div>
      )}

      {isOwner && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 16, background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Manual Tools</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
              Use these when you need to add or import structure outside the normal folder scan workflow.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowBatchAdd(true)}>
              Batch Add
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleImportFromFile} disabled={importingFile} title="Import encounter names from a spreadsheet or CSV">
              {importingFile ? 'Reading…' : 'Import from File'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onExportStructure} title="Export encounter/file structure to Excel">
              Export Excel
            </button>
          </div>
        </div>
      )}

      {encounters.length === 0 ? (
        <div className="empty-state" style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '40px 20px' }}>
          <p className="text-sm">{isOwner ? 'No encounters yet. Use "+ Add Encounter", "Batch Add", or scan a folder above.' : 'No encounters yet.'}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {encounters.map(enc => (
            <div key={enc.id} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '8px 14px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
                {isOwner && (
                  <input type="checkbox" checked={selEnc.has(enc.id)} onChange={() => toggleEnc(enc.id)}
                    title="Select encounter for bulk actions" style={{ width: 16, height: 16, cursor: 'pointer', margin: 0, flex: '0 0 16px' }} />
                )}
                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                  {renaming?.type === 'encounter' && renaming.id === enc.id ? (
                    <input autoFocus value={renaming.name}
                      onChange={e => setRenaming(r => ({ ...r, name: e.target.value }))}
                      onBlur={handleRenameCommit}
                      onKeyDown={e => { if (e.key === 'Enter') handleRenameCommit(); if (e.key === 'Escape') setRenaming(null) }}
                      style={{ fontSize: 12, fontWeight: 600, width: '100%', minWidth: 0, padding: '1px 6px', height: 24 }}
                    />
                  ) : (
                    <span
                      style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', minWidth: 0, cursor: isOwner ? 'text' : 'default' }}
                      className="truncate"
                      onClick={() => isOwner && setRenaming({ type: 'encounter', id: enc.id, name: enc.name })}
                      title={isOwner ? 'Click to rename' : undefined}
                    >{enc.name}</span>
                  )}
                </div>
                {isOwner && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', marginLeft: 'auto', maxWidth: '100%' }}>
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', height: 22, flexShrink: 0 }}
                      onClick={() => { setNewFileName(''); setAddFileEncounterId(enc.id); setShowAddFile(true) }}
                      title="Add media file slot to this encounter">
                      + File
                    </button>
                    <button className="btn btn-ghost btn-icon btn-sm" title="Delete encounter"
                      onClick={() => handleDeleteClick('encounter', enc)}
                      style={{ color: 'var(--danger)', opacity: 0.6, flexShrink: 0 }}>
                      <TrashIcon />
                    </button>
                  </div>
                )}
              </div>

              {(enc.media || []).length === 0 ? (
                <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text-muted)' }}>No media files</div>
              ) : enc.media.map(m => (
                <div
                  key={m.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 12,
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--border)',
                    background: selFiles.has(m.id) ? 'var(--bg-secondary)' : undefined,
                    minWidth: 0,
                  }}
                >
                  {isOwner && (
                    <input type="checkbox" checked={selFiles.has(m.id)} onChange={() => toggleFile(m.id)}
                      title="Select file for bulk actions" style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                  )}
                  <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                    {renaming?.type === 'file' && renaming.id === m.id ? (
                      <input autoFocus value={renaming.name}
                        onChange={e => setRenaming(r => ({ ...r, name: e.target.value }))}
                        onBlur={handleRenameCommit}
                        onKeyDown={e => { if (e.key === 'Enter') handleRenameCommit(); if (e.key === 'Escape') setRenaming(null) }}
                        style={{ fontSize: 13, fontWeight: 500, width: '100%', minWidth: 0, padding: '1px 6px', height: 26 }}
                      />
                    ) : (
                      <span
                        style={{ display: 'block', fontSize: 13, fontWeight: 500, minWidth: 0, cursor: isOwner ? 'text' : 'default' }}
                        className="truncate"
                        onClick={() => isOwner && setRenaming({ type: 'file', id: m.id, name: m.name })}
                        title={isOwner ? 'Click to rename' : m.name}
                      >{m.name}</span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0, marginLeft: 'auto', maxWidth: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
                      {isOwner && encounters.length > 1 && (
                        <select
                          value={enc.id}
                          onChange={e => handleMove(m.id, e.target.value)}
                          title="Move to encounter"
                          style={{ fontSize: 11, padding: '2px 4px', height: 26, maxWidth: 150, color: 'var(--text-muted)', flexShrink: 1 }}
                        >
                          {encounters.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                        </select>
                      )}

                      <select
                        value={m.media_type_id || ''}
                        disabled={locked}
                        onChange={e => handleTypeChange(m, e.target.value)}
                        style={{ fontSize: 12, padding: '3px 6px', height: 28, width: 160, opacity: locked ? 0.5 : 1, flexShrink: 0 }}
                      >
                        <option value="">No type</option>
                        {mediaTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>

                    {isOwner && (
                      <button className="btn btn-ghost btn-icon btn-sm" title="Delete file"
                        onClick={() => handleDeleteClick('file', m)}
                        style={{ color: 'var(--danger)', opacity: 0.6, flexShrink: 0 }}>
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {isOwner && (
                <div style={{ padding: '10px 14px', background: 'var(--bg)', borderTop: (enc.media || []).length === 0 ? '1px solid var(--border)' : 'none', display: 'flex', justifyContent: 'flex-start' }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 11, padding: '2px 8px', height: 24 }}
                    onClick={() => { setNewFileName(''); setAddFileEncounterId(enc.id); setShowAddFile(true) }}
                    title="Add media file slot to this encounter"
                  >
                    + Add File
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!isOwner && hasPassword && (
        <div style={{ marginTop: 20, background: 'var(--bg-secondary)', border: '1px solid var(--border)', padding: '10px 14px', borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
          Only the project owner can scan for new encounters. You can still assign media types here and use the Files tab to link your local copies.
        </div>
      )}

      {/* Bulk action bar — appears when one or more items are selected */}
      {isOwner && selCount > 0 && (
        <div style={{
          position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 900,
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 6px 24px rgba(0,0,0,0.18)', padding: '8px 12px',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{selCount} selected</span>
          {selFiles.size > 0 && (
            <>
              <span style={{ width: 1, height: 22, background: 'var(--border)' }} />
              <select value={bulkType} onChange={e => setBulkType(e.target.value)}
                title="Set media type for selected files"
                style={{ fontSize: 12, height: 30, padding: '0 6px' }}>
                <option value="">Set type…</option>
                <option value="__none__">No type</option>
                {mediaTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <button className="btn btn-secondary btn-sm" disabled={!bulkType || bulkBusy} onClick={handleBulkSetType}>Apply</button>
            </>
          )}
          <span style={{ width: 1, height: 22, background: 'var(--border)' }} />
          <button className="btn btn-danger btn-sm" disabled={bulkBusy} onClick={() => setBulkDeleteOpen(true)}>Delete</button>
          <button className="btn btn-ghost btn-sm" disabled={bulkBusy} onClick={clearSelection}>Clear</button>
        </div>
      )}

      {bulkDeleteOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ maxWidth: 440, width: '90%', padding: 24 }}>
            <h3 style={{ marginBottom: 12 }}>
              Delete {selEnc.size > 0 && `${selEnc.size} encounter${selEnc.size !== 1 ? 's' : ''}`}
              {selEnc.size > 0 && selFiles.size > 0 && ' and '}
              {selFiles.size > 0 && `${selFiles.size} file${selFiles.size !== 1 ? 's' : ''}`}?
            </h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
              This permanently removes the selected items and any reviews, timestamps, and form responses under them. The deletion syncs to all machines.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setBulkDeleteOpen(false)} disabled={bulkBusy}>Cancel</button>
              <button className="btn btn-danger" onClick={handleBulkDeleteConfirm} disabled={bulkBusy}>
                {bulkBusy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ maxWidth: 420, width: '90%', padding: 24 }}>
            <h3 style={{ marginBottom: 12 }}>Delete {deleteTarget.type === 'encounter' ? 'Encounter' : 'File'}?</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
              <strong>{deleteTarget.name}</strong>{' '}
              {deleteTarget.reviewCount > 0
                ? `has ${deleteTarget.reviewCount} review${deleteTarget.reviewCount !== 1 ? 's' : ''}. Deleting it will permanently destroy all associated reviews, timestamps, and form responses.`
                : 'has no reviews and will be permanently removed.'}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)} disabled={deleteLoading}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDeleteConfirm} disabled={deleteLoading}>
                {deleteLoading ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <Modal
        open={showAddEncounter}
        onClose={() => setShowAddEncounter(false)}
        title="Add Encounter"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowAddEncounter(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleAddEncounter} disabled={!newEncounterName.trim()}>Add</button>
          </>
        }
      >
        <div className="form-field">
          <label>Encounter Name</label>
          <input
            autoFocus
            placeholder="e.g. Patient 001"
            value={newEncounterName}
            onChange={e => setNewEncounterName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddEncounter()}
          />
        </div>
      </Modal>

      {showBatchAdd && (
        <BatchAddModal
          mediaTypes={mediaTypes}
          onClose={() => setShowBatchAdd(false)}
          onConfirm={async (names, slots) => { setShowBatchAdd(false); await onBatchCreate(names, slots) }}
        />
      )}

      {importPreview && (
        <ImportStructureModal
          preview={importPreview}
          applying={applyingImport}
          onClose={() => setImportPreview(null)}
          onConfirm={handleApplyImport}
        />
      )}

      <Modal
        open={showAddFile}
        onClose={() => setShowAddFile(false)}
        title="Add Media File Slot"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowAddFile(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleAddFile} disabled={!newFileName.trim()}>Add</button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Creates an empty media slot. Link it to a file on disk in the Files tab or from the project page.
          </p>
          <div className="form-field">
            <label>File Name</label>
            <input
              autoFocus
              placeholder="e.g. consult_video.mp4"
              value={newFileName}
              onChange={e => setNewFileName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddFile()}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}

function KeybindsEditor({ keybinds, mediaTypes, onChange }) {
  // Collect all tags across all media types
  const allTags = mediaTypes.flatMap(mt => (mt.tags || []).map(t => ({ ...t, mediaTypeName: mt.name })))

  function addBind() {
    onChange([...keybinds, { key: '', tagId: null }])
  }

  function updateBind(i, changes) {
    const next = keybinds.map((b, idx) => idx === i ? { ...b, ...changes } : b)
    onChange(next)
  }

  function removeBind(i) {
    onChange(keybinds.filter((_, idx) => idx !== i))
  }

  // Check for duplicate keys
  const keyCounts = {}
  for (const b of keybinds) {
    if (b.key) keyCounts[b.key.toLowerCase()] = (keyCounts[b.key.toLowerCase()] || 0) + 1
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <h2 style={{ marginBottom: 6 }}>Keybinds</h2>
      <p className="text-secondary" style={{ marginBottom: 20, fontSize: 13 }}>
        Assign single keys to quickly add timestamps while the video plays. The key fires when you're not focused in a text field.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {keybinds.length === 0 && (
          <div className="empty-state" style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '28px 20px' }}>
            <p className="text-sm">No keybinds yet. Add one below.</p>
          </div>
        )}
        {keybinds.map((bind, i) => {
          const isDupe = bind.key && keyCounts[bind.key.toLowerCase()] > 1
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', border: `1px solid ${isDupe ? 'var(--danger)' : 'var(--border)'}`, borderRadius: 8, background: 'var(--bg)' }}>
              {/* Key input */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <label style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Key</label>
                <input
                  value={bind.key}
                  maxLength={1}
                  placeholder="t"
                  onChange={e => updateBind(i, { key: e.target.value.slice(-1) })}
                  style={{
                    width: 48, height: 36, textAlign: 'center', fontFamily: 'monospace',
                    fontWeight: 700, fontSize: 16, textTransform: 'lowercase',
                    border: `1.5px solid ${isDupe ? 'var(--danger)' : 'var(--border)'}`,
                    borderRadius: 6,
                  }}
                />
              </div>

              <div style={{ color: 'var(--text-muted)', fontSize: 18, marginTop: 14 }}>→</div>

              {/* Tag selector */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <label style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tag (optional)</label>
                <select
                  value={bind.tagId ?? ''}
                  onChange={e => updateBind(i, { tagId: e.target.value === '' ? null : Number(e.target.value) })}
                  style={{ height: 36, fontSize: 13 }}
                >
                  <option value="">No tag (plain timestamp)</option>
                  {allTags.map(t => (
                    <option key={t.id} value={t.id}>{t.label} — {t.mediaTypeName}</option>
                  ))}
                </select>
              </div>

              <button className="btn btn-ghost btn-icon btn-sm" style={{ marginTop: 14 }} onClick={() => removeBind(i)} title="Remove">
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
      </div>

      <button className="btn btn-secondary btn-sm" onClick={addBind}>
        <Plus size={13} /> Add Keybind
      </button>

      <p className="text-muted text-sm" style={{ marginTop: 16 }}>
        Changes save automatically. Keys are case-insensitive. During review, keybinds only fire when you're not typing in a form field.
      </p>
    </div>
  )
}

function OverviewSection() {
  const block = (emoji, title, body) => (
    <div style={{ display: 'flex', gap: 14, padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
      <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>{emoji}</span>
      <div>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{body}</div>
      </div>
    </div>
  )

  const warn = (body) => (
    <div style={{ display: 'flex', gap: 10, padding: '10px 14px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8 }}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
      <span style={{ fontSize: 12, color: '#92400e', lineHeight: 1.6 }}>{body}</span>
    </div>
  )

  return (
    <div style={{ maxWidth: 680 }}>
      <h2 style={{ marginBottom: 4 }}>Overview</h2>
      <p className="text-secondary" style={{ fontSize: 13, marginBottom: 20 }}>
        Read this before setting up your project. It covers the full workflow, folder structure, sync, and common mistakes.
      </p>

      {/* New-user pointer */}
      <div style={{ display: 'flex', gap: 12, padding: '14px 16px', border: '1px solid var(--accent)', background: 'var(--accent-light)', borderRadius: 8, marginBottom: 28 }}>
        <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>🎓</span>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, color: 'var(--accent)' }}>New to SDMo? Start with the sample project</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            From the home screen, click <strong>Sample Project</strong> to open a ready-made example with encounters, media, and a coding form already set up. Guided pop-up tips walk you through each page. Look for the <strong>?</strong> button in the top-right of any page to replay a tour.
          </div>
        </div>
      </div>

      {/* Setup flow */}
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Setup Flow</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
        {block('📋', '1 · Forms', 'Build the survey forms coders fill out for each review. Forms are made of sections and questions (text, number, multiple choice, etc.). Multiple forms can be assigned to one media type.')}
        {block('📄', '2 · Instructions', 'Write guidance pages in Markdown, or attach a PDF. These appear as tabs in the reviewer workspace so coders can reference them while watching a video.')}
        {block('🎬', '3 · Media Types', 'Define categories of media — e.g. "Consultation Video" or "Debrief Audio". Each type sets which forms and instructions appear in the workspace, what timestamp tags are available, how many reviews are required per file, and the review layout.')}
        {block('📁', '4 · Encounters', 'Create and manage encounters and their media file slots. Add encounters manually, scan a folder to import structure automatically, or batch-add many at once. Assign media types to each file slot here.')}
        {block('🔗', '5 · Files', 'Link your local copies of media files to this project. Set a base folder and auto-link, or locate individual files manually. Everyone must do this on their own machine since file paths are device-specific.')}
        {block('🔄', '6 · Sync', 'Connect to a shared folder (OneDrive, Dropbox, Google Drive, or a network share). Each reviewer\'s data is saved as a separate file — no conflicts. Sync also distributes any changes you make here in Settings to all teammates.')}
        {block('⌨️', '7 · Keybinds', 'Optional keyboard shortcuts for adding timestamps while a video plays. Useful for frequently used tags.')}
        {block('🔒', '8 · Access', 'Set an owner password to prevent coders from accidentally changing project settings. Anyone with the password can unlock.')}
      </div>

      {/* Folder structure */}
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Required Folder Structure</h3>
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', marginBottom: 8 }}>
        <pre style={{ margin: 0, fontSize: 12, fontFamily: 'monospace', lineHeight: 1.7, color: 'var(--text)' }}>{`MediaFolder/          ← point Settings → Media Folder here
├── Patient001/       ← each subfolder = one Encounter
│   ├── consult.mp4   ← media files to review
│   └── debrief.mp4
├── Patient002/
│   └── consult.mp4
└── Patient003/
    └── consult.mp4`}</pre>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 28 }}>
        Each first-level subfolder becomes an encounter. Files directly inside become the media files. Nested subfolders are ignored.
      </p>

      {/* Things not to do */}
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Things Not To Do</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
        {warn("Don't rename or move video files after scanning. The app stores the full file path — if a file moves, it won't be found and won't play.")}
        {warn("Don't replace a video with a different file using the same filename. The app won't know it changed and the coder will review the wrong video.")}
        {warn("Don't change your reviewer name mid-project. Reviews are matched by name when syncing — a name change will make the app treat you as a different reviewer and may cause duplicate data.")}
        {warn("Don't delete or rename encounter folders on disk. If you need to reorganize, do it before the initial scan.")}
      </div>

      {/* Sync and sharing */}
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sync & Sharing</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
        {block('🗂️', 'How sync works', "Each reviewer's completed reviews are saved to their own file in the shared folder (e.g. reviewer-AliceChen.json). There are no write conflicts. \"Sync Now\" on the project page merges everyone's latest data into your local database.")}
        {block('🆕', 'Joining on a new device', "A teammate shares their sync file (any .json file from the shared folder works). Click \"Import Project\" on the home screen, select the file, then set your local Media Folder and Sync Folder. The app will scan and link your local files automatically.")}
        {block('🔑', 'Password changes', 'The owner password is included in the sync file. When you change it in Access and sync, all teammates will be required to use the new password.')}
        {block('📑', 'PDF instructions', 'PDFs attached to instructions are embedded in the sync file (as base64). Teammates receive them automatically the next time they sync — no manual file sharing needed.')}
      </div>

      {/* Export */}
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Exporting Data</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {block('📊', 'Export to Excel', 'Use the "Export Excel" button on the project page. The spreadsheet is organized by media type — each sheet contains all reviews for that type. Each row is one review. Columns include reviewer name, encounter, file name, timestamps, and one column per form question across all forms assigned to that media type.')}
        {block('🔎', 'What\'s included', 'All submitted and in-progress reviews are exported. Deleted reviews are not. Each question\'s column is labelled "[Form Name] Question Label" so you can identify where each response came from.')}
      </div>
    </div>
  )
}

function SyncSection({
  syncMode, syncFolder, setSyncFolder, cloudStatus, cloudConnecting, cloudError,
  showFolderPicker, setShowFolderPicker, folderPickerFolders, folderPickerParent, folderPickerLoading, folderBreadcrumbs,
  onSwitchMode, onSaveSyncFolder, onSelectSyncFolder,
  onCloudConnect, onCancelAuth, onCloudDisconnect, onSelectCloudFolder, onDrillIn, onFolderBack, onFolderRefresh,
  folderLinkInput, setFolderLinkInput, folderLinkError, folderLinkLoading, onFolderLinkSubmit,
  isOwner, hasPassword,
}) {
  const modes = [
    { id: 'none', label: 'None', desc: 'No automatic sync. Use Export/Import manually.' },
    { id: 'local', label: 'Local Folder', desc: 'Shared folder on disk (OneDrive, Dropbox, network drive).' },
    { id: 'cloud', label: 'OneDrive / Google Drive', desc: 'Connect directly — no local sync required.' },
  ]

  const providerLabel = cloudStatus?.provider === 'onedrive' ? 'OneDrive' : cloudStatus?.provider === 'googledrive' ? 'Google Drive' : 'Cloud'
  const locked = hasPassword && !isOwner

  return (
    <div style={{ maxWidth: 580 }}>
      <h2 style={{ marginBottom: 6 }}>Sync</h2>
      <p className="text-secondary" style={{ marginBottom: 12, fontSize: 13 }}>
        Choose how to share reviews and settings with teammates. Each reviewer's data is stored as a separate file — no write conflicts.
      </p>
      {locked && (
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Sync destination is managed by the project owner. Unlock the project in the Access tab to change it.
        </div>
      )}
      {!locked && (
      <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#92400e', marginBottom: 20 }}>
        <strong>Everyone on the team must point to the same sync destination.</strong>
        {' '}If you're joining an existing project, ask the project owner which method and folder they use — using a different location means reviews will never merge.
      </div>
      )}

      {/* Mode selector */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
        {modes.map(m => (
          <button
            key={m.id}
            onClick={() => !locked && onSwitchMode(m.id)}
            disabled={locked}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 12,
              padding: '12px 14px', border: `2px solid ${syncMode === m.id ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 10, background: syncMode === m.id ? 'var(--accent-light)' : 'var(--bg)',
              cursor: locked ? 'default' : 'pointer', textAlign: 'left', fontFamily: 'var(--font)', width: '100%',
              transition: 'border-color 0.15s', opacity: locked && syncMode !== m.id ? 0.5 : 1,
            }}
          >
            <div style={{
              width: 18, height: 18, borderRadius: '50%', border: `2px solid ${syncMode === m.id ? 'var(--accent)' : 'var(--border)'}`,
              background: syncMode === m.id ? 'var(--accent)' : 'transparent', flexShrink: 0, marginTop: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {syncMode === m.id && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'white' }} />}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 2 }}>{m.label}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{m.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Local folder panel */}
      {syncMode === 'local' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px', border: '1px solid var(--border)', borderRadius: 10 }}>
          <div className="form-field">
            <label>Shared Folder Path</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={syncFolder}
                onChange={e => setSyncFolder(e.target.value)}
                placeholder="/path/to/OneDrive/MyStudy"
              />
              <button className="btn btn-secondary" style={{ flexShrink: 0 }} onClick={onSelectSyncFolder}>
                <FolderOpen size={14} /> Browse
              </button>
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => onSaveSyncFolder(syncFolder)} disabled={!syncFolder}>
            Save Folder
          </button>
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '12px 14px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--text)', display: 'block', marginBottom: 6 }}>Setup steps:</strong>
            <ol style={{ paddingLeft: 16, margin: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <li>Create a folder inside your OneDrive/Dropbox/Google Drive for this study</li>
              <li>Share that folder with all teammates via your cloud provider's sharing settings</li>
              <li>Each teammate browses to their local copy of that same folder here</li>
              <li>Sync happens automatically after you submit reviews or change settings</li>
            </ol>
            <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 11 }}>
              If your cloud folder is set to "online only", you'll need to right-click it and choose "Always keep on this device" before using it here.
            </div>
          </div>
        </div>
      )}

      {/* Cloud panel */}
      {syncMode === 'cloud' && (
        <div style={{ padding: '18px', border: '1px solid var(--border)', borderRadius: 10 }}>
          {cloudError && (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#b91c1c', marginBottom: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
              <X size={14} style={{ flexShrink: 0 }} /> {cloudError}
            </div>
          )}

          {!cloudStatus?.connected ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                Sign in to connect your cloud storage directly — no local sync needed.
              </p>
              <button
                className="btn btn-secondary"
                onClick={() => onCloudConnect('onedrive')}
                disabled={cloudConnecting}
                style={{ justifyContent: 'flex-start', gap: 10 }}
              >
                <Cloud size={16} /> {cloudConnecting ? 'Waiting for browser sign-in…' : 'Connect OneDrive'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => onCloudConnect('googledrive')}
                disabled={cloudConnecting}
                style={{ justifyContent: 'flex-start', gap: 10 }}
              >
                <Cloud size={16} /> {cloudConnecting ? 'Waiting for browser sign-in…' : 'Connect Google Drive'}
              </button>
              {cloudConnecting && (
                <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onCancelAuth}>
                  Cancel
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
                <Cloud size={16} color="var(--accent)" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{providerLabel}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cloudStatus.email}</div>
                </div>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: cloudStatus.tokenExpired ? 'var(--danger)' : 'var(--success)',
                }} />
              </div>

              {cloudStatus.cloudFolderId ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <HardDrive size={14} color="var(--text-muted)" />
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {cloudStatus.folderName ? <><strong>{cloudStatus.folderName}</strong></> : 'Sync folder selected'}
                  </span>
                  <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => { setShowFolderPicker(true) }}>
                    Change
                  </button>
                </div>
              ) : (
                <button className="btn btn-primary" onClick={() => setShowFolderPicker(true)}>
                  Select Sync Folder
                </button>
              )}

              {/* Paste a share link to set/change the sync folder */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>
                  Or paste a shared folder link
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    style={{ flex: 1, fontSize: 13 }}
                    placeholder={cloudStatus?.provider === 'googledrive'
                      ? 'https://drive.google.com/drive/folders/…'
                      : 'https://onedrive.live.com/…'}
                    value={folderLinkInput || ''}
                    onChange={e => setFolderLinkInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') onFolderLinkSubmit() }}
                    disabled={folderLinkLoading}
                  />
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={onFolderLinkSubmit}
                    disabled={folderLinkLoading || !folderLinkInput?.trim()}
                  >
                    {folderLinkLoading ? '…' : 'Use Link'}
                  </button>
                </div>
                {folderLinkError && (
                  <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>{folderLinkError}</p>
                )}
              </div>

              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)', alignSelf: 'flex-start' }} onClick={onCloudDisconnect}>
                Disconnect
              </button>
            </div>
          )}
        </div>
      )}

      {/* Cloud folder picker modal */}
      <Modal
        open={showFolderPicker}
        onClose={() => setShowFolderPicker(false)}
        title="Select Sync Folder"
        footer={
          <button className="btn btn-secondary" onClick={() => setShowFolderPicker(false)}>Cancel</button>
        }
      >
        <div style={{ minHeight: 240 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            {folderBreadcrumbs.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={onFolderBack}>← Back</button>
            )}
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={onFolderRefresh}
              disabled={folderPickerLoading}
              title="Refresh"
            >
              <RefreshCw size={13} />
            </button>
          </div>
          {folderPickerLoading ? (
            <div className="empty-state"><div className="spinner" /></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button
                className="btn btn-primary btn-sm"
                style={{ alignSelf: 'flex-start', marginBottom: 8 }}
                onClick={() => onSelectCloudFolder({ id: folderPickerParent, name: folderBreadcrumbs.length === 0 ? 'My Drive (root)' : folderPickerFolders[0]?.name || 'This folder' })}
              >
                Use This Location
              </button>
              {folderPickerFolders.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--text-muted)', padding: '8px 0' }}>No subfolders here — click "Use This Location" to sync to this folder, or go back to pick a different one.</p>
              ) : (
                folderPickerFolders.map(f => (
                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)' }}>
                    <HardDrive size={14} color="var(--text-muted)" />
                    <span style={{ flex: 1, fontSize: 13 }}>{f.name}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => onDrillIn(f)}>Open</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => onSelectCloudFolder(f)}>Select</button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}

function SetupSection({ title, description, items, onNew, onEdit, onDuplicate, onDelete, newLabel, locked }) {
  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>{title}</h2>
          <p className="text-secondary" style={{ fontSize: 13 }}>{description}</p>
        </div>
        {!locked && (
          <button className="btn btn-primary btn-sm" style={{ flexShrink: 0, marginLeft: 16 }} onClick={onNew}>
            <Plus size={13} /> {newLabel}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty-state" style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '40px 20px' }}>
          <p className="text-sm">No {title.toLowerCase()} yet. Create one to get started.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map(item => (
            <div key={item.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 8,
              background: 'var(--bg)',
            }}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{item.name}</div>
                {item.color && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: item.color }} />
                    <span className="text-muted text-sm">{item.reviews_required ? `${item.reviews_required} review${item.reviews_required !== 1 ? 's' : ''} required` : 'No review requirement'}</span>
                  </div>
                )}
              </div>
              {!locked && (
                <div style={{ display: 'flex', gap: 4 }}>
                  {onDuplicate && (
                    <button className="btn btn-ghost btn-icon btn-sm" title="Duplicate" onClick={() => onDuplicate(item)}>
                      <Copy size={13} />
                    </button>
                  )}
                  <button className="btn btn-ghost btn-icon btn-sm" title="Edit" onClick={() => onEdit(item)}>
                    <Edit2 size={13} />
                  </button>
                  {onDelete && (
                    <button className="btn btn-ghost btn-icon btn-sm" title="Delete" onClick={() => onDelete(item)}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ImportStructureModal({ preview, applying, onClose, onConfirm }) {
  const { toCreate = [], toAddFiles = [] } = preview
  const totalNewEnc = toCreate.length
  const totalNewFiles = toCreate.reduce((s, e) => s + e.files.length, 0)
  const totalAddFiles = toAddFiles.reduce((s, e) => s + e.files.length, 0)
  const hasChanges = totalNewEnc > 0 || totalAddFiles > 0

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="card" style={{ width: 540, maxHeight: '80vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 2px' }}>Import Structure Preview</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
            Only new encounters and missing media files will be created. Existing records are untouched.
          </p>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {!hasChanges && (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Everything in this file already exists in the project. Nothing to import.
            </div>
          )}

          {toCreate.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                New Encounters ({toCreate.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {toCreate.map((enc, i) => (
                  <div key={i} style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)' }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{enc.encName}</div>
                    {enc.files.length > 0 && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
                        {enc.files.map(f => f.fileName + (f.mediaTypeName ? ` (${f.mediaTypeName})` : '')).join(', ')}
                      </div>
                    )}
                    {enc.files.length === 0 && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>No media files</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {toAddFiles.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                Files Added to Existing Encounters ({totalAddFiles})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {toAddFiles.map((enc, i) => (
                  <div key={i} style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 3 }}>{enc.encName}</div>
                    <div style={{ fontSize: 12 }}>
                      {enc.files.map(f => f.fileName + (f.mediaTypeName ? ` (${f.mediaTypeName})` : '')).join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {hasChanges && (
            <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>
              {[totalNewEnc > 0 && `${totalNewEnc} encounter${totalNewEnc !== 1 ? 's' : ''}`, (totalNewFiles + totalAddFiles) > 0 && `${totalNewFiles + totalAddFiles} media file${totalNewFiles + totalAddFiles !== 1 ? 's' : ''}`].filter(Boolean).join(' + ')} will be created
            </span>
          )}
          <button className="btn btn-secondary" onClick={onClose} disabled={applying}>Cancel</button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={!hasChanges || applying}>
            {applying ? 'Creating…' : hasChanges ? 'Import' : 'Nothing to Import'}
          </button>
        </div>
      </div>
    </div>
  )
}

function BatchAddModal({ mediaTypes, onClose, onConfirm }) {
  const [mode, setMode] = useState('sequential')
  const [prefix, setPrefix] = useState('Encounter')
  const [startNum, setStartNum] = useState(1)
  const [count, setCount] = useState(10)
  const [customNames, setCustomNames] = useState('')
  const [slots, setSlots] = useState(() =>
    mediaTypes.map(t => ({ mediaTypeId: t.id, typeName: t.name, perEncounter: 1, enabled: true }))
  )

  const names = useMemo(() => {
    if (mode === 'custom') return customNames.split('\n').map(n => n.trim()).filter(Boolean)
    const pad = String(startNum + count - 1).length
    return Array.from({ length: count }, (_, i) =>
      `${prefix} ${String(startNum + i).padStart(pad, '0')}`
    )
  }, [mode, prefix, startNum, count, customNames])

  const expandedSlots = useMemo(() => {
    const result = []
    for (const s of slots) {
      if (!s.enabled) continue
      const n = Math.max(1, s.perEncounter)
      for (let i = 1; i <= n; i++) {
        result.push({ name: n === 1 ? s.typeName : `${s.typeName} ${i}`, mediaTypeId: s.mediaTypeId })
      }
    }
    return result
  }, [slots])

  function updateSlot(idx, changes) {
    setSlots(prev => prev.map((s, i) => i === idx ? { ...s, ...changes } : s))
  }

  const canCreate = names.length > 0

  const nameSummary = names.length === 0
    ? 'No encounters to create'
    : names.length <= 4
      ? names.join(', ')
      : `${names.slice(0, 3).join(', ')} … ${names[names.length - 1]}`

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="card" style={{ width: 520, maxHeight: '85vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 2px' }}>Batch Add Encounters</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
            Create multiple encounters at once. File slots will be the same for each.
          </p>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 22 }}>

          {/* ── Step 1: Names ── */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
              Step 1 · Encounter Names
            </div>

            {/* Mode toggle */}
            <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden', width: 'fit-content', marginBottom: 14 }}>
              {[['sequential', 'Sequential'], ['custom', 'Custom list']].map(([id, label]) => (
                <button key={id} onClick={() => setMode(id)} style={{
                  padding: '5px 14px', fontSize: 12, fontWeight: mode === id ? 600 : 400,
                  border: 'none', cursor: 'pointer', fontFamily: 'var(--font)',
                  background: mode === id ? 'var(--accent)' : 'transparent',
                  color: mode === id ? '#fff' : 'var(--text-secondary)',
                }}>{label}</button>
              ))}
            </div>

            {mode === 'sequential' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 100px', gap: 10 }}>
                <div className="form-field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Prefix</label>
                  <input value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="Patient" />
                </div>
                <div className="form-field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Start #</label>
                  <input type="number" min={1} value={startNum} onChange={e => setStartNum(Math.max(1, parseInt(e.target.value) || 1))} />
                </div>
                <div className="form-field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Count</label>
                  <input type="number" min={1} max={500} value={count} onChange={e => setCount(Math.min(500, Math.max(1, parseInt(e.target.value) || 1)))} />
                </div>
              </div>
            ) : (
              <div className="form-field" style={{ margin: 0 }}>
                <label style={{ fontSize: 11 }}>One name per line</label>
                <textarea
                  value={customNames}
                  onChange={e => setCustomNames(e.target.value)}
                  placeholder={"Patient 001\nPatient 002\nPatient 003"}
                  rows={5}
                  style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                />
              </div>
            )}

            {names.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderRadius: 6, padding: '6px 10px' }}>
                <strong>{names.length} encounter{names.length !== 1 ? 's' : ''}</strong>: {nameSummary}
              </div>
            )}
          </div>

          {/* ── Step 2: Media slots ── */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
              Step 2 · Media Slots Per Encounter
            </div>
            {slots.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                No media types defined yet. You can add slots later from the Encounters tab after creating media types in Settings → Media Types.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {slots.map((s, i) => (
                  <label key={s.mediaTypeId} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 8,
                    background: 'var(--bg)', cursor: 'pointer',
                    opacity: s.enabled ? 1 : 0.45,
                  }}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={e => updateSlot(i, { enabled: e.target.checked })}
                      style={{ flexShrink: 0, width: 15, height: 15 }}
                    />
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{s.typeName}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {s.perEncounter === 1 ? '1 slot' : `${s.perEncounter} slots`}
                      </span>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <button
                          type="button"
                          onClick={e => { e.preventDefault(); if (s.enabled) updateSlot(i, { perEncounter: Math.min(10, s.perEncounter + 1) }) }}
                          disabled={!s.enabled || s.perEncounter >= 10}
                          style={{ width: 22, height: 16, padding: 0, border: '1px solid var(--border)', borderRadius: '3px 3px 0 0', background: 'var(--bg-secondary)', cursor: 'pointer', fontSize: 10, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >▲</button>
                        <button
                          type="button"
                          onClick={e => { e.preventDefault(); if (s.enabled) updateSlot(i, { perEncounter: Math.max(1, s.perEncounter - 1) }) }}
                          disabled={!s.enabled || s.perEncounter <= 1}
                          style={{ width: 22, height: 16, padding: 0, border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 3px 3px', background: 'var(--bg-secondary)', cursor: 'pointer', fontSize: 10, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >▼</button>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
            {expandedSlots.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderRadius: 6, padding: '6px 10px' }}>
                Each encounter will have <strong>{expandedSlots.length} slot{expandedSlots.length !== 1 ? 's' : ''}</strong>: {expandedSlots.map(s => s.name).join(', ')}
              </div>
            )}
            {expandedSlots.length === 0 && slots.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                No slots selected — encounters will be created with no media files attached.
              </div>
            )}
          </div>

        </div>

        {/* Footer */}
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {canCreate && (
            <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>
              {names.length} encounter{names.length !== 1 ? 's' : ''} × {expandedSlots.length} slot{expandedSlots.length !== 1 ? 's' : ''} = {names.length * expandedSlots.length} media records
            </span>
          )}
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onConfirm(names, expandedSlots)} disabled={!canCreate}>
            Create {names.length > 0 ? `${names.length} Encounter${names.length !== 1 ? 's' : ''}` : ''}
          </button>
        </div>

      </div>
    </div>
  )
}

function statusColor(status) {
  if (status === 'linked') return 'var(--success)'
  if (status === 'missing') return '#ef4444'
  if (status === 'not_applicable') return 'var(--text-muted)'
  return '#d97706'
}

function LinkStatusDot({ status }) {
  return <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(status), flexShrink: 0, display: 'inline-block' }} />
}

function ScanResultSummary({ scanResult }) {
  if (!scanResult) return null

  if (scanResult.error) {
    return (
      <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#b91c1c' }}>
        {scanResult.error}
      </div>
    )
  }

  const {
    encountersAdded = scanResult.createdEncounters || 0,
    encountersLinked = 0,
    filesAdded = scanResult.createdMediaFiles || 0,
    filesLinked = 0,
    directMediaFiles = 0,
    totalSubfolders = 0,
    stillUnlinked = 0,
    stillBroken = 0,
  } = scanResult

  if (directMediaFiles > 0) {
    return (
      <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', color: '#92400e', padding: '12px 14px', borderRadius: 8, fontSize: 13, display: 'flex', gap: 10 }}>
        <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          <strong>Wrong folder level detected.</strong> This folder contains media files directly. SDMo expects each encounter to be its own subfolder.
          <pre style={{ margin: '6px 0 0', fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6, background: 'rgba(0,0,0,0.05)', padding: '6px 8px', borderRadius: 4 }}>{`SelectedFolder/\n  Patient001/\n    consult.mp4\n  Patient002/\n    consult.mp4`}</pre>
        </div>
      </div>
    )
  }

  if (totalSubfolders === 0) {
    return (
      <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', color: '#92400e', padding: '10px 14px', borderRadius: 8, fontSize: 13 }}>
        <strong>No subfolders found.</strong> Each encounter should be a subfolder inside the selected folder.
      </div>
    )
  }

  const nothingNew = encountersAdded === 0 && encountersLinked === 0 && filesAdded === 0 && filesLinked === 0
  const stillMissing = stillUnlinked + stillBroken
  const parts = []
  if (encountersAdded > 0) parts.push(`${encountersAdded} new encounter${encountersAdded !== 1 ? 's' : ''} added`)
  if (encountersLinked > 0) parts.push(`${encountersLinked} encounter${encountersLinked !== 1 ? 's' : ''} linked`)
  if (filesAdded > 0) parts.push(`${filesAdded} new file${filesAdded !== 1 ? 's' : ''} added`)
  if (filesLinked > 0) parts.push(`${filesLinked} file${filesLinked !== 1 ? 's' : ''} relinked`)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {(parts.length > 0 || nothingNew) && (
        <div style={{ background: 'var(--success-light)', color: 'var(--success)', padding: '10px 14px', borderRadius: 8, fontSize: 13 }}>
          {parts.length > 0 ? `✓ ${parts.join(', ')}.` : `✓ All ${totalSubfolders} folder${totalSubfolders !== 1 ? 's' : ''} up to date.`}
        </div>
      )}
      {stillMissing > 0 && (
        <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', color: '#92400e', padding: '10px 14px', borderRadius: 8, fontSize: 13, display: 'flex', gap: 8 }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <div><strong>{stillMissing} file{stillMissing !== 1 ? 's' : ''} not found in this folder.</strong> They may have been renamed or moved. Use "Link" in the file status list on the Files tab to manually locate them.</div>
        </div>
      )}
    </div>
  )
}
