import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronDown, ChevronRight, Check } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function resolveMarkdownAsset(src, assets = []) {
  const id = String(src || '').replace(/^\.\/sdmo-image-/, '').replace(/^sdmo-image-/, '')
  return assets.find(asset => asset.id === id)?.dataUrl || src
}

export default function FormRenderer({ schema, responses, onSave, readOnly, timestamps = [] }) {
  const sections = schema?.sections || []
  const manySections = sections.length > 3

  const [values, setValues] = useState(responses || {})
  const [collapsed, setCollapsed] = useState(() => {
    if (!manySections) return {}
    return Object.fromEntries(sections.map(s => [s.id, true]))
  })
  const [activeSection, setActiveSection] = useState(null)
  const sectionRefs = useRef({})

  const valuesRef = useRef(values)
  useEffect(() => {
    const v = responses || {}
    setValues(v)
    valuesRef.current = v
  }, [responses])

  const saveTimerRef = useRef(null)
  const onSaveRef = useRef(onSave)
  useEffect(() => { onSaveRef.current = onSave }, [onSave])

  const handleChange = useCallback((qId, val) => {
    const next = { ...valuesRef.current, [qId]: val }
    valuesRef.current = next
    setValues(next)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      onSaveRef.current(next)
    }, 300)
  }, [])

  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      onSaveRef.current(valuesRef.current)
    }
  }, [])

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
          paddingBottom: 8, marginBottom: 16,
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{
            background: 'var(--bg-secondary)',
            borderRadius: 8,
            padding: '3px 4px',
            display: 'flex', flexWrap: 'wrap', gap: 2,
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
                    padding: '4px 9px', borderRadius: 6,
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
            sectionRef={el => { sectionRefs.current[section.id] = el }}
            readOnly={readOnly}
            timestamps={timestamps}
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

function FormSection({ section, sectionIndex, values, onChange, collapsed, onToggle, sectionRef, readOnly, timestamps }) {
  const { answered, total } = countAnswered(section, values)
  const complete = total > 0 && answered === total

  return (
    <div ref={sectionRef}>
      {/* Section header */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px',
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
          padding: '12px 12px 4px 26px',
          display: 'flex', flexDirection: 'column', gap: 16,
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
              timestamps={timestamps}
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
        border: `1.5px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 8, padding: '9px 12px', background: 'var(--bg)',
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
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', textAlign: 'left', padding: '8px 12px',
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
    <div style={{ marginBottom: 6 }}>
      <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: '-0.01em' }}>{el.label}</span>
      {el.required && <span style={{ color: 'var(--danger)', marginLeft: 3, fontSize: 12 }}>*</span>}
    </div>
  )
}

function isNA(value) {
  return value === 'N/A' || (value && typeof value === 'object' && !Array.isArray(value) && value.__na === true)
}

function NAToggle({ selected, onChange, readOnly, compact = false }) {
  return (
    <button
      disabled={readOnly}
      onClick={() => !readOnly && onChange(selected ? null : 'N/A')}
      style={{
        alignSelf: compact ? 'stretch' : 'flex-start',
        padding: compact ? '4px 8px' : '6px 10px',
        border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 6,
        background: selected ? 'var(--accent-light)' : 'transparent',
        color: selected ? 'var(--accent)' : 'var(--text-secondary)',
        fontSize: compact ? 12 : 13,
        fontWeight: selected ? 700 : 500,
        cursor: readOnly ? 'default' : 'pointer',
        fontFamily: 'var(--font)',
      }}
    >
      N/A
    </button>
  )
}

function FormElement({ el, value, onChange, readOnly, timestamps = [] }) {
  if (el.type === 'text_block') {
    return (
      <div className="prose form-markdown-block">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={url => url}
          components={{
            img: ({ src, alt }) => <img src={resolveMarkdownAsset(src, el.assets || [])} alt={alt || ''} />,
          }}
        >
          {el.content || ''}
        </ReactMarkdown>
      </div>
    )
  }

  if (el.type === 'checkbox') {
    const checked = value === true
    const na = isNA(value)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: readOnly ? 'default' : 'pointer', opacity: na ? 0.55 : 1 }}
          onClick={() => !readOnly && onChange(checked ? false : true)}>
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
        {el.has_na && <NAToggle selected={na} onChange={onChange} readOnly={readOnly} />}
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
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', padding: '5px 6px', background: i % 2 === 1 ? 'rgba(0,0,0,0.025)' : 'transparent', borderRadius: 4 }}>
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
    const na = isNA(value)
    return (
      <div>
        <QLabel el={el} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FocusInput value={na ? '' : value} onChange={e => onChange(e.target.value)} placeholder={el.placeholder || ''} disabled={readOnly || na} />
          {el.has_na && <NAToggle selected={na} onChange={onChange} readOnly={readOnly} />}
        </div>
      </div>
    )
  }

  if (el.type === 'paragraph') {
    const na = isNA(value)
    return (
      <div>
        <QLabel el={el} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FocusTextarea value={na ? '' : value} onChange={e => onChange(e.target.value)} placeholder={el.placeholder || ''} disabled={readOnly || na} />
          {el.has_na && <NAToggle selected={na} onChange={onChange} readOnly={readOnly} />}
        </div>
      </div>
    )
  }

  if (el.type === 'multiple_choice') {
    return (
      <div>
        <QLabel el={el} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(el.options || []).map(opt => (
            <ChoiceButton key={opt} selected={value === opt} onClick={() => !readOnly && onChange(value === opt ? null : opt)} readOnly={readOnly} multiSelect={false}>{opt}</ChoiceButton>
          ))}
          {el.has_na && (
            <ChoiceButton selected={isNA(value)} onClick={() => !readOnly && onChange(isNA(value) ? null : 'N/A')} readOnly={readOnly} multiSelect={false}>N/A</ChoiceButton>
          )}
        </div>
      </div>
    )
  }

  if (el.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : []
    const na = isNA(value)
    return (
      <div>
        <QLabel el={el} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(el.options || []).map(opt => (
            <ChoiceButton key={opt} selected={!na && selected.includes(opt)}
              onClick={() => { if (readOnly) return; const isSel = selected.includes(opt); onChange(isSel ? selected.filter(x => x !== opt) : [...selected, opt]) }}
              readOnly={readOnly} multiSelect={true}>{opt}
            </ChoiceButton>
          ))}
          {el.has_na && (
            <ChoiceButton selected={na} onClick={() => !readOnly && onChange(na ? [] : 'N/A')} readOnly={readOnly} multiSelect={false}>N/A</ChoiceButton>
          )}
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
                  padding: '5px 12px', border: '1.5px solid',
                  borderColor: selected ? 'var(--accent)' : 'var(--border)', borderRadius: 20,
                  background: selected ? 'var(--accent-light)' : 'transparent',
                  color: selected ? 'var(--accent)' : 'var(--text)',
                  fontSize: 13, fontWeight: selected ? 600 : 400, cursor: readOnly ? 'default' : 'pointer',
                  transition: 'border-color 0.1s, background 0.1s, color 0.1s', fontFamily: 'var(--font)',
                }}>{opt}</button>
            )
          })}
          {el.has_na && (
            <button disabled={readOnly} onClick={() => !readOnly && onChange(isNA(value) ? null : 'N/A')}
              style={{
                padding: '5px 12px', border: '1.5px solid',
                borderColor: isNA(value) ? 'var(--accent)' : 'var(--border)', borderRadius: 20,
                background: isNA(value) ? 'var(--accent-light)' : 'transparent',
                color: isNA(value) ? 'var(--accent)' : 'var(--text)',
                fontSize: 13, fontWeight: isNA(value) ? 600 : 400, cursor: readOnly ? 'default' : 'pointer',
                transition: 'border-color 0.1s, background 0.1s, color 0.1s', fontFamily: 'var(--font)',
              }}>N/A</button>
          )}
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
    const na = isNA(value)
    const val = na ? min : (value ?? min)
    return (
      <div>
        <QLabel el={el} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: na ? 0.55 : 1 }}>
          <input type="range" min={min} max={max} step={step} value={val}
            onChange={e => !readOnly && onChange(Number(e.target.value))}
            disabled={readOnly || na} style={{ flex: 1, accentColor: 'var(--accent)' }} />
          <input type="number" value={val} min={min} max={max} step={step} disabled={readOnly || na}
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
        {el.has_na && <div style={{ marginTop: 6 }}><NAToggle selected={na} onChange={onChange} readOnly={readOnly} /></div>}
      </div>
    )
  }

  if (el.type === 'timestamp_select') {
    return (
      <div>
        <QLabel el={el} />
        <TimestampSelectInput timestamps={timestamps} value={value} onChange={onChange} readOnly={readOnly} allowNA={!!el.has_na} />
      </div>
    )
  }

  if (el.type === 'table') {
    const rows = el.rows || []
    const columns = el.columns || []
    const tableVal = (typeof value === 'object' && value !== null && !Array.isArray(value)) ? value : {}
    return (
      <div>
        <QLabel el={el} />
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12, fontFamily: 'var(--font)' }}>
            <thead>
              <tr>
                <th style={thStyle} />
                {columns.map(col => (
                  <th key={col.id} style={{ ...thStyle, minWidth: col.type === 'timestamp_select' ? 190 : 100 }}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((rowLabel, ri) => {
                const rowVal = (tableVal[String(ri)] && typeof tableVal[String(ri)] === 'object') ? tableVal[String(ri)] : {}
                return (
                  <tr key={ri}>
                    <td style={rowHeaderStyle}>{rowLabel}</td>
                    {columns.map(col => (
                      <td key={col.id} style={{ padding: '4px 6px', border: '1px solid var(--border)', verticalAlign: 'middle' }}>
                        <TableCell
                          col={col}
                          value={rowVal[col.id]}
                          onChange={v => onChange({ ...tableVal, [String(ri)]: { ...rowVal, [col.id]: v } })}
                          readOnly={readOnly}
                          timestamps={timestamps}
                        />
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return null
}

const thStyle = {
  padding: '5px 10px',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 11,
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap',
}

const rowHeaderStyle = {
  padding: '5px 10px',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  fontWeight: 600,
  fontSize: 11,
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap',
}

function TimestampSelectInput({ timestamps, value, onChange, readOnly, compact = false, allowNA = false }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  function fmtTs(ts) {
    const m = Math.floor(ts.time_seconds / 60)
    const s = String(Math.floor(ts.time_seconds % 60)).padStart(2, '0')
    return `${m}:${s}`
  }

  function displayText() {
    if (isNA(value)) return 'N/A'
    if (!value || typeof value !== 'object') return compact ? '—' : 'Select timestamp…'
    const time = fmtTs(value)
    return value.tag_label ? `${time} — ${value.tag_label}` : time
  }

  const filtered = timestamps.filter(ts => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      fmtTs(ts).includes(q) ||
      (ts.tag_label || '').toLowerCase().includes(q) ||
      (ts.description || '').toLowerCase().includes(q) ||
      (ts.notes || '').toLowerCase().includes(q)
    )
  })

  function timestampSelectionKey(ts) {
    if (!ts || typeof ts !== 'object') return ''
    if (ts.id != null) return `id:${ts.id}`
    return `${ts.time_seconds ?? ''}:${ts.tag_label || ''}`
  }

  const selectedKey = timestampSelectionKey(value)

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        disabled={readOnly}
        onClick={() => !readOnly && setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left',
          padding: compact ? '4px 8px' : '7px 12px',
          border: `1.5px solid ${open ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: compact ? 4 : 8,
          background: 'var(--bg)',
          color: (isNA(value) || (value && typeof value === 'object')) ? 'var(--text)' : 'var(--text-muted)',
          fontSize: compact ? 12 : 13,
          cursor: readOnly ? 'default' : 'pointer',
          fontFamily: 'var(--font)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          transition: 'border-color 0.15s',
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayText()}
        </span>
        <ChevronDown size={compact ? 11 : 13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 9999,
          background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 8, boxShadow: 'var(--shadow-lg)',
          marginTop: 3, maxHeight: 260, display: 'flex', flexDirection: 'column',
          minWidth: compact ? 240 : '100%',
        }}>
          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by time, tag, notes…"
              style={{
                width: '100%', fontSize: 12, padding: '4px 8px',
                border: '1px solid var(--border)', borderRadius: 5,
                background: 'var(--bg-secondary)', outline: 'none',
                fontFamily: 'var(--font)', color: 'var(--text)', boxSizing: 'border-box',
              }}
            />
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {value && typeof value === 'object' && (
              <button
                className="dropdown-item"
                style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}
                onClick={() => { onChange(null); setOpen(false); setSearch('') }}
              >
                Clear selection
              </button>
            )}
            {allowNA && (
              <button
                className="dropdown-item"
                style={{
                  fontSize: 12,
                  background: isNA(value) ? 'var(--accent-light)' : undefined,
                  color: isNA(value) ? 'var(--accent)' : undefined,
                  fontWeight: isNA(value) ? 600 : undefined,
                }}
                onClick={() => { onChange(isNA(value) ? null : 'N/A'); setOpen(false); setSearch('') }}
              >
                N/A
              </button>
            )}
            {filtered.length === 0 ? (
              <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
                {timestamps.length === 0 ? 'No timestamps logged yet' : 'No timestamps match'}
              </div>
            ) : filtered.map(ts => {
              const isSelected = selectedKey && selectedKey === timestampSelectionKey(ts)
              return (
                <button
                  key={ts.id != null ? ts.id : ts.time_seconds}
                  className="dropdown-item"
                  style={{
                    fontSize: 12,
                    background: isSelected ? 'var(--accent-light)' : undefined,
                    color: isSelected ? 'var(--accent)' : undefined,
                    fontWeight: isSelected ? 600 : undefined,
                    display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                  }}
                  onClick={() => {
                    onChange({
                      id: ts.id ?? null,
                      time_seconds: ts.time_seconds,
                      tag_id: ts.tag_id ?? null,
                      tag_label: ts.tag_label || null,
                      tag_color: ts.tag_color || null,
                      notes: ts.notes || '',
                    })
                    setOpen(false)
                    setSearch('')
                  }}
                >
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--accent)', fontWeight: 700, flexShrink: 0 }}>
                    {fmtTs(ts)}
                  </span>
                  {ts.tag_label && (
                    <span style={{ background: 'var(--accent-light)', color: 'var(--accent)', borderRadius: 3, padding: '1px 5px', fontSize: 11, flexShrink: 0 }}>
                      {ts.tag_label}
                    </span>
                  )}
                  {(ts.description || ts.notes) && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                      {ts.description || ts.notes}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function TableCell({ col, value, onChange, readOnly, timestamps }) {
  const na = isNA(value)
  const cellInputStyle = {
    width: '100%', padding: '4px 6px', fontSize: 12,
    border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg)', color: 'var(--text)',
    fontFamily: 'var(--font)', outline: 'none', boxSizing: 'border-box',
  }
  if (col.type === 'number') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <input
          type="number"
          value={na ? '' : (value ?? '')}
          disabled={readOnly || na}
          onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
          style={cellInputStyle}
        />
        {col.has_na && <NAToggle selected={na} onChange={onChange} readOnly={readOnly} compact />}
      </div>
    )
  }
  if (col.type === 'select') {
    return (
      <select
        value={na ? 'N/A' : (value || '')}
        disabled={readOnly}
        onChange={e => onChange(e.target.value || null)}
        style={{ ...cellInputStyle, color: value ? 'var(--text)' : 'var(--text-muted)' }}
      >
        <option value="">—</option>
        {(col.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
        {col.has_na && <option value="N/A">N/A</option>}
      </select>
    )
  }
  if (col.type === 'timestamp_select') {
    return (
      <TimestampSelectInput timestamps={timestamps} value={value} onChange={onChange} readOnly={readOnly} compact allowNA={!!col.has_na} />
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input
        type="text"
        value={na ? '' : (value || '')}
        disabled={readOnly || na}
        onChange={e => onChange(e.target.value || null)}
        style={cellInputStyle}
      />
      {col.has_na && <NAToggle selected={na} onChange={onChange} readOnly={readOnly} compact />}
    </div>
  )
}
