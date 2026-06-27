import React, { useState } from 'react'
import { ChevronLeft, Plus, Trash2, GripVertical, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { api } from '../../lib/api'

const ELEMENT_TYPES = [
  { type: 'short_answer', label: 'Short Answer' },
  { type: 'paragraph', label: 'Paragraph' },
  { type: 'multiple_choice', label: 'Multiple Choice' },
  { type: 'multiselect', label: 'Multi-Select' },
  { type: 'likert', label: 'Likert Scale' },
  { type: 'likert_group', label: 'Likert Group' },
  { type: 'rating', label: 'Rating (labeled)' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'slider', label: 'Slider' },
  { type: 'text_block', label: 'Text Block' },
]

function newId() { return `el_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }

export default function FormBuilder({ projectId, form, onSave, onCancel }) {
  const [name, setName] = useState(form.name || '')
  const [sections, setSections] = useState(form.schema?.sections || [])
  const [collapsed, setCollapsed] = useState({})
  const [saving, setSaving] = useState(false)

  function addSection() {
    setSections(s => [...s, { id: newId(), title: 'New Section', description: '', elements: [] }])
  }

  function updateSection(id, changes) {
    setSections(s => s.map(sec => sec.id === id ? { ...sec, ...changes } : sec))
  }

  function removeSection(id) {
    setSections(s => s.filter(sec => sec.id !== id))
  }

  function duplicateSection(sec) {
    const copy = JSON.parse(JSON.stringify(sec))
    copy.id = newId()
    copy.title = sec.title + ' (copy)'
    copy.elements = copy.elements.map(el => ({ ...el, id: newId() }))
    setSections(s => [...s, copy])
  }

  function addElement(sectionId, type) {
    const el = makeElement(type)
    setSections(s => s.map(sec => sec.id === sectionId ? { ...sec, elements: [...sec.elements, el] } : sec))
  }

  function updateElement(sectionId, elId, changes) {
    setSections(s => s.map(sec => {
      if (sec.id !== sectionId) return sec
      return { ...sec, elements: sec.elements.map(el => el.id === elId ? { ...el, ...changes } : el) }
    }))
  }

  function removeElement(sectionId, elId) {
    setSections(s => s.map(sec => {
      if (sec.id !== sectionId) return sec
      return { ...sec, elements: sec.elements.filter(el => el.id !== elId) }
    }))
  }

  async function handleSave() {
    if (!name.trim()) return
    setSaving(true)
    await api.saveForm(projectId, { id: form.id || undefined, name: name.trim(), schema: { sections } })
    onSave()
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{
        height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 20px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        WebkitAppRegion: 'drag',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' }}>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onCancel}><ChevronLeft size={16} /></button>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Form name"
            style={{ fontWeight: 600, fontSize: 14, border: 'none', background: 'transparent', outline: 'none', width: 240, padding: 0 }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, WebkitAppRegion: 'no-drag' }}>
          <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={!name.trim() || saving}>
            {saving ? 'Saving…' : 'Save Form'}
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '28px 0' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {sections.map(sec => (
            <SectionEditor
              key={sec.id}
              section={sec}
              collapsed={!!collapsed[sec.id]}
              onToggle={() => setCollapsed(c => ({ ...c, [sec.id]: !c[sec.id] }))}
              onChange={(changes) => updateSection(sec.id, changes)}
              onRemove={() => removeSection(sec.id)}
              onDuplicate={() => duplicateSection(sec)}
              onAddElement={(type) => addElement(sec.id, type)}
              onUpdateElement={(elId, changes) => updateElement(sec.id, elId, changes)}
              onRemoveElement={(elId) => removeElement(sec.id, elId)}
            />
          ))}
          <button className="btn btn-secondary" onClick={addSection} style={{ alignSelf: 'flex-start' }}>
            <Plus size={14} /> Add Section
          </button>
        </div>
      </div>
    </div>
  )
}

function SectionEditor({ section, collapsed, onToggle, onChange, onRemove, onDuplicate, onAddElement, onUpdateElement, onRemoveElement }) {
  const [showAddEl, setShowAddEl] = useState(false)
  const dropdownRef = React.useRef(null)

  React.useEffect(() => {
    if (!showAddEl) return
    const handler = (e) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setShowAddEl(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAddEl])

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
      <div style={{ background: 'var(--bg-secondary)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, borderRadius: '10px 10px 0 0' }}>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onToggle}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <input
          value={section.title}
          onChange={e => onChange({ title: e.target.value })}
          placeholder="Section title"
          style={{ flex: 1, fontWeight: 600, fontSize: 14, border: 'none', background: 'transparent', outline: 'none', padding: 0 }}
        />
        <button className="btn btn-ghost btn-icon btn-sm" title="Duplicate section" onClick={onDuplicate}><Copy size={13} /></button>
        <button className="btn btn-ghost btn-icon btn-sm" title="Remove section" onClick={onRemove}><Trash2 size={13} /></button>
      </div>

      {!collapsed && (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            value={section.description || ''}
            onChange={e => onChange({ description: e.target.value })}
            placeholder="Section description (optional)"
            style={{ fontSize: 13, color: 'var(--text-secondary)' }}
          />

          {section.elements.map(el => (
            <ElementEditor key={el.id} el={el} onChange={changes => onUpdateElement(el.id, changes)} onRemove={() => onRemoveElement(el.id)} />
          ))}

          <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowAddEl(s => !s)}>
              <Plus size={13} /> Add Question
            </button>
            {showAddEl && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, zIndex: 9999,
                background: 'var(--bg)', border: '1px solid var(--border)',
                borderRadius: 8, boxShadow: 'var(--shadow-lg)', overflow: 'hidden', minWidth: 180, marginTop: 4,
              }}>
                {ELEMENT_TYPES.map(et => (
                  <button key={et.type} className="dropdown-item" onClick={() => { onAddElement(et.type); setShowAddEl(false) }}>
                    {et.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ElementEditor({ el, onChange, onRemove }) {
  const typeLabel = ELEMENT_TYPES.find(t => t.type === el.type)?.label

  if (el.type === 'text_block') {
    return (
      <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span className="text-secondary text-sm">Text Block</span>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onRemove}><Trash2 size={12} /></button>
        </div>
        <textarea value={el.content || ''} onChange={e => onChange({ content: e.target.value })} placeholder="Instructional text…" rows={2} style={{ fontSize: 13 }} />
      </div>
    )
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {el.type !== 'checkbox' && (
          <input
            value={el.label || ''}
            onChange={e => onChange({ label: e.target.value })}
            placeholder={el.type === 'likert_group' ? 'Group header (optional)' : 'Question text'}
            style={{ flex: 1, fontWeight: 500 }}
          />
        )}
        {el.type === 'checkbox' && (
          <input
            value={el.label || ''}
            onChange={e => onChange({ label: e.target.value })}
            placeholder="Checkbox label text"
            style={{ flex: 1, fontWeight: 500 }}
          />
        )}
        {el.type !== 'checkbox' && el.type !== 'likert_group' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', marginBottom: 0, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={!!el.required} onChange={e => onChange({ required: e.target.checked })} />
            Required
          </label>
        )}
        <span className="badge badge-muted" style={{ fontSize: 10 }}>{typeLabel}</span>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onRemove}><Trash2 size={12} /></button>
      </div>

      {(el.type === 'multiple_choice' || el.type === 'multiselect' || el.type === 'rating') && (
        <OptionsEditor options={el.options || []} onChange={opts => onChange({ options: opts })} />
      )}

      {el.type === 'likert' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="form-field" style={{ flex: 1, minWidth: 100 }}>
              <label>Scale</label>
              <select value={el.scale || 5} onChange={e => onChange({ scale: Number(e.target.value) })} style={{ height: 32, fontSize: 13 }}>
                {[3,4,5,6,7].map(n => <option key={n} value={n}>{n}-point</option>)}
              </select>
            </div>
            <div className="form-field" style={{ flex: 2, minWidth: 120 }}>
              <label>Low label</label>
              <input value={el.low_label || ''} onChange={e => onChange({ low_label: e.target.value })} placeholder="e.g. Strongly Disagree" style={{ height: 32, fontSize: 13 }} />
            </div>
            <div className="form-field" style={{ flex: 2, minWidth: 120 }}>
              <label>High label</label>
              <input value={el.high_label || ''} onChange={e => onChange({ high_label: e.target.value })} placeholder="e.g. Strongly Agree" style={{ height: 32, fontSize: 13 }} />
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginBottom: 0 }}>
            <input type="checkbox" checked={!!el.has_na} onChange={e => onChange({ has_na: e.target.checked })} />
            Include N/A option
          </label>
        </div>
      )}

      {el.type === 'likert_group' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            value={el.description || ''}
            onChange={e => onChange({ description: e.target.value })}
            placeholder="Group description (optional)"
            style={{ fontSize: 13 }}
          />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="form-field" style={{ flex: 1, minWidth: 100 }}>
              <label>Scale</label>
              <select value={el.scale || 5} onChange={e => onChange({ scale: Number(e.target.value) })} style={{ height: 32, fontSize: 13 }}>
                {[3,4,5,6,7].map(n => <option key={n} value={n}>{n}-point</option>)}
              </select>
            </div>
            <div className="form-field" style={{ flex: 2, minWidth: 120 }}>
              <label>Low label</label>
              <input value={el.low_label || ''} onChange={e => onChange({ low_label: e.target.value })} placeholder="e.g. Strongly Disagree" style={{ height: 32, fontSize: 13 }} />
            </div>
            <div className="form-field" style={{ flex: 2, minWidth: 120 }}>
              <label>High label</label>
              <input value={el.high_label || ''} onChange={e => onChange({ high_label: e.target.value })} placeholder="e.g. Strongly Agree" style={{ height: 32, fontSize: 13 }} />
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginBottom: 0 }}>
            <input type="checkbox" checked={!!el.has_na} onChange={e => onChange({ has_na: e.target.checked })} />
            Include N/A option
          </label>
          <LikertGroupItemsEditor items={el.items || []} onChange={items => onChange({ items })} />
        </div>
      )}

      {el.type === 'slider' && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[['min','Min',0],['max','Max',100],['step','Step',1]].map(([key,lbl,def]) => (
            <div key={key} className="form-field" style={{ flex: 1, minWidth: 70 }}>
              <label>{lbl}</label>
              <input type="number" value={el[key] ?? def} onChange={e => onChange({ [key]: Number(e.target.value) })} style={{ height: 32, fontSize: 13 }} />
            </div>
          ))}
          <div className="form-field" style={{ flex: 2, minWidth: 120 }}>
            <label>Low label</label>
            <input value={el.low_label || ''} onChange={e => onChange({ low_label: e.target.value })} style={{ height: 32, fontSize: 13 }} />
          </div>
          <div className="form-field" style={{ flex: 2, minWidth: 120 }}>
            <label>High label</label>
            <input value={el.high_label || ''} onChange={e => onChange({ high_label: e.target.value })} style={{ height: 32, fontSize: 13 }} />
          </div>
        </div>
      )}

      {(el.type === 'short_answer' || el.type === 'paragraph') && (
        <input value={el.placeholder || ''} onChange={e => onChange({ placeholder: e.target.value })} placeholder="Placeholder text (optional)" style={{ fontSize: 13 }} />
      )}
    </div>
  )
}

function OptionsEditor({ options, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {options.map((opt, i) => (
        <div key={i} style={{ display: 'flex', gap: 6 }}>
          <input value={opt} onChange={e => { const o = [...options]; o[i] = e.target.value; onChange(o) }} style={{ fontSize: 13 }} />
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => onChange(options.filter((_, j) => j !== i))}><Trash2 size={12} /></button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={() => onChange([...options, ''])} style={{ alignSelf: 'flex-start', fontSize: 12 }}>
        <Plus size={12} /> Add Option
      </button>
    </div>
  )
}

function LikertGroupItemsEditor({ items, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Statements</span>
      {items.map((item, i) => (
        <div key={item.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 18, textAlign: 'right' }}>{i + 1}.</span>
          <input
            value={item.label || ''}
            onChange={e => { const arr = items.map((it, j) => j === i ? { ...it, label: e.target.value } : it); onChange(arr) }}
            placeholder="Statement text"
            style={{ flex: 1, fontSize: 13 }}
          />
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 size={12} /></button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={() => onChange([...items, { id: newId(), label: '' }])} style={{ alignSelf: 'flex-start', fontSize: 12 }}>
        <Plus size={12} /> Add Statement
      </button>
    </div>
  )
}

function makeElement(type) {
  const base = { id: newId(), type, label: '', required: false }
  if (type === 'multiple_choice' || type === 'multiselect') return { ...base, options: ['Option 1', 'Option 2'] }
  if (type === 'rating') return { ...base, options: ['Option 1', 'Option 2', 'Option 3', 'Option 4'] }
  if (type === 'likert') return { ...base, scale: 5, low_label: '', high_label: '', has_na: false }
  if (type === 'likert_group') return { id: newId(), type: 'likert_group', label: '', description: '', scale: 5, low_label: '', high_label: '', has_na: false, items: [{ id: newId(), label: '' }] }
  if (type === 'checkbox') return { id: newId(), type: 'checkbox', label: '', required: false }
  if (type === 'slider') return { ...base, min: 0, max: 100, step: 1, low_label: '', high_label: '' }
  if (type === 'text_block') return { id: newId(), type: 'text_block', content: '' }
  return base
}
