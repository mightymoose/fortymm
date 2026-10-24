import { useTestMode } from '../testMode'
import { ButtonsSection } from './designSystem/ButtonsSection'

// The app's copy of the design system's component gallery
// (references/design-system/ui_kits/components/index.html), built from the
// app's own components and styled by styles/page.css and styles/kit.css.
// Its sections and examples carry the gallery's test ids, so both pages open
// the same way in test mode.
export function DesignSystem() {
  useTestMode()
  return (
    <>
      <header className="doc-head">
        <h1>Design System</h1>
        <p>
          Equipment for running a tournament day. Each component has its own
          shape for its job: cards hold what stays, notices sit in the text,
          alerts carry a fix, toasts float briefly, tooltips add detail.
          Orange marks actions and selection only.
        </p>
      </header>
      <ButtonsSection />
    </>
  )
}
