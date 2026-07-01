/**
 * OneDrive adapter using Microsoft Graph API with OAuth2 PKCE flow.
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to https://portal.azure.com → Azure Active Directory → App registrations → New registration
 * 2. Name: "SDMo", Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
 * 3. Redirect URI: select "Mobile and desktop applications", enter: http://localhost:3877
 * 4. After registration, copy the "Application (client) ID" and paste it below as CLIENT_ID
 * 5. Under "API permissions", add: Microsoft Graph → Delegated → Files.ReadWrite, offline_access, User.Read
 * 6. NO client secret needed — PKCE desktop flow is used
 */

const http = require('http')
const crypto = require('crypto')
const { shell } = require('electron')
const fetch = require('node-fetch')
const { getSettings, saveSettings } = require('../settings')

const { ONEDRIVE_CLIENT_ID: CLIENT_ID } = require('./credentials')

const REDIRECT_URI = 'http://localhost:3877'
const SCOPES = 'Files.ReadWrite offline_access User.Read'
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0'
const GRAPH_BASE = `${GRAPH_ROOT}/me/drive`

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

async function startAuth(onServer) {
  if (CLIENT_ID === 'YOUR_AZURE_CLIENT_ID_HERE') {
    throw new Error('OneDrive client ID not configured. See setup instructions in electron/cloud/onedrive.js')
  }

  const { verifier, challenge } = generatePKCE()
  const state = crypto.randomBytes(8).toString('hex')

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT_URI)
      if (url.searchParams.get('state') !== state) return
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h2>SDMo: OneDrive connected! You can close this tab.</h2></body></html>')
      server.close()

      if (error || !code) return reject(new Error(error || 'No code returned'))

      try {
        const tokenRes = await fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
          }).toString(),
        })
        const tokens = await tokenRes.json()
        if (tokens.error) throw new Error(tokens.error_description || tokens.error)

        const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
        const user = await userRes.json()

        saveSettings({
          onedrive_tokens: {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + tokens.expires_in * 1000,
            scope: tokens.scope || SCOPES,
          },
          onedrive_email: user.mail || user.userPrincipalName || '',
        })
        resolve({ email: user.mail || user.userPrincipalName || '' })
      } catch (e) {
        reject(e)
      }
    })

    server.listen({ port: 3877, host: '127.0.0.1', exclusive: false }, () => {
      if (onServer) onServer(server)
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
      shell.openExternal(`${AUTH_ENDPOINT}?${params}`)
    })

    server.on('error', reject)
    setTimeout(() => { server.close(); reject(new Error('OneDrive auth timed out')) }, 5 * 60 * 1000)
  })
}

// Serialize refreshes: Microsoft rotates refresh tokens, so two parallel requests
// each refreshing with the same (single-use) refresh_token would invalidate the session.
let _refreshPromise = null

async function ensureValidToken() {
  const s = getSettings()
  const tokens = s.onedrive_tokens
  if (!tokens) throw new Error('Not connected to OneDrive')

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
          refresh_token: tokens.refresh_token,
        }).toString(),
      })
      const refreshed = await res.json()
      if (refreshed.error) throw new Error(refreshed.error_description || refreshed.error)

      saveSettings({
        onedrive_tokens: {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || tokens.refresh_token,
          expires_at: Date.now() + refreshed.expires_in * 1000,
          scope: refreshed.scope || tokens.scope || SCOPES,
        },
      })
      return refreshed.access_token
    } finally {
      _refreshPromise = null
    }
  })()
  return _refreshPromise
}

async function graphRequest(method, endpoint, body) {
  const token = await ensureValidToken()
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }
  if (body !== undefined) opts.body = typeof body === 'string' ? body : JSON.stringify(body)
  const res = await fetch(`${GRAPH_BASE}${endpoint}`, opts)
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph API ${method} ${endpoint} failed: ${res.status} ${err}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) return res.json()
  return res.text()
}

function encodeSharingUrl(url) {
  return `u!${Buffer.from(url).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`
}

function encodeCloudItemId(driveId, itemId) {
  if (!driveId || !itemId) return itemId
  return JSON.stringify({ driveId, itemId })
}

function decodeCloudItemId(id) {
  if (!id || id === 'root') return { driveId: null, itemId: id || 'root' }
  if (typeof id === 'string' && id.startsWith('{')) {
    try {
      const parsed = JSON.parse(id)
      if (parsed?.driveId && parsed?.itemId) return parsed
    } catch {}
  }
  return { driveId: null, itemId: id }
}

function itemUrl(id, suffix = '') {
  const { driveId, itemId } = decodeCloudItemId(id)
  if (driveId) return `${GRAPH_ROOT}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}${suffix}`
  return `${GRAPH_BASE}/items/${encodeURIComponent(itemId)}${suffix}`
}

