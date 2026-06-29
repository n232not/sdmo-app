const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { test } = require('./_harness')
const sync = require('../electron/sync')
const snapshots = require('../electron/services/snapshots')
const structure = require('../electron/services/structure')
const {
  makeDb, createProject, addForm, addMediaType, addWorkspaceTab,
  addEncounter, addMedia, addReview,
} = require('./helpers')

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }

// ─── Config export/import round-trip ────────────────────────────────────────────

test('config: buildConfigExport → mergeConfigImport replicates structure', () => {
  const src = makeDb()
  const p1 = createProject(src, 'Study A')
  const formId = addForm(src, p1, 'Intake', { sections: [{ id: 's1', title: 'S', elements: [] }] })
  const mtId = addMediaType(src, p1, 'Video', { reviews_required: 2, allow_custom_tags: true, tags: [{ label: 'Pain' }] })
  addWorkspaceTab(src, mtId, { tab_type: 'form', ref_id: formId, label: 'Intake', sort_order: 0 })
  const enc = addEncounter(src, p1, 'Patient 1')
  addMedia(src, enc.id, 'visit.mp4', { media_type_id: mtId })

  const config = sync.buildConfigExport(src, p1)

  const dst = makeDb()
  const p2 = createProject(dst, 'placeholder')
  sync.mergeConfigImport(dst, p2, config, { force: true })

  assert.strictEqual(dst.prepare('SELECT name FROM projects WHERE id=?').get(p2).name, 'Study A')
  const forms = dst.prepare('SELECT name FROM forms WHERE project_id=?').all(p2)
  assert.deepStrictEqual(forms.map(f => f.name), ['Intake'])

  const mt = dst.prepare('SELECT * FROM media_types WHERE project_id=?').get(p2)
  assert.strictEqual(mt.name, 'Video')
  assert.strictEqual(mt.reviews_required, 2)
  const tags = dst.prepare('SELECT label FROM timestamp_tags WHERE media_type_id=?').all(mt.id)
  assert.deepStrictEqual(tags.map(t => t.label), ['Pain'])

  const tab = dst.prepare('SELECT * FROM workspace_tabs WHERE media_type_id=?').get(mt.id)
  assert.strictEqual(tab.tab_type, 'form')
  const tabForm = dst.prepare('SELECT name FROM forms WHERE id=?').get(tab.ref_id)
  assert.strictEqual(tabForm.name, 'Intake') // ref resolved by name into the new DB's id

  const e = dst.prepare('SELECT * FROM encounters WHERE project_id=?').get(p2)
  assert.strictEqual(e.name, 'Patient 1')
  const media = dst.prepare('SELECT * FROM media_files WHERE encounter_id=?').get(e.id)
  assert.strictEqual(media.name, 'visit.mp4')
  assert.strictEqual(media.media_type_id, mt.id)
  src.close(); dst.close()
})

test('config: rename via sync_id updates in place (no duplicate rows)', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const enc = addEncounter(db, p, 'Old Name')
  const media = addMedia(db, enc.id, 'old.mp4')

  const config = {
    sdmo: true, version: 4, config_version: 999,
    project: { name: 'P' }, forms: [], instructions: [], media_types: [],
    encounters: [{
      sync_id: enc.sync_id, name: 'New Name',
      media: [{ sync_id: media.sync_id, name: 'new.mp4', file_type: 'video', media_type_name: null }],
    }],
  }
  sync.mergeConfigImport(db, p, config, { force: true })

  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM encounters WHERE project_id=?').get(p).n, 1)
  assert.strictEqual(db.prepare('SELECT name FROM encounters WHERE sync_id=?').get(enc.sync_id).name, 'New Name')
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM media_files').get().n, 1)
  assert.strictEqual(db.prepare('SELECT name FROM media_files WHERE sync_id=?').get(media.sync_id).name, 'new.mp4')
  db.close()
})

// ─── Applying a config never prunes — deletion requires a tombstone ──────────────

test('config: applying a config does NOT prune an encounter absent from it (no tombstone = keep)', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const keep = addEncounter(db, p, 'Keep')
  addMedia(db, keep.id, 'k.mp4')
  const drop = addEncounter(db, p, 'Drop')
  addMedia(db, drop.id, 'd.mp4')

  // 'Drop' is absent from the config but was NOT explicitly deleted (no tombstone),
  // so per-entity merge must leave it alone — config is no longer authoritative-prune.
  const config = {
    sdmo: true, version: 5, config_version: 999, project: { name: 'P' },
    forms: [], instructions: [], media_types: [],
    encounters: [{ sync_id: keep.sync_id, name: 'Keep', media: [{ sync_id: null, name: 'k.mp4', file_type: 'video', media_type_name: null }] }],
  }
  sync.mergeConfigImport(db, p, config, { force: true })

  const names = db.prepare('SELECT name FROM encounters WHERE project_id=?').all(p).map(r => r.name).sort()
  assert.deepStrictEqual(names, ['Drop', 'Keep'])
  db.close()
})

test('config: prune KEEPS an encounter that has reviews (no cascade data loss)', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const keep = addEncounter(db, p, 'Keep')
  addMedia(db, keep.id, 'k.mp4')
  const drop = addEncounter(db, p, 'Drop')
  const dropMedia = addMedia(db, drop.id, 'd.mp4')
  addReview(db, dropMedia.id, 'Alice', { status: 'submitted' })

  const config = {
    sdmo: true, version: 4, config_version: 999, project: { name: 'P' },
    forms: [], instructions: [], media_types: [],
    encounters: [{ sync_id: keep.sync_id, name: 'Keep', media: [{ sync_id: null, name: 'k.mp4', file_type: 'video', media_type_name: null }] }],
  }
  sync.mergeConfigImport(db, p, config, { force: true })

  // The omitted encounter is retained because destroying it would cascade-delete the review.
  const names = db.prepare('SELECT name FROM encounters WHERE project_id=?').all(p).map(r => r.name).sort()
  assert.deepStrictEqual(names, ['Drop', 'Keep'])
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM reviews').get().n, 1)
  db.close()
})

test('config: refuses a config newer than CONFIG_FORMAT_VERSION', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const config = { sdmo: true, version: 999, config_version: 2, project: { name: 'P' }, encounters: [] }
  assert.throws(() => sync.mergeConfigImport(db, p, config, { force: true }), /newer version of SDMo/)
  db.close()
})

// ─── Per-entity structure merge (last-writer-wins, no whole-blob clobber) ────────

// Minimal v5 config envelope with a per-entity clock on every form.
function cfg({ exported_at = '2024-01-01 00:00:00', config_version = 1, forms = [], encounters = [] } = {}) {
  return {
    sdmo: true, version: 5, config_version, exported_at,
    project: { name: 'P', updated_at: exported_at },
    forms, instructions: [], media_types: [], encounters,
  }
}
function setFormClock(db, formId, ts) { db.prepare('UPDATE forms SET updated_at=? WHERE id=?').run(ts, formId) }

