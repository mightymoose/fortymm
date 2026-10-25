import { useRef } from 'react'
import type { ComboboxHandle } from '../components/Combobox'
import { Icon } from '../components/Icon'
import { useTestMode } from '../testMode'
import { ButtonsSection } from './designSystem/ButtonsSection'
import { ContainersSection } from './designSystem/ContainersSection'
import { FeedbackSection } from './designSystem/FeedbackSection'
import { FieldsSection } from './designSystem/FieldsSection'
import { MatchSection } from './designSystem/MatchSection'
import { MoreSection } from './designSystem/MoreSection'
import { OverlaysSection, WithdrawDialog } from './designSystem/OverlaysSection'
import {
  beforeAndAfterUrl,
  scoringScreenUrl,
  stateMatrixUrl,
  tournamentScreenUrl,
} from './designSystem/referenceLinks'
import { RolesSection } from './designSystem/RolesSection'
import { SelectionSection } from './designSystem/SelectionSection'

// The app's copy of the design system's component gallery
// (references/design-system/ui_kits/components/index.html), built from the
// app's own components and styled by styles/page.css and styles/kit.css.
// Its sections and examples carry the gallery's test ids, so both pages open
// the same way in test mode.
export function DesignSystem() {
  useTestMode()
  const withdrawDialog = useRef<HTMLDialogElement>(null)
  const openWithdrawDialog = () => withdrawDialog.current?.showModal()
  const opponent = useRef<ComboboxHandle>(null)
  const findPlayer = (name: string) => opponent.current?.search(name)
  return (
    <div className="page">
      <header className="doc-head">
        <h1>Design System</h1>
        <p>
          Equipment for running a tournament day. Each component has its own
          shape for its job: cards hold what stays, notices sit in the text,
          alerts carry a fix, toasts float briefly, tooltips add detail.
          Orange marks actions and selection only.
        </p>
        <nav className="doc-toc" aria-label="Sections">
          <a href="#roles">Roles</a>
          <a href="#actions">Buttons</a>
          <a href="#forms">Fields, dates and choices</a>
          <a href="#selection">Selection</a>
          <a href="#containers">Containers</a>
          <a href="#feedback">Feedback</a>
          <a href="#overlays">Overlays</a>
          <a href="#match">Match components</a>
          <a href="#more">More</a>
        </nav>
        <p className="fm-notice" style={{ maxWidth: 760 }}>
          <Icon name="info" />
          <span>
            Examples work unless marked <b>Visual only</b>. Nothing is sent
            anywhere: actions change only this page, and every Undo really
            reverses that change. Buttons that would need a server say “isn’t
            wired up in this demo” when pressed.
          </span>
        </p>
        <div className="doc-links">
          <a className="fm-btn fm-btn--secondary fm-btn--sm" href={stateMatrixUrl}>
            State matrix
          </a>
          <a className="fm-btn fm-btn--secondary fm-btn--sm" href={tournamentScreenUrl}>
            Tournament screen (desktop)
          </a>
          <a className="fm-btn fm-btn--secondary fm-btn--sm" href={scoringScreenUrl}>
            Player screens (mobile)
          </a>
          <a className="fm-btn fm-btn--secondary fm-btn--sm" href={beforeAndAfterUrl}>
            Before and after
          </a>
        </div>
        <p className="fm-help">
          The iOS, Android, web admin, marketing and spectator kits are{' '}
          <b>legacy v2</b> and don’t use these components. Don’t copy from them.
        </p>
      </header>
      <RolesSection />
      <ButtonsSection onWithdraw={openWithdrawDialog} />
      <FieldsSection opponent={opponent} />
      <SelectionSection />
      <ContainersSection />
      <FeedbackSection />
      <OverlaysSection onWithdraw={openWithdrawDialog} onFindPlayer={findPlayer} />
      <MatchSection />
      <MoreSection />
      <WithdrawDialog ref={withdrawDialog} />
    </div>
  )
}
