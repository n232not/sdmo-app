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
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me/drive'

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

async function listFiles(folderId) {
  const token = await ensureValidToken()
  let url = `${GRAPH_BASE}/items/${folderId}/children?$select=id,name,folder,file`
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
  return items.map(item => ({ id: item.id, name: item.name, isFolder: !!item.folder }))
}

async function listFolders(folderId) {
  const items = await listFiles(folderId || 'root')
  return items.filter(i => i.isFolder)
}

async function readFile(fileId) {
  const token = await ensureValidToken()
  const res = await fetch(`${GRAPH_BASE}/items/${fileId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to read file ${fileId}: ${res.status}`)
  return res.text()
}

async function writeFile(folderId, fileName, content, mimeType = 'application/json') {
  const token = await ensureValidToken()
  const res = await fetch(`${GRAPH_BASE}/items/${folderId}:/${encodeURIComponent(fileName)}:/content?@microsoft.graph.conflictBehavior=replace`, {
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
    const data = await graphRequest('POST', `/items/${parentId}/children`, {
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    })
    return data.id
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

module.exports = { startAuth, listFiles, listFolders, readFile, writeFile, ensureFolder, disconnect, getStatus }
