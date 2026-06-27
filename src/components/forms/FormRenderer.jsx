import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronDown, ChevronRight, Check } from 'lucide-react'

export default function FormRenderer({ schema, responses, onSave, readOnly }) {
  const sections = schema?.sections || []
  const manySections = sections.length > 3

  const [values, setValues] = useState(responses || {})
  const [collapsed, setCollapsed] = useState(() => {
    if (!manySections) return {}
    return Object.fromEntries(sections.map(s => [s.id, true]))
  })
  const [activeSection, setActiveSection] = useState(null)
  const sectionRefs = useRef({})

  useEffect(() => { setValues(responses || {}) }, [responses])

  const valuesRef = useRef(values)
  useEffect(() => { valuesRef.current = values }, [values])

  const handleChange = useCallback((qId, val) => {
    const next = { ...valuesRef.current, [qId]: val }
    valuesRef.current = next
    setValues(next)
    onSave(next)
  }, [onSave])

  function jumpTo(sectionId) {
    setActiveSection(sectionId)
    setCollapsed(c => ({ ...c, [sectionId]: false }))
    setTimeout(() => {
      sectionRefs.current[sectionId]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
  }

  if (!sections.length) {
    return <div className="empty-state"><p className="text-sm">This form has no sections yet.</p></div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

      {/* ── Jump bar ─────────────────────────────────────────────────────────── */}
      {sections.length > 1 && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 10,
          background: 'var(--bg)',
          paddingBottom: 12, marginBottom: 24,
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{
            background: 'var(--bg-secondary)',
            borderRadius: 10,
            padding: '4px 5px',
            display: 'flex', flexWrap: 'wrap', gap: 3,
          }}>
            {sections.map((section, i) => {
              const { answered, total } = countAnswered(section, values)
              const complete = total > 0 && answered === total
              const isActive = activeSection === section.id
              return (
                <button
                  key={section.id}
                  onClick={() => jumpTo(section.id)}
                  style={{
                    padding: '5px 11px', borderRadius: 7,
                    fontSize: 11, fontWeight: isActive ? 600 : 500,
                    border: isActive ? '1px solid var(--border)' : '1px solid transparent',
                    background: isActive ? 'var(--bg)' : complete ? 'rgba(34,197,94,0.1)' : 'transparent',
                    color: isActive ? 'var(--accent)' : complete ? 'var(--success, #22c55e)' : 'var(--text-muted)',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                    fontFamily: 'var(--font)', transition: 'all 0.12s', whiteSpace: 'nowrap',
                  }}
                >
                  {complete
                    ? <Check size={9} strokeWidth={3.5} />
                    : <span style={{ fontSize: 9, fontWeight: 700, opacity: 0.5 }}>{i + 1}</span>
                  }
                  {section.title || 'Section'}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Sections ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {sections.map((section, i) => (
          <FormSection
            key={section.id}
            section={section}
            sectionIndex={i}
            values={values}
            onChange={handleChange}
            collapsed={!!collapsed[section.id]}
            onToggle={() => {
              const opening = !!collapsed[section.id]
              if (opening) setActiveSection(section.id)
              setCollapsed(c => ({ ...c, [section.id]: !c[section.id] }))
            }}
            onAutoCollapse={() => setCollapsed(c => ({ ...c, [section.id]: true }))}
            sectionRef={el => { sectionRefs.current[section.id] = el }}
            readOnly={readOnly}
          />
        ))}
      </div>
    </div>
  )
}

function countAnswered(section, values) {
  const questions = (section.elements || []).filter(el => el.type !== 'text_block')
  const answered = questions.filter(el => {
    const v = values[el.id]
    if (v === null || v === undefined || v === '') return false
    if (Array.isArray(v)) return v.length > 0
    if (typeof v === 'object') return Object.keys(v).length > 0
    return true
  })
  return { answered: answered.length, total: questions.length }
}

function FormSection({ section, sectionIndex, values, onChange, collapsed, onToggle, onAutoCollapse, sectionRef, readOnly }) {
  const { answered, total } = countAnswered(section, values)
  const complete = total > 0 && answered === total

  const wasCompleteOnMount = useRef(complete)
  useEffect(() => {
    if (wasCompleteOnMount.current) return
    if (!complete) return
    const timer = setTimeout(() => onAutoCollapse(), 700)
    return () => clearTimeout(timer)
  }, [complete]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={sectionRef}>
      {/* Section header */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px',
          background: complete ? 'rgba(34,197,94,0.07)' : 'var(--bg-secondary)',
          borderRadius: collapsed ? 8 : '8px 8px 0 0',
          cursor: 'pointer', userSelect: 'none',
          transition: 'background 0.25s',
          borderLeft: `3px solid ${complete ? 'var(--success, #22c55e)' : 'var(--accent)'}`,
        }}
      >
        {/* Section number badge */}
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
          color: complete ? 'var(--success, #22c55e)' : 'var(--accent)',
          background: complete ? 'rgba(34,197,94,0.12)' : 'var(--accent-light)',
          padding: '2px 6px', borderRadius: 4, flexShrink: 0,
          minWidth: 24, textAlign: 'center',
          transition: 'color 0.25s, background 0.25s',
        }}>
          {String(sectionIndex + 1).padStart(2, '0')}
        </span>

        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '-0.01em', flex: 1 }}>
          {section.title || 'Section'}
        </span>

        {section.description && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{section.description}</span>
        )}

        {total > 0 && (
          <span style={{
            fontSize: 11, fontWeight: 600,
            color: complete ? 'var(--success, #22c55e)' : 'var(--text-muted)',
            flexShrink: 0, marginRight: 4,
            transition: 'color 0.25s',
          }}>
            {answered}/{total}
          </span>
        )}

        {collapsed
          ? <ChevronRight size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          : <ChevronDown size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        }
      </div>

      {/* Section content */}
      <div style={{
        maxHeight: collapsed ? 0 : 9999,
        opacity: collapsed ? 0 : 1,
        overflow: 'hidden',
        transition: 'max-height 0.2s ease, opacity 0.15s ease',
      }}>
        <div style={{
          padding: '18px 14px 6px 31px', // left indent aligns with title text
          display: 'flex', flexDirection: 'column', gap: 22,
          borderLeft: `3px solid ${complete ? 'rgba(34,197,94,0.25)' : 'var(--border)'}`,
          marginLeft: 0,
          transition: 'border-color 0.25s',
        }}>
          {(section.elements || []).map(el => (
            <FormElement
              key={el.id}
              el={el}
              value={values[el.id]}
              onChange={v => onChange(el.id, v)}
              readOnly={readOnly}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function FocusTextarea({ value, onChange, placeholder, disabled, rows = 3 }) {
  const [focused, setFocused] = useState(false)
  return (
    <textarea
      value={value || ''} onChange={onChange} placeholder={placeholder}
      disabled={disabled} rows={rows}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={{
        border: `1.5px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 8, padding: '9px 12px', width: '100%', outline: 'none',
        fontSize: 13, fontFamily: 'var(--font)', color: 'var(--text)',
        background: 'var(--bg)', transition: 'border-color 0.15s', resize: 'vertical',
      }}
    />
  )
}

function FocusInput({ value, onChange, placeholder, disabled }) {
  const [focused, setFocused] = useState(false)
  return (
    <input
      value={value || ''} onChange={onChange} placeholder={placeholder} disabled={disabled}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={{
        border: 'none',
        borderBottom: `1.5px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 0, padding: '5px 0', background: 'transparent',
        width: '100%', outline: 'none', fontSize: 13,
        fontFamily: 'var(--font)', color: 'var(--text)', transition: 'border-color 0.15s',
      }}
    />
  )
}

function ChoiceButton({ selected, onClick, readOnly, multiSelect, children }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      disabled={readOnly} onClick={onClick}
      onMouseEnter={() => !readOnly && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        width: '100%', textAlign: 'left', padding: '10px 14px',
        border: `1.5px solid ${selected ? 'var(--accent)' : hovered ? 'var(--border-strong)' : 'var(--border)'}`,
        borderRadius: 8,
        background: selected ? 'var(--accent-light)' : hovered ? 'var(--bg-secondary)' : 'transparent',
        cursor: readOnly ? 'default' : 'pointer',
        transition: 'border-color 0.12s, background 0.12s', fontFamily: 'var(--font)',
      }}
    >
      <div style={{
        width: 18, height: 18, flexShrink: 0,
        borderRadius: multiSelect ? 4 : '50%',
        border: `2px solid ${selected ? 'var(--accent)' : 'var(--border-strong)'}`,
        background: selected ? 'var(--accent)' : 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'border-color 0.12s, background 0.12s',
      }}>
        {selected && <Check size={10} color="#fff" strokeWidth={3.5} />}
      </div>
      <span style={{
        flex: 1, fontSize: 13, lineHeight: 1.4,
        color: selected ? 'var(--accent)' : 'var(--text)',
        fontWeight: selected ? 600 : 400, transition: 'color 0.12s',
      }}>
        {children}
      </span>
    </button>
  )
}

function SegmentedControl({ options, value, onChange, readOnly }) {
  return (
    <div style={{ display: 'flex' }}>
      {options.map((opt, i) => {
        const selected = value === opt
        const isFirst = i === 0
        const isLast = i === options.length - 1
        return (
          <button
            key={String(opt)} disabled={readOnly}
            onClick={() => !readOnly && onChange(value === opt ? undefined : opt)}
            style={{
              flex: 1, padding: '7px 4px',
              border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: isFirst ? '6px 0 0 6px' : isLast ? '0 6px 6px 0' : 0,
              marginLeft: isFirst ? 0 : -1.5,
              background: selected ? 'var(--accent-light)' : 'transparent',
              color: selected ? 'var(--accent)' : 'var(--text-secondary)',
              fontWeight: selected ? 700 : 400,
              fontSize: typeof opt === 'string' ? 12 : 14,
              cursor: readOnly ? 'default' : 'pointer',
              transition: 'background 0.1s, color 0.1s, border-color 0.1s',
              fontFamily: 'var(--font)', position: 'relative', zIndex: selected ? 1 : 0,
            }}
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}

function RadioDot({ selected, onClick, readOnly }) {
  return (
    <div
      onClick={readOnly ? undefined : onClick}
      style={{
        width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
        border: `2px solid ${selected ? 'var(--accent)' : 'var(--border-strong)'}`,
        background: selected ? 'var(--accent)' : 'transparent',
        cursor: readOnly ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'border-color 0.1s, background 0.1s',
      }}
    >
      {selected && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />}
    </div>
  )
}

function QLabel({ el }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: '-0.01em' }}>{el.label}</span>
      {el.required && <span style={{ color: 'var(--danger)', marginLeft: 3, fontSize: 12 }}>*</span>}
    </div>
  )
}

function FormElement({ el, value, onChange, readOnly }) {
  if (el.type === 'text_block') {
    return (
      <div style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.65, borderLeft: '2px solid var(--border)', paddingLeft: 10 }}>
        {el.content}
      </div>
    )
  }

  if (el.type === 'checkbox') {
    const checked = !!value
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: readOnly ? 'default' : 'pointer' }}
        onClick={() => !readOnly && onChange(!checked)}>
        <div style={{
          width: 18, height: 18, borderRadius: 4, flexShrink: 0, marginTop: 1,
          border: `2px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
          background: checked ? 'var(--accent)' : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'border-color 0.1s, background 0.1s',
        }}>
          {checked && <Check size={11} color="#fff" strokeWidth={3} />}
        </div>
        <span style={{ fontSize: 13, lineHeight: 1.5, fontWeight: 500 }}>
          {el.label}{el.required && <span style={{ color: 'var(--danger)', marginLeft: 3 }}>*</span>}
        </span>
      </div>
    )
  }

  if (el.type === 'likert_group') {
    const scale = el.scale || 5
    const points = Array.from({ length: scale }, (_, i) => i + 1)
    const COL_W = 38
    const items = el.items || []
    const groupVal = (typeof value === 'object' && value !== null && !Array.isArray(value)) ? value : {}
    return (
      <div>
        {el.label && <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: '-0.01em', marginBottom: el.description ? 3 : 10 }}>{el.label}</div>}
        {el.description && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.55 }}>{el.description}</div>}
        <div style={{ display: 'flex', alignItems: 'center', paddingBottom: 6, borderBottom: '1.5px solid var(--border)' }}>
          <div style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}>{el.low_label && `1 = ${el.low_label}`}</div>
          {el.has_na && <div style={{ width: COL_W, textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, flexShrink: 0 }}>N/A</div>}
          {points.map(p => <div key={p} style={{ width: COL_W, textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, flexShrink: 0 }}>{p}</div>)}
        </div>
        {items.map((item, i) => {
          const itemVal = groupVal[item.id]
          return (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', padding: '7px 6px', background: i % 2 === 1 ? 'rgba(0,0,0,0.025)' : 'transparent', borderRadius: 4 }}>
              <div style={{ flex: 1, fontSize: 13, paddingRight: 10, lineHeight: 1.4 }}>{item.label}</div>
              {el.has_na && (
                <div style={{ width: COL_W, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                  <RadioDot selected={itemVal === 'N/A'} onClick={() => onChange({ ...groupVal, [item.id]: itemVal === 'N/A' ? undefined : 'N/A' })} readOnly={readOnly} />
                </div>
              )}
              {points.map(p => (
                <div key={p} style={{ width: COL_W, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                  <RadioDot selected={itemVal === p} onClick={() => onChange({ ...groupVal, [item.id]: itemVal === p ? undefined : p })} readOnly={readOnly} />
                </div>
              ))}
            </div>
          )
        })}
        {el.high_label && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, textAlign: 'right' }}>{scale} = {el.high_label}</div>}
      </div>
    )
  }

  if (el.type === 'short_answer') {
    return <div><QLabel el={el} /><FocusInput value={value} onChange={e => onChange(e.target.value)} placeholder={el.placeholder || ''} disabled={readOnly} /></div>
  }

  if (el.type === 'paragraph') {
    return <div><QLabel el={el} /><FocusTextarea value={value} onChange={e => onChange(e.target.value)} placeholder={el.placeholder || ''} disabled={readOnly} /></div>
  }

  if (el.type === 'multiple_choice') {
    return (
      <div>
        <QLabel el={el} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(el.options || []).map(opt => (
            <ChoiceButton key={opt} selected={value === opt} onClick={() => !readOnly && onChange(value === opt ? null : opt)} readOnly={readOnly} multiSelect={false}>{opt}</ChoiceButton>
          ))}
        </div>
      </div>
    )
  }

  if (el.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : []
    return (
      <div>
        <QLabel el={el} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(el.options || []).map(opt => (
            <ChoiceButton key={opt} selected={selected.includes(opt)}
              onClick={() => { if (readOnly) return; const isSel = selected.includes(opt); onChange(isSel ? selected.filter(x => x !== opt) : [...selected, opt]) }}
              readOnly={readOnly} multiSelect={true}>{opt}
            </ChoiceButton>
          ))}
        </div>
      </div>
    )
  }

  if (el.type === 'rating') {
    return (
      <div>
        <QLabel el={el} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(el.options || []).map(opt => {
            const selected = value === opt
            return (
              <button key={opt} disabled={readOnly} onClick={() => !readOnly && onChange(selected ? null : opt)}
                style={{
                  padding: '7px 14px', border: '1.5px solid',
                  borderColor: selected ? 'var(--accent)' : 'var(--border)', borderRadius: 20,
                  background: selected ? 'var(--accent-light)' : 'transparent',
                  color: selected ? 'var(--accent)' : 'var(--text)',
                  fontSize: 13, fontWeight: selected ? 600 : 400, cursor: readOnly ? 'default' : 'pointer',
                  transition: 'border-color 0.1s, background 0.1s, color 0.1s', fontFamily: 'var(--font)',
                }}>{opt}</button>
            )
          })}
        </div>
      </div>
    )
  }

  if (el.type === 'likert') {
    const scale = el.scale || 5
    const points = Array.from({ length: scale }, (_, i) => i + 1)
    const allOptions = el.has_na ? ['N/A', ...points] : points
    return (
      <div>
        <QLabel el={el} />
        {(el.low_label || el.high_label) && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 7 }}>
            <span>{el.low_label}</span><span>{el.high_label}</span>
          </div>
        )}
        <SegmentedControl options={allOptions} value={value} onChange={onChange} readOnly={readOnly} />
      </div>
    )
  }

  if (el.type === 'slider') {
    const min = el.min ?? 0
    const max = el.max ?? 100
    const step = el.step ?? 1
    const val = value ?? min
    return (
      <div>
        <QLabel el={el} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input type="range" min={min} max={max} step={step} value={val}
            onChange={e => !readOnly && onChange(Number(e.target.value))}
            disabled={readOnly} style={{ flex: 1, accentColor: 'var(--accent)' }} />
          <input type="number" value={val} min={min} max={max} step={step} disabled={readOnly}
            onChange={e => { const n = Number(e.target.value); if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n))) }}
            style={{
              width: 56, textAlign: 'center', fontWeight: 700, fontSize: 14,
              color: 'var(--accent)', background: 'var(--accent-light)',
              padding: '3px 6px', borderRadius: 6, border: '1.5px solid transparent',
              outline: 'none', fontFamily: 'var(--font)',
            }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          <span>{el.low_label || min}</span><span>{el.high_label || max}</span>
        </div>
      </div>
    )
  }

  return null
}