test('merge: two machines that add DIFFERENT entities both survive (the silent-loss bug)', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  addForm(db, p, 'Local Form') // this machine's form — the peer has never seen it

  // Peer's config lists only ITS form (and the same config_version). The old code
  // would have left the peer form out OR pruned ours; merge must keep both.
  const incoming = cfg({ forms: [{ sync_id: 'peer-form', updated_at: '2024-01-01 00:00:00', name: 'Peer Form', schema: { sections: [] } }] })
  const { conflicts } = sync.mergeStructureFromConfig(db, p, incoming)

  const names = db.prepare('SELECT name FROM forms WHERE project_id=? ORDER BY name').all(p).map(f => f.name)
  assert.deepStrictEqual(names, ['Local Form', 'Peer Form'])
  assert.strictEqual(conflicts.length, 0)
  db.close()
})

test('merge: newer incoming edit wins; older incoming edit is ignored', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const fId = addForm(db, p, 'F', { sections: [{ id: 's', title: 'orig', elements: [] }] }, { sync_id: 'f1' })
  setFormClock(db, fId, '2024-06-01 00:00:00')

  // Older edit (loses) — local schema must be untouched.
  sync.mergeStructureFromConfig(db, p, cfg({ forms: [{ sync_id: 'f1', updated_at: '2024-01-01 00:00:00', name: 'F', schema: { sections: [{ id: 's', title: 'STALE', elements: [] }] } }] }))
  assert.match(db.prepare('SELECT schema FROM forms WHERE id=?').get(fId).schema, /orig/)

  // Newer edit (wins) — local schema is replaced.
  sync.mergeStructureFromConfig(db, p, cfg({ forms: [{ sync_id: 'f1', updated_at: '2024-12-01 00:00:00', name: 'F', schema: { sections: [{ id: 's', title: 'NEWER', elements: [] }] } }] }))
  assert.match(db.prepare('SELECT schema FROM forms WHERE id=?').get(fId).schema, /NEWER/)
  db.close()
})

test('merge: same-entity concurrent edit (equal clocks, different content) reports a conflict + converges deterministically', () => {
  function run(localTitle, incomingTitle) {
    const db = makeDb()
    const p = createProject(db, 'P')
    const fId = addForm(db, p, 'F', { sections: [{ id: 's', title: localTitle, elements: [] }] }, { sync_id: 'f1' })
    setFormClock(db, fId, '2024-06-01 00:00:00') // identical clock to the incoming edit
    const { conflicts } = sync.mergeStructureFromConfig(db, p, cfg({ forms: [{ sync_id: 'f1', updated_at: '2024-06-01 00:00:00', name: 'F', schema: { sections: [{ id: 's', title: incomingTitle, elements: [] }] } }] }))
    const winner = db.prepare('SELECT schema FROM forms WHERE id=?').get(fId).schema
    db.close()
    return { conflicts, winner }
  }
  const a = run('AAA', 'BBB')
  assert.strictEqual(a.conflicts.length, 1)
  assert.strictEqual(a.conflicts[0].kind, 'form')
  // Deterministic tiebreak: both machines (mirror inputs) must agree on the same winner.
  const b = run('BBB', 'AAA')
  assert.strictEqual(a.winner, b.winner)
})

test('merge: a form tombstone deletes it and a stale config cannot resurrect it', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  addForm(db, p, 'Doomed', { sections: [] }, { sync_id: 'f1' })

  sync.applyStructureTombstones(db, p, [{ kind: 'form', sync_id: 'f1' }])
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM forms WHERE project_id=?').get(p).n, 0)

  // A peer whose config still lists the form must NOT bring it back.
  sync.mergeStructureFromConfig(db, p, cfg({ forms: [{ sync_id: 'f1', updated_at: '2099-01-01 00:00:00', name: 'Doomed', schema: { sections: [] } }] }))
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM forms WHERE project_id=?').get(p).n, 0)
  db.close()
})

test('merge: structureFingerprint ignores row order + clocks, reflects content', () => {
  const a = makeDb(); const pa = createProject(a, 'P')
  addForm(a, pa, 'One', { sections: [] }, { sync_id: 's-one' })
  addForm(a, pa, 'Two', { sections: [] }, { sync_id: 's-two' })

  // Same two forms, inserted in the opposite order, with different local clocks.
  const b = makeDb(); const pb = createProject(b, 'P')
  const t = addForm(b, pb, 'Two', { sections: [] }, { sync_id: 's-two' })
  addForm(b, pb, 'One', { sections: [] }, { sync_id: 's-one' })
  setFormClock(b, t, '2030-01-01 00:00:00')

  assert.strictEqual(sync.structureFingerprint(a, pa), sync.structureFingerprint(b, pb))
  // Changing content must change the fingerprint.
  addForm(b, pb, 'Three', { sections: [] }, { sync_id: 's-three' })
  assert.notStrictEqual(sync.structureFingerprint(a, pa), sync.structureFingerprint(b, pb))
  a.close(); b.close()
})

// ─── Review file merge ──────────────────────────────────────────────────────────

function reviewFile(overrides = {}) {
  return {
    sdmo_reviews: true, version: 1,
    reviewer_uuid: 'alice-uuid', reviewer_name: 'Alice',
    reviews: [{
      review_sync_id: 'rev-1', encounter_sync_id: null, encounter_name: 'E1',
      media_sync_id: null, media_name: 'm.mp4', status: 'submitted', notes: 'n',
      created_at: '2024-01-01T00:00:00Z', submitted_at: '2024-01-02T00:00:00Z',
      timestamps: [{ time_seconds: 5, tag_label: 'Pain', tag_color: null, notes: 'ouch', created_at: '2024-01-01T00:00:00Z' }],
      form_responses: [],
    }],
    ...overrides,
  }
}

function dbWithMedia() {
  const db = makeDb()
  const p = createProject(db, 'P')
  const mt = addMediaType(db, p, 'Video', { tags: [{ label: 'Pain', color: '#ff0000' }] })
  const enc = addEncounter(db, p, 'E1')
  const media = addMedia(db, enc.id, 'm.mp4', { media_type_id: mt })
  return { db, p, enc, media }
}

test('reviews: mergeReviewFile imports a peer review and resolves tag ids', () => {
  const { db, p } = dbWithMedia()
  sync.mergeReviewFile(db, p, reviewFile(), 'my-uuid')

  const rev = db.prepare('SELECT * FROM reviews').get()
  assert.strictEqual(rev.reviewer_name, 'Alice')
  assert.strictEqual(rev.status, 'submitted')
  const ts = db.prepare('SELECT * FROM timestamps WHERE review_id=?').all(rev.id)
  assert.strictEqual(ts.length, 1)
  assert.strictEqual(ts[0].tag_label, 'Pain')
  assert.ok(ts[0].tag_id, 'tag_label should resolve to a local tag_id')
  db.close()
})

test('reviews: mergeReviewFile is idempotent (same review_sync_id)', () => {
  const { db, p } = dbWithMedia()
  sync.mergeReviewFile(db, p, reviewFile(), 'my-uuid')
  sync.mergeReviewFile(db, p, reviewFile(), 'my-uuid')
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM reviews').get().n, 1)
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM timestamps').get().n, 1)
  db.close()
})

