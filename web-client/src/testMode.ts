import { useEffect } from 'react'

// The design system gallery's screenshot test mode
// (references/design-system/ui_kits/components/TESTING.md), so the app's
// /design-system and the gallery open the same way in the Playwright suite:
// `?test` turns off transitions, animations and the text caret, and
// `?test&only=<testid>` shows just that element, flush top-left with 24px
// padding. Both work through kit.css's `.fm-test` and `.fm-only` rules.
// Components read isTestMode() for the mode's behaviour, such as toasts
// that stay until dismissed.
export function isTestMode(): boolean {
  return new URLSearchParams(window.location.search).has('test')
}

// Turns test mode on for the page while it's mounted, and sets
// `<html data-fm-ready="true">` once the fonts have loaded and two frames
// have painted, as the gallery does. Without `?test` it does nothing.
export function useTestMode(): void {
  useEffect(() => {
    if (!isTestMode()) return
    const html = document.documentElement
    html.classList.add('fm-test')

    const only = new URLSearchParams(window.location.search).get('only')
    const target = only
      ? document.querySelector(`[data-testid="${CSS.escape(only)}"]`)
      : null
    if (target) {
      html.classList.add('fm-only')
      target.setAttribute('data-fm-only', '')
      for (let up = target.parentElement; up && up !== document.body; up = up.parentElement) {
        up.setAttribute('data-fm-path', '')
      }
    }

    let cancelled = false
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    void document.fonts.ready
      .then(frame)
      .then(frame)
      .then(() => {
        if (!cancelled) html.dataset.fmReady = 'true'
      })

    return () => {
      cancelled = true
      html.classList.remove('fm-test', 'fm-only')
      delete html.dataset.fmReady
      for (const marked of document.querySelectorAll('[data-fm-only], [data-fm-path]')) {
        marked.removeAttribute('data-fm-only')
        marked.removeAttribute('data-fm-path')
      }
    }
  }, [])
}
