const assert = require('node:assert')
const { test } = require('./_harness')
const sync = require('../electron/sync')
const {
  makeDb, createProject, addForm, addMediaType, addWorkspaceTab,
  addEncounter, addMedia, addReview,
} = require('./helpers')

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

// ─── Config prune must never destroy reviewer work ──────────────────────────────

test('config: prune removes a reviewless encounter not in config', () => {
  const db = makeDb()
  const p = createProject(db, 'P')
  const keep = addEncounter(db, p, 'Keep')
  addMedia(db, keep.id, 'k.mp4')
  const drop = addEncounter(db, p, 'Drop')
  addMedia(db, drop.id, 'd.mp4')

  const config = {
    sdmo: true, version: 4, config_version: 999, project: { name: 'P' },
    forms: [], instructions: [], media_types: [],
    encounters: [{ sync_id: keep.sync_id, name: 'Keep', media: [{ sync_id: null, name: 'k.mp4', file_type: 'video', media_type_name: null }] }],
  }
  sync.mergeConfigImport(db, p, config, { force: true })

  const names = db.prepare('SELECT name FROM encounters WHERE project_id=?').all(p).map(r => r.name)
  assert.deepStrictEqual(names, ['Keep'])
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
