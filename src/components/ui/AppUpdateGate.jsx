import { useEffect, useState } from 'react'
import { AlertTriangle, Download, RefreshCw, RotateCcw } from 'lucide-react'
import { api } from '../../lib/api'
import Modal from './Modal'

function updateTitle(status) {
  if (status?.required) return 'Update Required'
  if (status?.state === 'downloaded') return 'Update Ready'
  return 'Update Available'
}

function releaseText(info) {
  const version = info?.version
  const name = info?.releaseName
  if (version && name && name !== version) return `${name} (${version})`
  return version ? `Version ${version}` : 'A newer version'
}

export default function AppUpdateGate() {
  const [status, setStatus] = useState(null)
  const [dismissedVersion, setDismissedVersion] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let mounted = true
    api.getUpdateStatus?.().then(s => { if (mounted) setStatus(s) })
    const id = api.onUpdateStatus?.(setStatus)
    return () => {
      mounted = false
      if (id) api.offUpdateStatus?.(id)
    }
  }, [])

  const version = status?.updateInfo?.version || status?.requiredVersion || null
  const show = !!status && (
    status.required ||
    status.state === 'available' ||
    status.state === 'downloading' ||
    status.state === 'downloaded' ||
    (status.state === 'error' && version)
  ) && (status.required || dismissedVersion !== version)

  async function download() {
    setBusy(true)
    try {
      const next = await api.downloadUpdate()
      setStatus(next)
    } finally {
      setBusy(false)
    }
  }

  async function install() {
    setBusy(true)
    try {
      await api.installUpdate()
    } finally {
      setBusy(false)
    }
  }

  async function retryCheck() {
    setBusy(true)
    try {
      const next = await api.checkForUpdates()
      setStatus(next)
    } finally {
      setBusy(false)
    }
  }

  if (!show) return null

  const isDownloading = status.state === 'downloading'
  const isDownloaded = status.state === 'downloaded'
  const manualInstallOnly = status.manualInstallOnly
  const progress = status.progress?.percent ? Math.round(status.progress.percent) : null

  return (
    <Modal
      open
      onClose={status.required ? null : () => setDismissedVersion(version)}
      title={updateTitle(status)}
      footer={
        <>
          {!status.required && !isDownloading && !isDownloaded && (
            <button className="btn btn-secondary" onClick={() => setDismissedVersion(version)}>
              Later
            </button>
          )}
          {status.state === 'error' && (
            <button className="btn btn-secondary" onClick={retryCheck} disabled={busy}>
              <RefreshCw size={14} /> Retry
            </button>
          )}
          {!manualInstallOnly && !isDownloaded && status.state !== 'error' && (
            <button className={status.required ? 'btn btn-danger' : 'btn btn-primary'} onClick={download} disabled={busy || isDownloading}>
              <Download size={14} /> {isDownloading ? `Downloading${progress != null ? ` ${progress}%` : ''}` : 'Download Update'}
            </button>
          )}
          {isDownloaded && (
            <button className={status.required ? 'btn btn-danger' : 'btn btn-primary'} onClick={install} disabled={busy}>
              <RotateCcw size={14} /> Restart to Install
            </button>
          )}
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {status.required && (
          <div style={{ display: 'flex', gap: 10, padding: '10px 12px', borderRadius: 8, background: 'var(--danger-light)', color: 'var(--danger)', fontSize: 13 }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>This release is required. SDMo cannot be used until the update is installed.</span>
          </div>
        )}
        <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          {releaseText(status.updateInfo || status.rememberedRequiredUpdate)} is available. Updates install the app only; your local projects, reviews, settings, sync credentials, and media links stay in SDMo's data folder.
        </p>
        {manualInstallOnly && (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            This macOS build cannot install updates in-app. Install the latest DMG manually.
          </p>
        )}
        {isDownloading && (
          <div style={{ height: 8, background: 'var(--bg-active)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress || 8}%`, background: 'var(--accent)' }} />
          </div>
        )}
        {isDownloaded && (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            SDMo will create a database backup before restarting into the new version.
          </p>
        )}
        {status.error && (
          <p style={{ color: 'var(--danger)', fontSize: 13 }}>{status.error}</p>
        )}
      </div>
    </Modal>
  )
}
