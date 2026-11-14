import { ControlsSection } from './ControlsSection.tsx'

// The design system page, at /design-system: where each component of the
// FortyMM design system is shown as the app builds it, to check against the
// design system's reference sheet (references/design-system/). Its header
// has the wordmark, in Bebas Neue, and the page's title, in Space Grotesk;
// then each board's section: so far, the controls. It renders in the
// layout's <main> (AppLayout), so its <header> is the page's own, not a
// banner.
export function DesignSystemScreen() {
  return (
    <>
      <header>
        <span
          role="img"
          aria-label="FortyMM"
          className="wordmark scoreboard-display"
        >
          FortyMM
        </span>
        <h1>Design system</h1>
        <p>
          Each component of the FortyMM design system, as this app builds it,
          to check against the design system.
        </p>
      </header>
      <ControlsSection />
    </>
  )
}
