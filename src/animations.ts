import { inspectionRoots, type InspectionRoot } from './capture'

/** Owns only animations/media it paused; never resumes pre-existing paused work. */
export function freezeAnimations(topDocument: Document = document): () => void {
  const win = topDocument.defaultView
  if (!win) return () => {}
  const paused = new Set<Animation>()
  const videos = new Set<HTMLMediaElement>()
  const roots = new Map<InspectionRoot, HTMLStyleElement>()
  const controller = new AbortController()
  let frame = 0
  let stopped = false
  let scans = 0
  const pauseRoot = (root: InspectionRoot) => {
    // Observe before inserting the rule, so existing CSS animations keep their original state.
    for (const animation of root.getAnimations()) {
      if (animation.playState === 'running') {
        paused.add(animation)
        animation.pause()
      }
    }
    for (const element of root.querySelectorAll('video,audio')) {
      if ('paused' in element && 'pause' in element && typeof element.pause === 'function') {
        const media = element as HTMLMediaElement
        if (!media.paused) {
          videos.add(media)
          media.pause()
        }
      }
    }
  }
  const discover = () => {
    for (const root of inspectionRoots(topDocument)) {
      if (roots.has(root)) continue
      pauseRoot(root)
      const style = topDocument.createElement('style')
      style.setAttribute('data-foldmark-freeze', '')
      // Transitions remain WAAPI animations instead of being cancelled/snapped to their end value.
      style.textContent = '*,:before,:after { animation-play-state: paused !important; }'
      if (root.nodeType === 9) {
        const doc = root as Document
        ;(doc.head ?? doc.documentElement).append(style)
      } else root.append(style)
      roots.set(root, style)
      root.addEventListener(
        'play',
        (event) => {
          const element = event.target
          if (element && 'pause' in element && typeof element.pause === 'function') {
            const media = element as HTMLMediaElement
            videos.add(media)
            media.pause()
          }
        },
        { capture: true, signal: controller.signal },
      )
    }
  }
  const tick = () => {
    if (stopped) return
    if (++scans % 12 === 0) discover()
    for (const root of roots.keys()) pauseRoot(root)
    frame = win.requestAnimationFrame(tick)
  }
  discover()
  frame = win.requestAnimationFrame(tick)
  return () => {
    if (stopped) return
    stopped = true
    controller.abort()
    win.cancelAnimationFrame(frame)
    for (const style of roots.values()) style.remove()
    for (const animation of paused) {
      if (animation.playState === 'paused') animation.play()
    }
    for (const video of videos) {
      if (video.isConnected && video.paused) void video.play().catch(() => {})
    }
    paused.clear()
    videos.clear()
    roots.clear()
  }
}
