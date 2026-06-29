import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function TutorialBubble({ targetId, placement = 'bottom', title, body, step, total, onNext, onSkip }) {
  const [rect, setRect] = useState(null)
  const [bubbleSize, setBubbleSize] = useState({ width: 296, height: 150 })
  const bubbleRef = useRef(null)

  useEffect(() => {
    if (!targetId) return
    const el = document.getElementById(targetId)
    if (!el) return
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const update = () => setRect(el.getBoundingClientRect())
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [targetId])

  useLayoutEffect(() => {
    if (!bubbleRef.current) return
    const next = bubbleRef.current.getBoundingClientRect()
    if (next.width && next.height && (Math.abs(next.width - bubbleSize.width) > 1 || Math.abs(next.height - bubbleSize.height) > 1)) {
      setBubbleSize({ width: next.width, height: next.height })
    }
  }, [body, bubbleSize.height, bubbleSize.width, title])

  if (!rect) return null

  const W = 316
  const GAP = 12
  const MARGIN = 8
  const viewportW = window.innerWidth
  const viewportH = window.innerHeight

  // Bubble position
  let top = rect.bottom + GAP
  let left = Math.max(MARGIN, Math.min(rect.left + rect.width / 2 - W / 2, viewportW - W - MARGIN))
  let resolvedPlacement = placement
  if (placement === 'bottom') {
    top = rect.bottom + GAP
    if (top + bubbleSize.height > viewportH - MARGIN && rect.top > bubbleSize.height + GAP) {
      resolvedPlacement = 'top'
      top = rect.top - GAP - bubbleSize.height
    }
  } else if (placement === 'top') {
    top = rect.top - GAP - bubbleSize.height
    if (top < MARGIN && rect.bottom + GAP + bubbleSize.height < viewportH - MARGIN) {
      resolvedPlacement = 'bottom'
      top = rect.bottom + GAP
    }
  } else if (placement === 'right') {
    top = rect.top + rect.height / 2 - bubbleSize.height / 2
    left = rect.right + GAP
    if (left + W > viewportW - MARGIN) {
      resolvedPlacement = 'bottom'
      top = rect.bottom + GAP
      left = Math.max(MARGIN, Math.min(rect.left + rect.width / 2 - W / 2, viewportW - W - MARGIN))
    }
  }
  top = Math.max(MARGIN, Math.min(top, viewportH - bubbleSize.height - MARGIN))
  left = Math.max(MARGIN, Math.min(left, viewportW - W - MARGIN))

  // Arrow horizontal offset relative to bubble left edge
  const arrowX = Math.max(12, Math.min((rect.left + rect.width / 2) - left - 7, W - 26))
  const arrowY = Math.max(12, Math.min((rect.top + rect.height / 2) - top - 7, bubbleSize.height - 26))

  const accent = '#6366f1'

  return createPortal(
    <>
      {/* Transparent click-away backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9999 }}
      />
      {/* Highlight ring around target */}
      <div style={{
        position: 'fixed',
        top: rect.top - 3, left: rect.left - 3,
        width: rect.width + 6, height: rect.height + 6,
        borderRadius: 8,
        outline: `2px solid ${accent}`,
        outlineOffset: 1,
        pointerEvents: 'none',
        zIndex: 10001,
      }} />
      {/* Bubble */}
      <div ref={bubbleRef} style={{
        position: 'fixed',
        top, left, width: W,
        background: accent,
        color: 'white',
        borderRadius: 10,
        padding: '14px 16px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
        zIndex: 10002,
        fontFamily: 'var(--font)',
      }}>
        {/* Arrow (points up for bottom placement) */}
        {resolvedPlacement === 'bottom' && (
          <div style={{
            position: 'absolute', top: -7, left: arrowX,
            width: 0, height: 0,
            borderLeft: '7px solid transparent',
            borderRight: '7px solid transparent',
            borderBottom: `7px solid ${accent}`,
          }} />
        )}
        {resolvedPlacement === 'top' && (
          <div style={{
            position: 'absolute', bottom: -7, left: arrowX,
            width: 0, height: 0,
            borderLeft: '7px solid transparent',
            borderRight: '7px solid transparent',
            borderTop: `7px solid ${accent}`,
          }} />
        )}
        {resolvedPlacement === 'right' && (
          <div style={{
            position: 'absolute', left: -7, top: arrowY,
            width: 0, height: 0,
            borderTop: '7px solid transparent',
            borderBottom: '7px solid transparent',
            borderRight: `7px solid ${accent}`,
          }} />
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
        </div>
        <p style={{ fontSize: 12, lineHeight: 1.55, margin: 0, marginBottom: 14, color: 'rgba(255,255,255,0.88)' }}>{body}</p>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>{step} of {total}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={onSkip}
              style={{ background: 'rgba(255,255,255,0.14)', border: 'none', color: 'rgba(255,255,255,0.85)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font)' }}
            >
              Skip
            </button>
            <button
              onClick={onNext}
              style={{ background: 'white', border: 'none', color: accent, borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font)' }}
            >
              {step === total ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}
