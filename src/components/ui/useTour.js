import { useState, useEffect, useCallback, createElement } from 'react'
import TutorialBubble from './TutorialBubble'

// Reusable coach-mark tour runner. Renders the active TutorialBubble and handles
// first-visit auto-start (gated on `ready` so anchor elements exist), Next/Skip,
// and persisting "seen" state in localStorage under `storageKey`.
//
//   const tour = useTour(STEPS, 'sdmo_tour_project_v1', { ready: !loading })
//   ... <button onClick={tour.start}>?</button> ... {tour.node}
<<<<<<< Updated upstream
export default function useTour(steps, storageKey, { ready = true, delay = 500, onStart } = {}) {
=======
export default function useTour(steps, storageKey, { ready = true, autoStart = true, delay = 500, onStart, onComplete, onSkip } = {}) {
>>>>>>> Stashed changes
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
      if (!t || document.getElementById(t)) return i
    }
    return null
  }, [steps])

  useEffect(() => {
    if (!autoStart || autoFired || !ready || !storageKey) return
    if (localStorage.getItem(storageKey)) { setAutoFired(true); return }
    const t = setTimeout(() => { onStart?.(); setStep(resolve(0)); setAutoFired(true) }, delay)
    return () => clearTimeout(t)
  }, [ready, autoStart, autoFired, storageKey, delay, resolve, onStart])

  const start = useCallback(() => { onStart?.(); setAutoFired(true); setStep(resolve(0)) }, [resolve, onStart])

  const finish = useCallback(() => { markSeen(); setStep(null) }, [markSeen])

  const next = useCallback(() => {
    setStep(s => {
      if (s === null) return s
      const n = resolve(s + 1)
      if (n === null) { markSeen(); return null }
      return n
    })
  }, [resolve, markSeen])

  const node = (step !== null && steps[step])
    ? createElement(TutorialBubble, { ...steps[step], step: step + 1, total: steps.length, onNext: next, onSkip: finish })
    : null

  return { node, start, active: step !== null }
}
