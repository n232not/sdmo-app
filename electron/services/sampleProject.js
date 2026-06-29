const path = require('path')
const fs = require('fs')
const { randomUUID } = require('crypto')
const { app } = require('electron')
const { saveForm, saveMediaType, saveInstruction } = require('./structure')
const { buildWorkspaceSnapshot } = require('./snapshots')
const { upsertLink } = require('../mediaLinks')
const { getOrCreateUUID } = require('../settings')

const SAMPLE_NAME = '📘 Sample Tutorial Project'
const SAMPLE_DESCRIPTION =
  'A read-along example project. Walk through encounters, media, media types, file linking, and the review page. Safe to delete once you are comfortable.'
const SAMPLE_REVIEWER_NAME = 'Tutorial Reviewer'

// Resolves the bundled sample video shipped via electron-builder `extraResources`.
// Dev runs from the repo; packaged builds copy media/ into Resources/.
function sampleVideoPath() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'media', 'sample-encounter.mp4')]
    : [path.join(__dirname, '..', '..', 'media', 'sample-encounter.mp4')]
  return candidates.find(p => fs.existsSync(p)) || candidates[0]
}

function sampleFormSchema() {
  return {
    sections: [
      {
        id: randomUUID(),
        title: 'Encounter Overview',
        elements: [
          { id: randomUUID(), type: 'short_answer', label: 'Chief complaint', placeholder: 'e.g. persistent cough' },
          { id: randomUUID(), type: 'multiple_choice', label: 'Encounter setting', options: ['Inpatient', 'Outpatient', 'Telehealth'] },
        ],
      },
      {
        id: randomUUID(),
        title: 'Communication Quality',
        elements: [
          { id: randomUUID(), type: 'rating', label: 'Overall clinician rapport', options: ['1', '2', '3', '4', '5'] },
          { id: randomUUID(), type: 'paragraph', label: 'Notes for the research team', placeholder: 'Anything notable about this encounter…' },
        ],
      },
    ],
  }
}

function sampleSyncInstruction() {
  return `# Sync Basics

This sample project is safe to explore on one computer. In a real study, sync lets multiple coders work from the same project without sharing patient media through SDMo.

## What sync shares

- Encounters and media slots
- Forms, instructions, media types, timestamp tags, and setup changes
- Reviews, timestamps, notes, and form responses
- Owner password changes

## What stays local

- Video, audio, PDF, and other media files
- File paths on your computer
- Your local media links and N/A choices

That separation is why teammates see the same project structure but each person still needs to link files on their own machine.

## Typical team setup

1. The project owner creates the forms, instructions, media types, and encounters.
2. The owner opens Settings > Sync and chooses OneDrive, Google Drive, or a shared local folder.
3. Teammates join from the same sync destination or import a project .json file.
4. Each teammate opens Settings > Files and links their own local media folder.
5. Coders submit reviews. SDMo syncs automatically, and Sync Now pulls the latest work on demand.

## Good habits

- Keep your reviewer name consistent across devices.
- Do not move or rename media files after linking them.
- Use one shared sync destination for the whole team.
- Use Settings > Files for media problems; use Settings > Sync for sharing problems.
`
}

function ensureSampleProjectContent(db, projectId) {
  let instruction = db.prepare('SELECT id FROM instructions WHERE project_id=? AND name=?').get(projectId, 'Sync Basics')
  if (!instruction) {
    const id = saveInstruction(db, projectId, {
      name: 'Sync Basics',
      content: sampleSyncInstruction(),
      content_type: 'markdown',
    })
    instruction = { id }
  }

  const mediaType = db.prepare('SELECT id FROM media_types WHERE project_id=? AND name=?').get(projectId, 'Consultation Video')
  if (!mediaType || !instruction?.id) return

  const existingTab = db.prepare(
    "SELECT id FROM workspace_tabs WHERE media_type_id=? AND tab_type='instruction' AND ref_id=?"
  ).get(mediaType.id, instruction.id)
  if (existingTab) return

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as n FROM workspace_tabs WHERE media_type_id=?').get(mediaType.id).n
  db.prepare('INSERT INTO workspace_tabs (media_type_id, tab_type, ref_id, label, sort_order) VALUES (?,?,?,?,?)')
    .run(mediaType.id, 'instruction', instruction.id, 'Sync Basics', maxOrder + 1)
  db.prepare("UPDATE media_types SET config_version=COALESCE(config_version,1)+1, updated_at=datetime('now') WHERE id=?")
    .run(mediaType.id)
}

