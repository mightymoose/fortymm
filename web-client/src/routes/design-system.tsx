import { createFileRoute } from '@tanstack/react-router'

// /design-system: where each component of the FortyMM design system will be
// shown as the app builds it, to check against the design system artifact.
// For now only its header: the wordmark, in Bebas Neue, and the page's title,
// in Space Grotesk. Component sections go in <main>.
export const Route = createFileRoute('/design-system')({
  component: DesignSystemPage,
})

function DesignSystemPage() {
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
      <main aria-label="Components"></main>
    </>
  )
}