test('reviews: mergeReviewFile updates an existing review in place', () => {
  const { db, p } = dbWithMedia()
  sync.mergeReviewFile(db, p, reviewFile(), 'my-uuid')

  const changed = reviewFile()
  changed.reviews[0].notes = 'edited'
  changed.reviews[0].timestamps = [
    { time_seconds: 5, tag_label: 'Pain', notes: 'ouch', created_at: '2024-01-01T00:00:00Z' },
    { time_seconds: 12, tag_label: null, notes: 'second', created_at: '2024-01-01T00:00:00Z' },
  ]
  sync.mergeReviewFile(db, p, changed, 'my-uuid')

  const rev = db.prepare('SELECT * FROM reviews').get()
  assert.strictEqual(rev.notes, 'edited')
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM timestamps WHERE review_id=?').get(rev.id).n, 2)
  db.close()
})

test('reviews: mergeReviewFile skips a file written by my own uuid', () => {
  const { db, p } = dbWithMedia()
  sync.mergeReviewFile(db, p, reviewFile({ reviewer_uuid: 'my-uuid' }), 'my-uuid')
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM reviews').get().n, 0)
  db.close()
})

test('reviews: mergeReviewFile matches media by sync_id even after a local rename', () => {
  const { db, p, media } = dbWithMedia()
  // Local file was renamed; peer references it by sync_id + its old name.
  db.prepare('UPDATE media_files SET name=? WHERE id=?').run('renamed.mp4', media.id)
  const file = reviewFile()
  file.reviews[0].media_sync_id = media.sync_id
  file.reviews[0].media_name = 'm.mp4'
  sync.mergeReviewFile(db, p, file, 'my-uuid')
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM reviews WHERE media_file_id=?').get(media.id).n, 1)
  db.close()
})

// ─── buildReviewExport scoping ──────────────────────────────────────────────────

test('reviews: buildReviewExport includes only my live reviews', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const enc = addEncounter(db, p, 'E1')
  const media = addMedia(db, enc.id, 'm.mp4')
  addReview(db, media.id, 'Me', { reviewer_uuid: 'me' })
  addReview(db, media.id, 'Other', { reviewer_uuid: 'other' })
  const mine2 = addReview(db, media.id, 'Me', { reviewer_uuid: 'me' })
  db.prepare("UPDATE reviews SET deleted_at=datetime('now') WHERE id=?").run(mine2.id) // soft-deleted

  const out = sync.buildReviewExport(db, p, 'me', 'Me')
  assert.strictEqual(out.reviews.length, 1)
  assert.strictEqual(out.reviews[0].media_name, 'm.mp4')
  db.close()
})

// ─── Tombstones ─────────────────────────────────────────────────────────────────

test('tombstones: applyTombstones soft-deletes by review_sync_id and records it', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const enc = addEncounter(db, p, 'E1')
  const media = addMedia(db, enc.id, 'm.mp4')
  const rev = addReview(db, media.id, 'Alice')

  sync.applyTombstones(db, p, [{
    review_sync_id: rev.review_sync_id, encounter_name: 'E1', media_name: 'm.mp4', reviewer_name: 'Alice',
  }])

  assert.ok(db.prepare('SELECT deleted_at FROM reviews WHERE id=?').get(rev.id).deleted_at)
  const tombs = sync.buildTombstones(db, p)
  assert.strictEqual(tombs.length, 1)
  assert.strictEqual(tombs[0].review_sync_id, rev.review_sync_id)
  db.close()
})

// ─── Structure tombstones (explicit encounter/media deletion propagation) ────────

test('structure tombstone: deletes a reviewed encounter everywhere (overrides prune guard)', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const enc = addEncounter(db, p, 'Drop')
  const media = addMedia(db, enc.id, 'd.mp4')
  addReview(db, media.id, 'Alice', { status: 'submitted' })

  // Peer device explicitly deleted this encounter — tombstone arrives via sync.
  sync.applyStructureTombstones(db, p, [{ kind: 'encounter', sync_id: enc.sync_id }])

  // Unlike absent-from-config pruning, an explicit tombstone destroys it + its reviews.
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM encounters WHERE project_id=?').get(p).n, 0)
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM reviews').get().n, 0)
  const tombs = sync.buildStructureTombstones(db, p)
  assert.strictEqual(tombs.length, 1)
  assert.strictEqual(tombs[0].sync_id, enc.sync_id)
  db.close()
})

test('structure tombstone: a stale config cannot resurrect a tombstoned encounter', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const enc = addEncounter(db, p, 'Drop')
  addMedia(db, enc.id, 'd.mp4')

  // Tombstone the encounter (e.g. deleted on this machine), then a peer's stale
  // config that still lists it tries to apply.
  sync.applyStructureTombstones(db, p, [{ kind: 'encounter', sync_id: enc.sync_id }])
  const staleConfig = {
    sdmo: true, version: 4, config_version: 999, project: { name: 'P' },
    forms: [], instructions: [], media_types: [],
    encounters: [{ sync_id: enc.sync_id, name: 'Drop', media: [{ sync_id: null, name: 'd.mp4', file_type: 'video', media_type_name: null }] }],
  }
  sync.mergeConfigImport(db, p, staleConfig, { force: true })

  // The tombstoned encounter must NOT come back.
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM encounters WHERE project_id=?').get(p).n, 0)
  db.close()
})

// ─── Reviews report workbook (auto-uploaded .xlsx) ──────────────────────────────

test('reviews report: builds readable wide sheets plus normalized research sheets', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const formId = addForm(db, p, 'Intake', {
    sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'text', label: 'Outcome' }] }],
  }, { sync_id: 'form-intake' })
  const mtId = addMediaType(db, p, 'Video', { sync_id: 'mt-video' })
  addWorkspaceTab(db, mtId, { tab_type: 'form', ref_id: formId, label: 'Intake', sort_order: 0 })
  const enc = addEncounter(db, p, 'Patient 1', 'enc-patient-1')
  const media = addMedia(db, enc.id, 'visit.mp4', { media_type_id: mtId, sync_id: 'media-visit' })
  const rev = addReview(db, media.id, 'Alice', { status: 'submitted', review_sync_id: 'review-1' })
  db.prepare('INSERT INTO form_responses (review_id, form_id, responses) VALUES (?,?,?)')
    .run(rev.id, formId, JSON.stringify({ q1: 'Improved' }))
  db.prepare('INSERT INTO timestamps (review_id, time_seconds, tag_label, notes) VALUES (?,?,?,?)')
    .run(rev.id, 65, 'Pain', 'winced')

  const wb = sync.buildReviewsWorkbook(db, p)
  assert.ok(wb, 'expected a workbook')
  assert.deepStrictEqual(wb.SheetNames.slice(0, 6), ['README', 'Codebook', 'Reviews', 'Responses_Long', 'Media_Files', 'Timestamps'])
  assert.ok(wb.SheetNames.includes('Video Reviews'), 'has reviews sheet')
  assert.ok(wb.SheetNames.includes('Video Timestamps'), 'has timestamps sheet')

  const XLSX = require('xlsx')
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Video Reviews'])
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].Reviewer, 'Alice')
  assert.strictEqual(rows[0]['[Intake] Outcome'], 'Improved')
  const ts = XLSX.utils.sheet_to_json(wb.Sheets['Video Timestamps'])
  assert.strictEqual(ts[0].Time, '1:05')

  const reviews = XLSX.utils.sheet_to_json(wb.Sheets.Reviews)
  assert.strictEqual(reviews[0]['Review ID'], 'review-1')
  assert.strictEqual(reviews[0]['Media File ID'], 'media-visit')
  assert.strictEqual(reviews[0]['Media Type ID'], 'mt-video')

  const responses = XLSX.utils.sheet_to_json(wb.Sheets.Responses_Long)
  assert.strictEqual(responses.length, 1)
  assert.strictEqual(responses[0]['Review ID'], 'review-1')
  assert.strictEqual(responses[0]['Form ID'], 'form-intake')
  assert.strictEqual(responses[0]['Question ID'], 'q1')
  assert.strictEqual(responses[0].Value, 'Improved')

  const codebook = XLSX.utils.sheet_to_json(wb.Sheets.Codebook)
  assert.strictEqual(codebook[0]['Form ID'], 'form-intake')
  assert.strictEqual(codebook[0]['Question ID'], 'q1')
  assert.strictEqual(codebook[0]['Column Header'], '[Intake] Outcome')

  const allTs = XLSX.utils.sheet_to_json(wb.Sheets.Timestamps)
  assert.strictEqual(allTs[0]['Time (seconds)'], 65)
  assert.strictEqual(allTs[0].Time, '1:05')
  db.close()
})