function ensureSampleReview(db, projectId) {
  const mediaFile = db.prepare(`
    SELECT mf.id
    FROM media_files mf
    JOIN encounters e ON mf.encounter_id=e.id
    WHERE e.project_id=?
    ORDER BY e.id, mf.id
    LIMIT 1
  `).get(projectId)
  if (!mediaFile) return null

  const existing = db.prepare(`
    SELECT r.id, r.workspace_snapshot
    FROM reviews r
    WHERE r.media_file_id=? AND r.reviewer_name=? AND r.deleted_at IS NULL
    ORDER BY r.id
    LIMIT 1
  `).get(mediaFile.id, SAMPLE_REVIEWER_NAME)
  if (existing) {
    const snapshot = buildWorkspaceSnapshot(db, mediaFile.id)
    const existingSnapshot = (() => {
      try { return existing.workspace_snapshot ? JSON.parse(existing.workspace_snapshot) : null } catch { return null }
    })()
    const hasSyncBasics = (existingSnapshot?.workspace_tabs || []).some(tab => tab.tab_type === 'instruction' && tab.label === 'Sync Basics')
    if (!hasSyncBasics && snapshot) {
      db.prepare('UPDATE reviews SET workspace_snapshot=?, media_type_sync_id=?, media_type_version=? WHERE id=?')
        .run(
          JSON.stringify(snapshot),
          snapshot?.media_type?.sync_id || null,
          snapshot?.media_type?.version || null,
          existing.id
        )
    }
    return existing.id
  }

  const snapshot = buildWorkspaceSnapshot(db, mediaFile.id)
  const r = db.prepare(`
    INSERT INTO reviews (media_file_id, reviewer_name, reviewer_uuid, review_sync_id, media_type_sync_id, media_type_version, workspace_snapshot)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    mediaFile.id,
    SAMPLE_REVIEWER_NAME,
    getOrCreateUUID(),
    randomUUID(),
    snapshot?.media_type?.sync_id || null,
    snapshot?.media_type?.version || null,
    snapshot ? JSON.stringify(snapshot) : null
  )
  return r.lastInsertRowid
}

function seedSampleProject(db) {
  // Idempotent: if a sample project already exists, just reopen it.
  const existing = db.prepare('SELECT id FROM projects WHERE name=?').get(SAMPLE_NAME)
  if (existing) {
    ensureSampleProjectContent(db, existing.id)
    const tutorialReviewId = ensureSampleReview(db, existing.id)
    return { id: existing.id, tutorialReviewId, alreadyExisted: true }
  }

  const result = db.prepare('INSERT INTO projects (name, description) VALUES (?,?)').run(SAMPLE_NAME, SAMPLE_DESCRIPTION)
  const projectId = result.lastInsertRowid

  // 1. A form with a mix of element types so the workspace shows variety.
  const formId = saveForm(db, projectId, { name: 'Encounter Coding Form', schema: sampleFormSchema() })
  const syncInstructionId = saveInstruction(db, projectId, {
    name: 'Sync Basics',
    content: sampleSyncInstruction(),
    content_type: 'markdown',
  })

  // 2. A media type wiring the form and sync primer into the workspace, with a few timestamp tags.
  saveMediaType(db, projectId, {
    name: 'Consultation Video',
    reviews_required: 1,
    allow_custom_tags: 1,
    color: '#6366f1',
    tags: [
      { label: 'Greeting', color: '#22c55e', description: 'Clinician introduces themselves' },
      { label: 'Question', color: '#3b82f6', description: 'Open or closed question asked' },
      { label: 'Empathy', color: '#a855f7', description: 'Empathic statement or acknowledgement' },
    ],
    workspace_tabs: [
      { tab_type: 'form', ref_id: formId, label: 'Coding Form' },
      { tab_type: 'instruction', ref_id: syncInstructionId, label: 'Sync Basics' },
    ],
  })

  const mediaType = db.prepare('SELECT id FROM media_types WHERE project_id=? ORDER BY id DESC LIMIT 1').get(projectId)
  const mediaTypeId = mediaType?.id || null

  // 3. A few encounters. The first media file is linked to the bundled sample
  //    video so its review page genuinely plays; the rest stay unlinked so the
  //    Files/autolink tour and the media-health banner have real targets.
  const insertEncounter = db.prepare(
    "INSERT INTO encounters (project_id, name, folder_path, sync_id, updated_at) VALUES (?,?,?,?,datetime('now'))"
  )
  const insertMedia = db.prepare(
    "INSERT INTO media_files (encounter_id, name, file_path, file_type, media_type_id, sync_id, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))"
  )

  const videoPath = sampleVideoPath()
  const encounters = ['Patient 001', 'Patient 002', 'Patient 003']
  encounters.forEach((encName, idx) => {
    const enc = insertEncounter.run(projectId, encName, '', randomUUID())
    const mediaName = 'consultation.mp4'
    // Patient 001 gets an absolute path to the bundled video so the media server
    // can serve it and the review page plays. Others stay empty (unlinked) so the
    // Files tour has real targets to point at.
    const filePath = idx === 0 ? videoPath : ''
    const mf = insertMedia.run(enc.lastInsertRowid, mediaName, filePath, 'video', mediaTypeId, randomUUID())
    if (idx === 0) {
      upsertLink(db, mf.lastInsertRowid, videoPath, false)
    }
  })

  const tutorialReviewId = ensureSampleReview(db, projectId)
  return { id: projectId, tutorialReviewId, alreadyExisted: false }
}

module.exports = { seedSampleProject, SAMPLE_NAME }
