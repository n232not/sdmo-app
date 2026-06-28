import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle2, Edit2, AlertCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../lib/api'
import FormRenderer from '../components/forms/FormRenderer'
import Modal from '../components/ui/Modal'

export default function WorkspacePage() {
  const { reviewId } = useParams()

  const [review, setReview] = useState(null)
  const [mediaFile, setMediaFile] = useState(null)
  const [workspaceTabs, setWorkspaceTabs] = useState([])
  const [formSchemas, setFormSchemas] = useState({})
  const [instructions, setInstructions] = useState({})
  const [formResponses, setFormResponses] = useState({})

  const [activeTab, setActiveTab] = useState(0)
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showSubmit, setShowSubmit] = useState(false)
  const [validationErrors, setValidationErrors] = useState([])
  const [saveError, setSaveError] = useState(null)

  useEffect(() => { load() }, [reviewId])

  // Single function that refreshes submitted + form data from DB
  function refreshReviewData(id) {
    api.getReview(id).then(rev => {
      if (!rev) return
      setSubmitted(rev.status === 'submitted')
      const respMap = {}
      for (const fr of (rev.form_responses || [])) respMap[fr.form_id] = fr.responses
      setFormResponses(respMap)
    })
  }

  // Stay in sync when the main ReviewPage window submits/unsubmits
  useEffect(() => {
    function onReviewUpdated(updatedId) {
      if (String(updatedId) === String(reviewId)) refreshReviewData(reviewId)
    }
    const subId = api.onReviewUpdated(onReviewUpdated)
    return () => api.offReviewUpdated(subId)
  }, [reviewId])

  async function load() {
    setLoading(true)
    const rev = await api.getReview(reviewId)
    if (!rev) { setLoading(false); return }
    setReview(rev)
    setSubmitted(rev.status === 'submitted')

    const respMap = {}
    for (const fr of (rev.form_responses || [])) respMap[fr.form_id] = fr.responses
    setFormResponses(respMap)

    const mf = await api.getMediaFile(rev.media_file_id)
    setMediaFile(mf)
    if (!mf?.encounter_id) { setLoading(false); return }

    const enc = await api.getEncounter(mf.encounter_id)
    if (!enc) { setLoading(false); return }

    const allTypes = await api.listMediaTypes(enc.project_id)
    const mt = allTypes.find(t => t.id === mf.media_type_id)
    if (!mt) { setLoading(false); return }

    setWorkspaceTabs(mt.workspace_tabs || [])

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

  const saveFormResponse = useCallback(async (formId, responses) => {
    try {
      await api.saveFormResponse(reviewId, { form_id: formId, responses })
      setFormResponses(r => ({ ...r, [formId]: responses }))
      setSaveError(null)
      api.notifyReviewUpdate(reviewId).catch(() => {})
    } catch (e) {
      console.error('[WorkspacePage] saveFormResponse failed:', e)
      setSaveError('Save failed — check console for details.')
    }
  }, [reviewId])

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
          const empty = val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0)
          if (empty) errors.push({ tab: tab.label, question: el.label })
        }
      }
    }
    return errors
  }

  function handleSubmitClick() {
    const errors = getRequiredErrors()
    if (errors.length > 0) setValidationErrors(errors)
    else { setValidationErrors([]); setShowSubmit(true) }
  }

  async function handleSubmit() {
    try {
      await api.submitReview(reviewId, {})
      setSubmitted(true)
      setShowSubmit(false)
      setSaveError(null)
      api.notifyReviewUpdate(reviewId).catch(() => {})
    } catch (e) {
      console.error('[WorkspacePage] submitReview failed:', e)
      setSaveError('Submit failed — check console for details.')
    }
  }

  async function handleUnsubmit() {
    try {
      await api.unsubmitReview(reviewId)
      setSubmitted(false)
      setSaveError(null)
      api.notifyReviewUpdate(reviewId).catch(() => {})
    } catch (e) {
      console.error('[WorkspacePage] unsubmitReview failed:', e)
      setSaveError('Unsubmit failed — check console for details.')
    }
  }

  if (loading) return <div className="empty-state" style={{ height: '100vh' }}><div className="spinner" /></div>
  if (!review) return <div className="empty-state" style={{ height: '100vh' }}><p className="text-sm">Review not found.</p></div>

  const currentTab = workspaceTabs[activeTab]

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{
        height: 48, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        WebkitAppRegion: 'drag',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-muted)' }}>Workspace</span>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span className="truncate" style={{ fontWeight: 500, fontSize: 13, maxWidth: 300 }}>
            {mediaFile?.name}
          </span>
          {submitted && <span className="badge badge-success"><CheckCircle2 size={10} /> Submitted</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, WebkitAppRegion: 'no-drag' }}>
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

      {/* Save error banner */}
      {saveError && (
        <div style={{ background: 'var(--danger)', color: '#fff', padding: '6px 16px', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span><AlertCircle size={12} style={{ display: 'inline', marginRight: 6 }} />{saveError}</span>
          <button style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 14 }} onClick={() => setSaveError(null)}>✕</button>
        </div>
      )}

      {/* Tab bar */}
      {workspaceTabs.length > 0 && (
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div className="tabs" style={{ flex: 1, borderBottom: 'none' }}>
            {workspaceTabs.map((tab, i) => (
              <button key={tab.id} className={`tab-btn ${activeTab === i ? 'active' : ''}`} onClick={() => setActiveTab(i)}>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px', maxWidth: 820, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        {currentTab ? (
          currentTab.tab_type === 'form' ? (
            formSchemas[currentTab.ref_id]
              ? <FormRenderer
                  schema={formSchemas[currentTab.ref_id].schema}
                  responses={formResponses[currentTab.ref_id] || {}}
                  onSave={resp => saveFormResponse(currentTab.ref_id, resp)}
                  readOnly={submitted}
                />
              : <div className="empty-state"><p className="text-sm">Form not found.</p></div>
          ) : currentTab.tab_type === 'instruction' ? (
            (() => {
              const instr = instructions[currentTab.ref_id]
              if (!instr) return <div className="empty-state"><p className="text-sm">Instruction not found.</p></div>
              if (instr.content_type === 'pdf' && instr.file_path) {
                return <iframe src={`localfile://${encodeURIComponent(instr.file_path)}`} style={{ width: '100%', height: '100%', border: 'none', minHeight: 600 }} title={instr.name} />
              }
              return <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{instr.content || ''}</ReactMarkdown></div>
            })()
          ) : null
        ) : (
          <div className="empty-state"><p className="text-sm">No workspace tabs configured for this media type.</p></div>
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
        <p>Submit your review for <strong>{mediaFile?.name}</strong>? You can still edit it afterwards.</p>
        <p style={{ marginTop: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
          Forms filled: {Object.keys(formResponses).length}
        </p>
      </Modal>
    </div>
  )
}