test('reviews report: soft-deleted reviews are excluded; no reviews → null workbook', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const mtId = addMediaType(db, p, 'Video')
  const enc = addEncounter(db, p, 'Patient 1')
  const media = addMedia(db, enc.id, 'visit.mp4', { media_type_id: mtId })

  assert.strictEqual(sync.buildReviewsWorkbook(db, p), null, 'no reviews → null')

  const rev = addReview(db, media.id, 'Bob')
  db.prepare("UPDATE reviews SET deleted_at=? WHERE id=?").run(new Date().toISOString(), rev.id)
  assert.strictEqual(sync.buildReviewsWorkbook(db, p), null, 'only deleted reviews → null')
  db.close()
})

test('review snapshots: export preserves old question labels after form edits', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const formId = addForm(db, p, 'Intake', {
    sections: [{ id: 's1', title: 'Baseline', elements: [{ id: 'q1', type: 'short_answer', label: 'Original label' }] }],
  }, { sync_id: 'form-intake' })
  const mtId = addMediaType(db, p, 'Video', { sync_id: 'mt-video' })
  addWorkspaceTab(db, mtId, { tab_type: 'form', ref_id: formId, label: 'Intake', sort_order: 0 })
  const enc = addEncounter(db, p, 'Patient 1', 'enc-1')
  const media = addMedia(db, enc.id, 'visit.mp4', { media_type_id: mtId, sync_id: 'media-1' })
  const snap = snapshots.buildWorkspaceSnapshot(db, media.id)
  const rev = addReview(db, media.id, 'Alice', { review_sync_id: 'review-1' })
  db.prepare('UPDATE reviews SET workspace_snapshot=?, media_type_sync_id=?, media_type_version=? WHERE id=?')
    .run(JSON.stringify(snap), snap.media_type.sync_id, snap.media_type.version, rev.id)
  db.prepare('INSERT INTO form_responses (review_id, form_id, responses, form_sync_id, form_version, form_snapshot) VALUES (?,?,?,?,?,?)')
    .run(rev.id, formId, JSON.stringify({ q1: 'answer' }), snap.forms[String(formId)].sync_id, snap.forms[String(formId)].version, JSON.stringify(snap.forms[String(formId)]))

  db.prepare("UPDATE forms SET schema=?, schema_version=schema_version+1, updated_at=datetime('now') WHERE id=?")
    .run(JSON.stringify({ sections: [{ id: 's1', title: 'Baseline', elements: [{ id: 'q1', type: 'short_answer', label: 'Renamed later' }] }] }), formId)

  const XLSX = require('xlsx')
  const wb = sync.buildReviewsWorkbook(db, p)
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Responses_Long)
  assert.strictEqual(rows[0]['Question Label'], 'Original label')
  assert.strictEqual(rows[0].Value, 'answer')
  db.close()
})

test('review snapshots: wide sheet + codebook keep answers to questions removed by a later form edit', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const formId = addForm(db, p, 'Intake', {
    sections: [{ id: 's1', title: 'Baseline', elements: [
      { id: 'q1', type: 'short_answer', label: 'Outcome' },
      { id: 'q2', type: 'short_answer', label: 'Dropped question' },
    ] }],
  }, { sync_id: 'form-intake' })
  const mtId = addMediaType(db, p, 'Video', { sync_id: 'mt-video' })
  addWorkspaceTab(db, mtId, { tab_type: 'form', ref_id: formId, label: 'Intake', sort_order: 0 })
  const enc = addEncounter(db, p, 'Patient 1', 'enc-1')
  const media = addMedia(db, enc.id, 'visit.mp4', { media_type_id: mtId, sync_id: 'media-1' })
  const snap = snapshots.buildWorkspaceSnapshot(db, media.id)
  const rev = addReview(db, media.id, 'Alice', { review_sync_id: 'review-1' })
  db.prepare('UPDATE reviews SET workspace_snapshot=? WHERE id=?').run(JSON.stringify(snap), rev.id)
  db.prepare('INSERT INTO form_responses (review_id, form_id, responses, form_sync_id, form_version, form_snapshot) VALUES (?,?,?,?,?,?)')
    .run(rev.id, formId, JSON.stringify({ q1: 'Improved', q2: 'Old answer' }),
      snap.forms[String(formId)].sync_id, snap.forms[String(formId)].version, JSON.stringify(snap.forms[String(formId)]))

  // Edit the form to remove q2 entirely.
  db.prepare("UPDATE forms SET schema=?, schema_version=schema_version+1, updated_at=datetime('now') WHERE id=?")
    .run(JSON.stringify({ sections: [{ id: 's1', title: 'Baseline', elements: [{ id: 'q1', type: 'short_answer', label: 'Outcome' }] }] }), formId)

  const XLSX = require('xlsx')
  const wb = sync.buildReviewsWorkbook(db, p)

  const wide = XLSX.utils.sheet_to_json(wb.Sheets['Video Reviews'])
  assert.strictEqual(wide[0]['[Intake] Outcome'], 'Improved', 'live question still present')
  assert.strictEqual(wide[0]['[Intake] Dropped question (removed)'], 'Old answer', 'removed question answer is not dropped')

  const codebook = XLSX.utils.sheet_to_json(wb.Sheets.Codebook)
  const liveRow = codebook.find(r => r['Question ID'] === 'q1')
  const removedRow = codebook.find(r => r['Question ID'] === 'q2')
  assert.strictEqual(liveRow['In Current Form'], 'Yes')
  assert.ok(removedRow, 'codebook documents the removed question')
  assert.strictEqual(removedRow['In Current Form'], 'No')
  db.close()
})

