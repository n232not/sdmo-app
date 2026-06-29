import { useState, useEffect, useCallback, createElement } from 'react'
import TutorialBubble from './TutorialBubble'

// Reusable coach-mark tour runner. Renders the active TutorialBubble and handles
// optional first-visit auto-start (gated on `ready` so anchor elements exist),
// Next/Skip, and persisting "seen" state in localStorage under `storageKey`.
//
//   const tour = useTour(STEPS, 'sdmo_tour_project_v1', { ready: !loading, autoStart: true })
//   ... <button onClick={tour.start}>?</button> ... {tour.node}
export default function useTour(steps, storageKey, { ready = true, delay = 500, autoStart = false, onStart, onComplete, onSkip } = {}) {
  const [step, setStep] = useState(null)
  const [autoFired, setAutoFired] = useState(false)

  const markSeen = useCallback(() => {
    if (storageKey) localStorage.setItem(storageKey, '1')
  }, [storageKey])

  // Resolve the next visible step at or after `idx`, skipping steps whose anchor
  // isn't currently in the DOM (e.g. the Sync button only renders when sync is on).
  const resolve = useCallback((idx) => {
    for (let i = idx; i < steps.length; i++) {
      const t = steps[i]?.targetId
      if (!t) return i
      const el = document.getElementById(t)
      if (!el) continue
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return i
    }
    return null
  }, [steps])

  useEffect(() => {
    if (!autoStart || autoFired || !ready || !storageKey) return
    if (localStorage.getItem(storageKey)) { setAutoFired(true); return }
    const t = setTimeout(() => { onStart?.(); setStep(resolve(0)); setAutoFired(true) }, delay)
    return () => clearTimeout(t)
  }, [autoStart, ready, autoFired, storageKey, delay, resolve, onStart])

  const start = useCallback(() => { onStart?.(); setAutoFired(true); setTimeout(() => setStep(resolve(0)), 0) }, [resolve, onStart])

  const finish = useCallback(() => { markSeen(); setStep(null); onSkip?.() }, [markSeen, onSkip])

  const next = useCallback(() => {
    setStep(s => {
      if (s === null) return s
      const n = resolve(s + 1)
      if (n === null) {
        markSeen()
        setTimeout(() => onComplete?.(), 0)
        return null
      }
      return n
    })
  }, [resolve, markSeen, onComplete])

  const node = (step !== null && steps[step])
    ? createElement(TutorialBubble, { ...steps[step], step: step + 1, total: steps.length, onNext: next, onSkip: finish })
    : null

  return { node, start, active: step !== null }
}
