/**
 * Google Drive adapter using Drive API v3 with OAuth2 installed-app flow.
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to https://console.cloud.google.com → Create or select a project
 * 2. Enable the "Google Drive API": APIs & Services → Library → search "Google Drive API" → Enable
 * 3. Go to APIs & Services → OAuth consent screen:
 *    - User type: External → Create
 *    - App name: SDMo, fill required fields, save
 *    - Scopes: add ../auth/drive.file, email, profile
 *    - Test users: add your email while in testing mode
 * 4. Go to APIs & Services → Credentials → Create Credentials → OAuth client ID:
 *    - Application type: Desktop app → Name: SDMo → Create
 *    - Copy the Client ID and Client Secret and paste below
 * 5. To publish (remove test-user restriction): complete OAuth consent screen verification
 *
 * Note: scope "drive.file" limits the app to only files it created — users cannot see
 * other Drive files and the app cannot access them. This is the correct scope for SDMo.
 */

const http = require('http')
const crypto = require('crypto')
const { shell } = require('electron')
const fetch = require('node-fetch')
const { getSettings, saveSettings } = require('../settings')

const { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET } = require('./credentials')

const REDIRECT_URI = 'http://localhost:3878'
const SCOPES = 'https://www.googleapis.com/auth/drive email profile'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'

async function startAuth(onServer) {
  if (CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID_HERE') {
    throw new Error('Google Drive credentials not configured. See setup instructions in electron/cloud/googledrive.js')
  }

  const state = crypto.randomBytes(8).toString('hex')

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT_URI)
      if (url.searchParams.get('state') !== state) return
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h2>SDMo: Google Drive connected! You can close this tab.</h2></body></html>')
      server.close()

      if (error || !code) return reject(new Error(error || 'No code returned'))

      try {
        const tokenRes = await fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            redirect_uri: REDIRECT_URI,
          }).toString(),
        })
        const tokens = await tokenRes.json()
        if (tokens.error) throw new Error(tokens.error_description || tokens.error)

        const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
        const user = await userRes.json()

        saveSettings({
          googledrive_tokens: {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + tokens.expires_in * 1000,
          },
          googledrive_email: user.email || '',
        })
        resolve({ email: user.email || '' })
      } catch (e) {
        reject(e)
      }
    })

    server.listen({ port: 3878, host: '127.0.0.1', exclusive: false }, () => {
      if (onServer) onServer(server)
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        state,
        access_type: 'offline',
        prompt: 'consent',
      })
      shell.openExternal(`${AUTH_ENDPOINT}?${params}`)
    })

    server.on('error', reject)
    setTimeout(() => { server.close(); reject(new Error('Google Drive auth timed out')) }, 5 * 60 * 1000)
  })
}

// Serialize refreshes so parallel Drive calls don't each fire a refresh at once.
let _refreshPromise = null

async function ensureValidToken() {
  const s = getSettings()
  const tokens = s.googledrive_tokens
  if (!tokens) throw new Error('Not connected to Google Drive')

  if (Date.now() < tokens.expires_at - 5 * 60 * 1000) return tokens.access_token

  if (_refreshPromise) return _refreshPromise
  _refreshPromise = (async () => {
    try {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: tokens.refresh_token,
        }).toString(),
      })
      const refreshed = await res.json()
      if (refreshed.error) throw new Error(refreshed.error_description || refreshed.error)

      saveSettings({
        googledrive_tokens: {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || tokens.refresh_token,
          expires_at: Date.now() + refreshed.expires_in * 1000,
        },
      })
      return refreshed.access_token
    } finally {
      _refreshPromise = null
    }
  })()
  return _refreshPromise
}

async function driveRequest(method, endpoint, body, params) {
  const token = await ensureValidToken()
  const url = new URL(`${DRIVE_BASE}${endpoint}`)
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))

  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)

  const res = await fetch(url.toString(), opts)
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Drive API ${method} ${endpoint} failed: ${res.status} ${err}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) return res.json()
  return res.text()
}

async function listFiles(folderId) {
  const files = []
  let pageToken = null
  do {
    const data = await driveRequest('GET', '/files', undefined, {
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType)',
      pageSize: '1000',
      ...(pageToken ? { pageToken } : {}),
    })
    files.push(...(data.files || []))
    pageToken = data.nextPageToken || null
  } while (pageToken)
  return files.map(f => ({
    id: f.id,
    name: f.name,
    isFolder: f.mimeType === 'application/vnd.google-apps.folder',
  }))
}

async function listFolders(folderId) {
  const token = await ensureValidToken()
  const parent = folderId || 'root'
  const q = `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  const files = []
  let pageToken = null
  do {
    const url = new URL(`${DRIVE_BASE}/files`)
    url.searchParams.set('q', q)
    url.searchParams.set('fields', 'nextPageToken,files(id,name)')
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json()
    files.push(...(data.files || []))
    pageToken = data.nextPageToken || null
  } while (pageToken)
  return files.map(f => ({ id: f.id, name: f.name, isFolder: true }))
}

async function readFile(fileId) {
  const token = await ensureValidToken()
  const res = await fetch(`${DRIVE_BASE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to read file ${fileId}: ${res.status}`)
  return res.text()
}

async function writeFile(folderId, fileName, content, mimeType = 'application/json') {
  const token = await ensureValidToken()

  // Check if file already exists
  const existing = await driveRequest('GET', '/files', undefined, {
    q: `name = '${fileName}' and '${folderId}' in parents and trashed = false`,
    fields: 'files(id)',
  })
  const existingId = existing.files?.[0]?.id

  // Binary content (Buffer) is base64-encoded so it survives the string-joined
  // multipart body; text content is sent as-is.
  const isBinary = Buffer.isBuffer(content)
  const boundary = `boundary_${crypto.randomBytes(8).toString('hex')}`
  const metadata = JSON.stringify(existingId ? {} : { name: fileName, parents: [folderId] })
  const multipart = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    ...(isBinary ? ['Content-Transfer-Encoding: base64'] : []),
    '',
    isBinary ? content.toString('base64') : content,
    `--${boundary}--`,
  ].join('\r\n')

  let url, method
  if (existingId) {
    url = `${UPLOAD_BASE}/files/${existingId}?uploadType=multipart`
    method = 'PATCH'
  } else {
    url = `${UPLOAD_BASE}/files?uploadType=multipart`
    method = 'POST'
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipart,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Failed to write file ${fileName}: ${res.status} ${err}`)
  }
  const data = await res.json()
  return data.id
}

async function ensureFolder(parentId, name) {
  const token = await ensureValidToken()
  const q = `name = '${name}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  const url = new URL(`${DRIVE_BASE}/files`)
  url.searchParams.set('q', q)
  url.searchParams.set('fields', 'files(id)')
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json()
  if (data.files?.[0]) return data.files[0].id

  const created = await driveRequest('POST', '/files', {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId],
  })
  return created.id
}

function disconnect() {
  saveSettings({ googledrive_tokens: null, googledrive_email: null })
}

function getStatus() {
  const s = getSettings()
  const tokens = s.googledrive_tokens
  if (!tokens) return { connected: false }
  const tokenExpired = Date.now() >= tokens.expires_at
  return { connected: true, email: s.googledrive_email || '', tokenExpired }
}

module.exports = { startAuth, listFiles, listFolders, readFile, writeFile, ensureFolder, disconnect, getStatus }