function extractFolderIdFromUrl(link) {
  try {
    const url = new URL(link)
    const id = url.searchParams.get('id') || url.searchParams.get('resid')
    if (id) return decodeURIComponent(id)
  } catch {}
  const idMatch = String(link || '').match(/[?&](?:id|resid)=([^&]+)/)
  return idMatch ? decodeURIComponent(idMatch[1]) : null
}

async function extractFolderIdFromSharingLink(link) {
  const direct = extractFolderIdFromUrl(link)
  if (direct) return direct
  const res = await fetch(link, { method: 'GET', redirect: 'follow' })
  const redirected = extractFolderIdFromUrl(res.url)
  if (redirected) return redirected
  const body = await res.text().catch(() => '')
  return extractFolderIdFromUrl(body)
}

async function resolveFolderLink(link) {
  const token = await ensureValidToken()
  const shareId = encodeSharingUrl(link)
  const res = await fetch(`${GRAPH_ROOT}/shares/${shareId}/driveItem?$select=id,name,folder,parentReference,remoteItem`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const err = await res.text()
    if (res.status === 403 && err.includes('accessDenied')) {
      throw new Error('Microsoft says this signed-in OneDrive account cannot access that shared folder link. Make sure the link is shared with the same OneDrive account, or open the link in OneDrive and add it to your files before selecting it in SDMo.')
    }
    throw new Error(`Graph API resolve shared link failed: ${res.status} ${err}`)
  }
  const item = await res.json()
  const driveItem = item.remoteItem || item
  if (!driveItem.folder && !item.folder) throw new Error('That link points to a file, not a folder')
  const driveId = driveItem.parentReference?.driveId || item.parentReference?.driveId
  const itemId = driveItem.id || item.id
  if (!itemId) throw new Error('Could not resolve OneDrive folder from that link')
  return { id: encodeCloudItemId(driveId, itemId), name: driveItem.name || item.name || '' }
}

async function listFiles(folderId) {
  const token = await ensureValidToken()
  const parent = decodeCloudItemId(folderId)
  let url = `${itemUrl(folderId)}/children?$select=id,name,folder,file`
  const items = []
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Graph API listFiles failed: ${res.status} ${err}`)
    }
    const data = await res.json()
    items.push(...(data.value || []))
    url = data['@odata.nextLink'] || null
  }
  return items.map(item => ({
    id: parent.driveId ? encodeCloudItemId(parent.driveId, item.id) : item.id,
    name: item.name,
    isFolder: !!item.folder,
  }))
}

async function listFolders(folderId) {
  const items = await listFiles(folderId || 'root')
  return items.filter(i => i.isFolder)
}

async function readFile(fileId) {
  const token = await ensureValidToken()
  const res = await fetch(itemUrl(fileId, '/content'), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to read file ${fileId}: ${res.status}`)
  return res.text()
}

async function writeFile(folderId, fileName, content, mimeType = 'application/json') {
  const token = await ensureValidToken()
  const { driveId, itemId } = decodeCloudItemId(folderId)
  const encodedName = encodeURIComponent(fileName)
  const url = driveId
    ? `${GRAPH_ROOT}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}:/${encodedName}:/content?@microsoft.graph.conflictBehavior=replace`
    : `${GRAPH_BASE}/items/${encodeURIComponent(itemId)}:/${encodedName}:/content?@microsoft.graph.conflictBehavior=replace`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
    body: content,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Failed to write file ${fileName}: ${res.status} ${err}`)
  }
  const data = await res.json()
  return data.id
}

async function ensureFolder(parentId, name) {
  const children = await listFiles(parentId)
  const existing = children.find(c => c.isFolder && c.name === name)
  if (existing) return existing.id

  try {
    const { driveId, itemId } = decodeCloudItemId(parentId)
    const token = await ensureValidToken()
    const res = await fetch(`${itemUrl(parentId)}/children`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Graph API create folder failed: ${res.status} ${err}`)
    }
    const data = await res.json()
    return driveId ? encodeCloudItemId(driveId, data.id) : data.id
  } catch (e) {
    // Created concurrently — search again
    const retry = await listFiles(parentId)
    const found = retry.find(c => c.isFolder && c.name === name)
    if (found) return found.id
    throw e
  }
}

function disconnect() {
  saveSettings({ onedrive_tokens: null, onedrive_email: null })
}

function getStatus() {
  const s = getSettings()
  const tokens = s.onedrive_tokens
  if (!tokens) return { connected: false }
  const tokenExpired = Date.now() >= tokens.expires_at
  return { connected: true, email: s.onedrive_email || '', tokenExpired }
}

module.exports = { startAuth, listFiles, listFolders, readFile, writeFile, ensureFolder, extractFolderIdFromSharingLink, resolveFolderLink, disconnect, getStatus }