test('structure: deleting a form with responses archives it instead of cascading data loss', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const formId = addForm(db, p, 'Intake', { sections: [] }, { sync_id: 'form-intake' })
  const mtId = addMediaType(db, p, 'Video')
  addWorkspaceTab(db, mtId, { tab_type: 'form', ref_id: formId, label: 'Intake', sort_order: 0 })
  const enc = addEncounter(db, p, 'Patient 1')
  const media = addMedia(db, enc.id, 'visit.mp4', { media_type_id: mtId })
  const rev = addReview(db, media.id, 'Alice')
  db.prepare('INSERT INTO form_responses (review_id, form_id, responses) VALUES (?,?,?)')
    .run(rev.id, formId, JSON.stringify({ q1: 'kept' }))

  structure.deleteForm(db, p, formId)

  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM forms WHERE id=?').get(formId).n, 1)
  assert.ok(db.prepare('SELECT archived_at FROM forms WHERE id=?').get(formId).archived_at)
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM form_responses WHERE review_id=?').get(rev.id).n, 1)
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM workspace_tabs WHERE tab_type='form' AND ref_id=?").get(formId).n, 0)
  db.close()
})

test('version history: form edits can be restored as a new latest version', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const formId = addForm(db, p, 'Intake', {
    sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'short_answer', label: 'Old label' }] }],
  }, { sync_id: 'form-intake' })

  structure.saveForm(db, p, {
    id: formId,
    name: 'Intake',
    schema: { sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'short_answer', label: 'New label' }] }] },
  })
  let history = structure.listVersionHistory(db, p, 'form', formId)
  assert.strictEqual(history[0].version, 2)
  assert.strictEqual(history.find(v => v.version === 1).schema.sections[0].elements[0].label, 'Old label')

  const restored = structure.restoreVersion(db, p, 'form', formId, 1)
  assert.strictEqual(restored.current_version, 3)
  const current = db.prepare('SELECT schema_version, schema FROM forms WHERE id=?').get(formId)
  assert.strictEqual(current.schema_version, 3)
  assert.strictEqual(JSON.parse(current.schema).sections[0].elements[0].label, 'Old label')
  history = structure.listVersionHistory(db, p, 'form', formId)
  assert.ok(history.find(v => v.version === 2))
  db.close()
})

test('version history: form history is preserved through project-state sync', () => {
  const a = makeDb()
  const b = makeDb()
  const pa = createProject(a, 'P')
  const pb = createProject(b, 'P')
  const formA = addForm(a, pa, 'Intake', {
    sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'short_answer', label: 'Old label' }] }],
  }, { sync_id: 'form-intake' })
  addForm(b, pb, 'Intake', {
    sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'short_answer', label: 'Old label' }] }],
  }, { sync_id: 'form-intake' })

  structure.saveForm(a, pa, {
    id: formA,
    name: 'Intake',
    schema: { sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'short_answer', label: 'New label' }] }] },
  })
  const state = sync.buildProjectStateExport(a, pa)
  sync.mergeProjectStateImport(b, pb, state, { merge: true })

  const formB = b.prepare('SELECT id FROM forms WHERE sync_id=?').get('form-intake')
  const history = structure.listVersionHistory(b, pb, 'form', formB.id)
  assert.strictEqual(history[0].version, 2)
  assert.strictEqual(history.find(v => v.version === 1).schema.sections[0].elements[0].label, 'Old label')
  a.close()
  b.close()
})

test('version history: media type edits restore tags and workspace tabs', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const formId = addForm(db, p, 'Intake', { sections: [] }, { sync_id: 'form-intake' })
  const mtId = addMediaType(db, p, 'Video', {
    sync_id: 'mt-video',
    tags: [{ label: 'Old Tag', color: '#111111', description: 'old' }],
  })
  addWorkspaceTab(db, mtId, { tab_type: 'form', ref_id: formId, label: 'Old Tab', sort_order: 0 })

  structure.saveMediaType(db, p, {
    id: mtId,
    name: 'Video',
    reviews_required: 2,
    allow_custom_tags: 1,
    color: '#222222',
    tags: [{ label: 'New Tag', color: '#222222', description: 'new' }],
    workspace_tabs: [],
  })
  const history = structure.listVersionHistory(db, p, 'mediaType', mtId)
  assert.strictEqual(history[0].version, 2)
  assert.strictEqual(history.find(v => v.version === 1).config.tags[0].label, 'Old Tag')

  const restored = structure.restoreVersion(db, p, 'mediaType', mtId, 1)
  assert.strictEqual(restored.current_version, 3)
  const mt = db.prepare('SELECT config_version, reviews_required, allow_custom_tags, color FROM media_types WHERE id=?').get(mtId)
  assert.strictEqual(mt.config_version, 3)
  assert.strictEqual(mt.reviews_required, 1)
  assert.strictEqual(mt.allow_custom_tags, 0)
  assert.strictEqual(mt.color, '#6366f1')
  assert.strictEqual(db.prepare('SELECT label FROM timestamp_tags WHERE media_type_id=?').get(mtId).label, 'Old Tag')
  assert.strictEqual(db.prepare('SELECT label FROM workspace_tabs WHERE media_type_id=?').get(mtId).label, 'Old Tab')
  db.close()
})

test('review migration: updates drafts to current snapshots without touching submitted reviews', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const formId = addForm(db, p, 'Intake', {
    sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'short_answer', label: 'Old label' }] }],
  }, { sync_id: 'form-intake' })
  const mtId = addMediaType(db, p, 'Video', { sync_id: 'mt-video' })
  addWorkspaceTab(db, mtId, { tab_type: 'form', ref_id: formId, label: 'Intake', sort_order: 0 })
  const enc = addEncounter(db, p, 'Patient 1')
  const media = addMedia(db, enc.id, 'visit.mp4', { media_type_id: mtId })
  const oldSnap = snapshots.buildWorkspaceSnapshot(db, media.id)
  const draft = addReview(db, media.id, 'Alice', { status: 'in_progress' })
  const submitted = addReview(db, media.id, 'Bob', { status: 'submitted' })
  for (const rev of [draft, submitted]) {
    db.prepare('UPDATE reviews SET workspace_snapshot=?, media_type_sync_id=?, media_type_version=? WHERE id=?')
      .run(JSON.stringify(oldSnap), oldSnap.media_type.sync_id, oldSnap.media_type.version, rev.id)
    db.prepare('INSERT INTO form_responses (review_id, form_id, responses, form_sync_id, form_version, form_snapshot) VALUES (?,?,?,?,?,?)')
      .run(rev.id, formId, JSON.stringify({ q1: 'kept' }), 'form-intake', 1, JSON.stringify(oldSnap.forms[String(formId)]))
  }

  structure.saveForm(db, p, {
    id: formId,
    name: 'Intake',
    schema: { sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'short_answer', label: 'New label' }] }] },
  })
  const result = snapshots.migrateStructureReviews(db, p, 'form', formId, 'drafts')

  assert.strictEqual(result.updated, 1)
  const draftFr = db.prepare('SELECT form_version, form_snapshot, responses FROM form_responses WHERE review_id=?').get(draft.id)
  const submittedFr = db.prepare('SELECT form_version, form_snapshot FROM form_responses WHERE review_id=?').get(submitted.id)
  assert.strictEqual(draftFr.form_version, 2)
  assert.strictEqual(JSON.parse(draftFr.form_snapshot).schema.sections[0].elements[0].label, 'New label')
  assert.strictEqual(JSON.parse(draftFr.responses).q1, 'kept')
  assert.strictEqual(submittedFr.form_version, 1)
  db.close()
})

test('review migration: apply-all wins over stale synced review state without conflict', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const formId = addForm(db, p, 'Intake', {
    sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'short_answer', label: 'Old label' }] }],
  }, { sync_id: 'form-intake' })
  const mtId = addMediaType(db, p, 'Video', { sync_id: 'mt-video' })
  addWorkspaceTab(db, mtId, { tab_type: 'form', ref_id: formId, label: 'Intake', sort_order: 0 })
  const enc = addEncounter(db, p, 'Patient 1', 'enc-1')
  const media = addMedia(db, enc.id, 'visit.mp4', { sync_id: 'media-1', media_type_id: mtId })
  const oldSnap = snapshots.buildWorkspaceSnapshot(db, media.id)
  const review = addReview(db, media.id, 'Alice', {
    status: 'submitted',
    review_sync_id: 'review-1',
    created_at: '2024-01-01T00:00:00.000Z',
    submitted_at: '2024-01-01T00:00:00.000Z',
  })
  db.prepare('UPDATE reviews SET workspace_snapshot=?, media_type_sync_id=?, media_type_version=? WHERE id=?')
    .run(JSON.stringify(oldSnap), oldSnap.media_type.sync_id, oldSnap.media_type.version, review.id)
  db.prepare('INSERT INTO form_responses (review_id, form_id, responses, form_sync_id, form_version, form_snapshot, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(review.id, formId, JSON.stringify({ q1: 'kept' }), 'form-intake', 1, JSON.stringify(oldSnap.forms[String(formId)]), '2024-01-01T00:00:00.000Z')
  const staleState = sync.buildProjectStateExport(db, p)

  structure.saveForm(db, p, {
    id: formId,
    name: 'Intake',
    schema: { sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'short_answer', label: 'New label' }] }] },
  })
  const result = snapshots.migrateStructureReviews(db, p, 'form', formId, 'all')
  assert.strictEqual(result.updated, 1)

  const mergeResult = sync.mergeProjectStateImport(db, p, staleState, { merge: true })
  assert.strictEqual(mergeResult.conflicts.length, 0)
  const fr = db.prepare('SELECT form_version, form_snapshot, responses FROM form_responses WHERE review_id=?').get(review.id)
  assert.strictEqual(fr.form_version, 2)
  assert.strictEqual(JSON.parse(fr.form_snapshot).schema.sections[0].elements[0].label, 'New label')
  assert.strictEqual(JSON.parse(fr.responses).q1, 'kept')
  db.close()
})

// ─── Small pure helpers ─────────────────────────────────────────────────────────

test('util: safeJsonParse returns parsed value, or the fallback on bad/empty input', () => {
  assert.deepStrictEqual(sync.safeJsonParse('{"a":1}', null), { a: 1 })
  assert.deepStrictEqual(sync.safeJsonParse('not json', { fb: true }), { fb: true })
  assert.strictEqual(sync.safeJsonParse('', 42), 42) // empty string throws → fallback
  assert.strictEqual(sync.safeJsonParse(undefined, 'x'), 'x')
})

test('config_version: bumpConfigVersion increments by exactly one', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const before = db.prepare('SELECT config_version FROM projects WHERE id=?').get(p).config_version
  sync.bumpConfigVersion(db, p)
  sync.bumpConfigVersion(db, p)
  const after = db.prepare('SELECT config_version FROM projects WHERE id=?').get(p).config_version
  assert.strictEqual(after, before + 2)
  db.close()
})

// ─── Manifest helpers ───────────────────────────────────────────────────────────

test('manifest: buildManifest reflects config_version and round-trips through readLocalManifest', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  sync.bumpConfigVersion(db, p) // 1 → 2
  const m = sync.buildManifest(db, p)
  assert.strictEqual(m.config_version, 2)

  const dir = tmpDir('sdmo-manifest-')
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m))
  assert.strictEqual(sync.readLocalManifest(dir).config_version, 2)
  // Missing folder/file → null, never throws.
  assert.strictEqual(sync.readLocalManifest(path.join(dir, 'nope')), null)
  db.close()
})

// ─── Structure-tombstone recorders (run before the actual delete) ───────────────

test('structure tombstone: recordEncounterTombstone records the encounter AND its child media', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const enc = addEncounter(db, p, 'E')
  const m1 = addMedia(db, enc.id, 'a.mp4')
  const m2 = addMedia(db, enc.id, 'b.mp4')

  sync.recordEncounterTombstone(db, p, enc.id)

  const tombs = sync.buildStructureTombstones(db, p)
  assert.deepStrictEqual(tombs.map(t => t.kind).sort(), ['encounter', 'media', 'media'])
  assert.deepStrictEqual(
    tombs.filter(t => t.kind === 'media').map(t => t.sync_id).sort(),
    [m1.sync_id, m2.sync_id].sort()
  )
  // Recording does NOT delete the row — the delete handler does that afterwards.
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM encounters WHERE id=?').get(enc.id).n, 1)
  db.close()
})

test('structure tombstone: recordMediaTombstone records a single media sync_id', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const enc = addEncounter(db, p, 'E')
  const m = addMedia(db, enc.id, 'a.mp4')

  sync.recordMediaTombstone(db, p, m.id)

  const tombs = sync.buildStructureTombstones(db, p)
  assert.strictEqual(tombs.length, 1)
  assert.strictEqual(tombs[0].kind, 'media')
  assert.strictEqual(tombs[0].sync_id, m.sync_id)
  db.close()
})

// ─── Config push to a local folder ──────────────────────────────────────────────

test('syncConfigLocal: when local is newer it writes project-config.json + manifest.json', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  addForm(db, p, 'Intake', { sections: [] })
  sync.bumpConfigVersion(db, p) // 2 > empty folder (0)

  const dir = tmpDir('sdmo-cfg-')
  sync.syncConfigLocal(db, p, dir)

  assert.ok(fs.existsSync(path.join(dir, 'project-config.json')))
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  assert.strictEqual(manifest.config_version, 2)
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'project-config.json'), 'utf8'))
  assert.strictEqual(cfg.config_version, 2)
  assert.strictEqual(cfg.forms.length, 1)
  db.close()
})

// ─── Legacy export/import (manual Save File / Import File flow) ──────────────────

test('legacy import: mergeImport ADDS structure and never prunes existing items', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  // A pre-existing encounter absent from the import payload must survive.
  addEncounter(db, p, 'Keep')

  const res = sync.mergeImport(db, p, {
    sdmo: true, version: 3, project: { name: 'P' },
    forms: [{ name: 'F', schema: { sections: [] } }],
    media_types: [],
    encounters: [{ sync_id: 'enc-new', name: 'New', media: [] }],
  })

  assert.strictEqual(res.formsAdded, 1)
  const names = db.prepare('SELECT name FROM encounters WHERE project_id=? ORDER BY name').all(p).map(e => e.name)
  assert.deepStrictEqual(names, ['Keep', 'New'])
  db.close()
})

test('legacy export/import: buildExport → createFromImport clones a project incl. reviews', () => {
  const src = makeDb()
  const p1 = createProject(src, 'Study')
  const formId = addForm(src, p1, 'Intake', {
    sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'text', label: 'Q' }] }],
  })
  const mtId = addMediaType(src, p1, 'Video')
  addWorkspaceTab(src, mtId, { tab_type: 'form', ref_id: formId, label: 'Intake', sort_order: 0 })
  const enc = addEncounter(src, p1, 'P1')
  const media = addMedia(src, enc.id, 'v.mp4', { media_type_id: mtId })
  const rev = addReview(src, media.id, 'Alice', { status: 'submitted' })
  src.prepare('INSERT INTO form_responses (review_id, form_id, responses) VALUES (?,?,?)')
    .run(rev.id, formId, JSON.stringify({ q1: 'Yes' }))
  src.prepare('INSERT INTO timestamps (review_id, time_seconds, tag_label, notes) VALUES (?,?,?,?)')
    .run(rev.id, 30, null, 'note')

  const data = sync.buildExport(src, p1)
  const dst = makeDb()
  const p2 = sync.createFromImport(dst, data)

  assert.strictEqual(dst.prepare('SELECT name FROM projects WHERE id=?').get(p2).name, 'Study')
  assert.strictEqual(dst.prepare('SELECT COUNT(*) n FROM forms WHERE project_id=?').get(p2).n, 1)
  assert.strictEqual(dst.prepare('SELECT COUNT(*) n FROM media_types WHERE project_id=?').get(p2).n, 1)

  const r = dst.prepare(`
    SELECT r.* FROM reviews r
    JOIN media_files m ON r.media_file_id=m.id
    JOIN encounters e ON m.encounter_id=e.id
    WHERE e.project_id=?`).get(p2)
  assert.ok(r, 'review cloned')
  assert.strictEqual(r.reviewer_name, 'Alice')
  assert.strictEqual(r.status, 'submitted')
  assert.deepStrictEqual(JSON.parse(dst.prepare('SELECT responses FROM form_responses WHERE review_id=?').get(r.id).responses), { q1: 'Yes' })
  assert.strictEqual(dst.prepare('SELECT time_seconds FROM timestamps WHERE review_id=?').get(r.id).time_seconds, 30)
  src.close(); dst.close()
})

test('legacy import: an in_progress review is upgraded in place when a submitted copy arrives', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const enc = addEncounter(db, p, 'P1')
  const media = addMedia(db, enc.id, 'v.mp4')
  addReview(db, media.id, 'Alice', { status: 'in_progress' })

  sync.mergeImport(db, p, {
    sdmo: true, version: 3, project: { name: 'P' },
    encounters: [{
      sync_id: enc.sync_id, name: 'P1',
      media: [{ sync_id: media.sync_id, name: 'v.mp4', file_type: 'video', media_type_name: null,
        reviews: [{ reviewer_name: 'Alice', status: 'submitted', submitted_at: '2026-01-01T00:00:00Z', timestamps: [], form_responses: [] }] }],
    }],
  })

  // Same reviewer + media → updated in place, not duplicated.
  const rows = db.prepare('SELECT status FROM reviews WHERE media_file_id=?').all(media.id)
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].status, 'submitted')
  db.close()
})

// ─── Full local-folder sync between two "machines" (separate DBs, shared folder) ─

test('doLocalSync: two machines exchange full project state through a shared folder', async () => {
  const folder = tmpDir('sdmo-sync-')

  // Machine A — authoritative structure + Alice's submitted review.
  const a = makeDb()
  const pa = createProject(a, 'Study')
  const formId = addForm(a, pa, 'Intake', {
    sections: [{ id: 's1', title: 'S', elements: [{ id: 'q1', type: 'text', label: 'Q' }] }],
  })
  const mtId = addMediaType(a, pa, 'Video')
  addWorkspaceTab(a, mtId, { tab_type: 'form', ref_id: formId, label: 'Intake', sort_order: 0 })
  const encA = addEncounter(a, pa, 'P1', 'enc-1')
  const mediaA = addMedia(a, encA.id, 'v.mp4', { media_type_id: mtId, sync_id: 'media-1' })
  const revA = addReview(a, mediaA.id, 'Alice', { reviewer_uuid: 'uuid-A', status: 'submitted' })
  a.prepare('INSERT INTO form_responses (review_id, form_id, responses) VALUES (?,?,?)')
    .run(revA.id, formId, JSON.stringify({ q1: 'Yes' }))
  sync.bumpConfigVersion(a, pa) // bump so peers (default v1) will pull

  await sync.doLocalSync(a, pa, folder, 'uuid-A', 'Alice')

  assert.ok(fs.existsSync(path.join(folder, sync.PROJECT_STATE_FILENAME)), 'project state written')
  assert.ok(fs.existsSync(path.join(folder, 'manifest.json')), 'manifest written')
  assert.ok(!fs.existsSync(path.join(folder, 'reviews-export.xlsx')), 'xlsx report is NOT auto-written during sync')
  const state = JSON.parse(fs.readFileSync(path.join(folder, sync.PROJECT_STATE_FILENAME), 'utf8'))
  assert.strictEqual(state.protocol_version, sync.SYNC_PROTOCOL_VERSION)
  assert.strictEqual(state.layout, 'split-v1')
  assert.strictEqual(state.forms.length, 1)
  assert.strictEqual(state.reviews.length, 1, 'review index included in shared project state')
  assert.ok(state.reviews[0].path.startsWith('reviews/'), 'review payload is split out of project-state')
  assert.strictEqual(state.reviews[0].timestamps, undefined, 'project-state stores review metadata, not full timestamps')
  assert.ok(fs.existsSync(path.join(folder, state.reviews[0].path)), 'split review payload written')
  assert.ok(state.form_versions[0].path.startsWith('form-versions/'), 'form version payload is split out')
  assert.ok(fs.existsSync(path.join(folder, state.form_versions[0].path)), 'split form version payload written')

  // Machine B — fresh placeholder project pulls A's structure + Alice's review.
  const b = makeDb()
  const pb = createProject(b, 'Placeholder')
  await sync.doLocalSync(b, pb, folder, 'uuid-B', 'Bob')

  assert.strictEqual(b.prepare('SELECT COUNT(*) n FROM encounters WHERE project_id=?').get(pb).n, 1)
  assert.strictEqual(b.prepare('SELECT COUNT(*) n FROM forms WHERE project_id=?').get(pb).n, 1)
  const aliceOnB = b.prepare(`
    SELECT r.reviewer_name FROM reviews r
    JOIN media_files m ON r.media_file_id=m.id
    JOIN encounters e ON m.encounter_id=e.id
    WHERE e.project_id=? AND r.deleted_at IS NULL`).all(pb).map(x => x.reviewer_name)
  assert.deepStrictEqual(aliceOnB, ['Alice'], 'Alice review pulled onto B')

  // B adds Bob's own review and syncs it back up.
  const bMediaId = b.prepare(`SELECT m.id FROM media_files m JOIN encounters e ON m.encounter_id=e.id WHERE e.project_id=?`).get(pb).id
  addReview(b, bMediaId, 'Bob', { reviewer_uuid: 'uuid-B', status: 'in_progress' })
  await sync.doLocalSync(b, pb, folder, 'uuid-B', 'Bob')
  const stateAfterBob = JSON.parse(fs.readFileSync(path.join(folder, sync.PROJECT_STATE_FILENAME), 'utf8'))
  assert.strictEqual(stateAfterBob.reviews.length, 2, "Bob's review merged into project-state index")
  assert.ok(stateAfterBob.reviews.every(r => fs.existsSync(path.join(folder, r.path))), 'all indexed review payloads exist')

  // A syncs again and now sees both reviewers.
  await sync.doLocalSync(a, pa, folder, 'uuid-A', 'Alice')
  const reviewersOnA = a.prepare(`
    SELECT DISTINCT r.reviewer_name FROM reviews r
    JOIN media_files m ON r.media_file_id=m.id
    JOIN encounters e ON m.encounter_id=e.id
    WHERE e.project_id=? AND r.deleted_at IS NULL ORDER BY r.reviewer_name`).all(pa).map(x => x.reviewer_name)
  assert.deepStrictEqual(reviewersOnA, ['Alice', 'Bob'])

  a.close(); b.close()
})

test('doLocalSync: a structure tombstone deletes the item on a peer and snapshot state cannot resurrect it', async () => {
  const folder = tmpDir('sdmo-sync-tomb-')

  // A publishes structure (one encounter) at a bumped version.
  const a = makeDb()
  const pa = createProject(a, 'Study')
  const encA = addEncounter(a, pa, 'P1', 'enc-1')
  addMedia(a, encA.id, 'v.mp4', { sync_id: 'media-1' })
  sync.bumpConfigVersion(a, pa)
  await sync.doLocalSync(a, pa, folder, 'uuid-A', 'Alice')

  // B pulls it.
  const b = makeDb()
  const pb = createProject(b, 'Placeholder')
  await sync.doLocalSync(b, pb, folder, 'uuid-B', 'Bob')
  assert.strictEqual(b.prepare('SELECT COUNT(*) n FROM encounters WHERE project_id=?').get(pb).n, 1)

  // A deletes the encounter (record tombstone first, then delete the rows), and syncs.
  sync.recordEncounterTombstone(a, pa, encA.id)
  a.prepare('DELETE FROM encounters WHERE id=?').run(encA.id)
  await sync.doLocalSync(a, pa, folder, 'uuid-A', 'Alice')
  const state = JSON.parse(fs.readFileSync(path.join(folder, sync.PROJECT_STATE_FILENAME), 'utf8'))
  assert.strictEqual(state.deleted_structure.length, 2, 'structure tombstones included in project state')

  // B syncs: the tombstone removes it, and the still-present config entry must NOT resurrect it.
  await sync.doLocalSync(b, pb, folder, 'uuid-B', 'Bob')
  assert.strictEqual(b.prepare('SELECT COUNT(*) n FROM encounters WHERE project_id=?').get(pb).n, 0)

  a.close(); b.close()
})

test('doLocalSync: concurrent structure edits on two machines converge (self-heal, no loss)', async () => {
  const folder = tmpDir('sdmo-converge-')
  const formNames = (db, pid) => db.prepare('SELECT name FROM forms WHERE project_id=? ORDER BY name').all(pid).map(f => f.name)

  // Same-named project on both machines so project-meta never diverges; focus is structure.
  const a = makeDb(); const pa = createProject(a, 'Study')
  addForm(a, pa, 'Shared', { sections: [] }, { sync_id: 'shared' })
  await sync.doLocalSync(a, pa, folder, 'uuid-A', 'Alice')

  const b = makeDb(); const pb = createProject(b, 'Study')
  await sync.doLocalSync(b, pb, folder, 'uuid-B', 'Bob')
  assert.deepStrictEqual(formNames(b, pb), ['Shared'])

  // Both machines add a DIFFERENT form before syncing — the classic concurrent edit.
  addForm(a, pa, 'A-only', { sections: [] }, { sync_id: 'a-only' })
  addForm(b, pb, 'B-only', { sections: [] }, { sync_id: 'b-only' })

  await sync.doLocalSync(a, pa, folder, 'uuid-A', 'Alice') // publishes Shared + A-only
  await sync.doLocalSync(b, pb, folder, 'uuid-B', 'Bob')   // pulls A-only, keeps B-only, republishes all
  await sync.doLocalSync(a, pa, folder, 'uuid-A', 'Alice') // pulls B-only

  const expected = ['A-only', 'B-only', 'Shared']
  assert.deepStrictEqual(formNames(a, pa), expected, 'A has all three — nothing lost')
  assert.deepStrictEqual(formNames(b, pb), expected, 'B has all three — nothing lost')
  assert.strictEqual(sync.structureFingerprint(a, pa), sync.structureFingerprint(b, pb), 'fully converged')

  a.close(); b.close()
})

test('doLocalSync: legacy sync folder is migrated forward to project-state.json', async () => {
  const folder = tmpDir('sdmo-legacy-migrate-')

  const legacy = makeDb()
  const pLegacy = createProject(legacy, 'Legacy Study')
  const enc = addEncounter(legacy, pLegacy, 'P1', 'enc-legacy')
  const media = addMedia(legacy, enc.id, 'visit.mp4', { sync_id: 'media-legacy' })
  addReview(legacy, media.id, 'Alice', { reviewer_uuid: 'uuid-A', status: 'submitted' })
  sync.bumpConfigVersion(legacy, pLegacy)
  sync.syncConfigLocal(legacy, pLegacy, folder)
  fs.mkdirSync(path.join(folder, 'reviews'), { recursive: true })
  fs.writeFileSync(
    path.join(folder, 'reviews', 'uuid-A.json'),
    JSON.stringify(sync.buildReviewExport(legacy, pLegacy, 'uuid-A', 'Alice'), null, 2)
  )

  const fresh = makeDb()
  const pFresh = createProject(fresh, 'Placeholder')
  await sync.doLocalSync(fresh, pFresh, folder, 'uuid-B', 'Bob')

  assert.ok(fs.existsSync(path.join(folder, sync.PROJECT_STATE_FILENAME)), 'legacy folder rewritten to protocol v2')
  assert.strictEqual(fresh.prepare('SELECT COUNT(*) n FROM encounters WHERE project_id=?').get(pFresh).n, 1)
  assert.strictEqual(
    fresh.prepare(`
      SELECT COUNT(*) n FROM reviews r
      JOIN media_files mf ON r.media_file_id = mf.id
      JOIN encounters e ON mf.encounter_id = e.id
      WHERE e.project_id=? AND r.deleted_at IS NULL
    `).get(pFresh).n,
    1
  )

  legacy.close(); fresh.close()
})
