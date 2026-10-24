import { useRef, useState, type Ref } from 'react'
import { Button } from '../../components/Button'
import {
  CommandPalette,
  type Command,
  type CommandPaletteHandle,
} from '../../components/CommandPalette'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { Menu, type MenuItems } from '../../components/Menu'
import { closeDialog } from '../../components/closeDialog'
import { Sheet } from '../../components/Sheet'
import { useToast } from '../../components/toastContext'
import { useTooltip } from '../../components/tooltipContext'
import { Example, GallerySection } from './GallerySection'
import { GameScores } from './GameScores'
import { findMatch } from './match'
import { MatchRow } from './MatchRow'
import { checkedInPlayers } from './players'
import { scoringScreenUrl, stateMatrixUrl } from './referenceLinks'

// Every section of the reference gallery, in its order, as its palette's
// "Go to" commands name them.
const gallerySections = [
  ['roles', 'Roles at a glance'],
  ['actions', 'Buttons'],
  ['forms', 'Fields, dates and choices'],
  ['selection', 'Selection'],
  ['containers', 'Containers'],
  ['feedback', 'Feedback'],
  ['overlays', 'Overlays'],
  ['match', 'Match components'],
  ['more', 'More components'],
] as const

// The Menu example's commands.
const matchActions: MenuItems = [
  { label: 'Edit match' },
  { label: 'Move to another table' },
  { label: 'Print score sheet', shortcut: '⌘P' },
  'divider',
  { label: 'Remove from schedule', danger: true },
]

// The tables the move sheet offers. Table 4 can't take a match while its
// scorer is offline.
const tables = [
  { name: 'Table 2', note: 'Free until 11:45', free: true },
  { name: 'Table 3', note: 'Free after this match', free: true },
  { name: 'Table 5', note: 'Free all morning', free: true },
  { name: 'Table 4', note: 'Scorer offline', free: false },
]

// The match the sheets are about.
const drawerMatch = findMatch('c2')

// Scrolls the section or example `id` to the top and focuses its heading,
// as the gallery's palette does.
function goTo(id: string) {
  const target = document.getElementById(id) ?? document.querySelector(`[data-testid="${id}"]`)
  const heading = target?.querySelector<HTMLElement>('h2, h3')
  if (!target || !heading) return
  heading.tabIndex = -1
  window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 24 })
  heading.focus({ preventScroll: true })
}

// The dialog that "Withdraw player…" opens, in the Buttons section and the
// Dialog example. The page holds it, so both open the same one.
export function WithdrawDialog({ ref }: { ref: Ref<HTMLDialogElement> }) {
  return (
    <Dialog
      ref={ref}
      data-testid="dialog-withdraw"
      title="Withdraw Okafor-Adeyemi from the draw?"
      actions={
        <>
          <Button variant="secondary" onClick={closeDialog}>
            Keep in draw
          </Button>
          <Button variant="danger-solid" value="withdraw" onClick={closeDialog}>
            Withdraw
          </Button>
        </>
      }
    >
      <p>
        Johansen-Whitfield advances to the quarterfinal. This can't be undone once her next
        match starts.
      </p>
    </Dialog>
  )
}

// The Tooltip example: two triggers, then static copies of their tooltips.
function TooltipDemo() {
  const printTip = useTooltip('Print score sheet')
  const moveTip = useTooltip(
    'Moves this match to the next free table and tells both players. Their rest times are kept.',
  )
  return (
    <>
      <div className="doc-row">
        <Button variant="secondary" icon aria-label="Print score sheet" {...printTip}>
          <Icon name="list" />
        </Button>
        <Button variant="secondary" data-testid="tooltip-trigger" {...moveTip}>
          Move to free table
        </Button>
      </div>
      <div className="doc-row" style={{ alignItems: 'flex-start' }}>
        <span className="fm-tooltip fm-tooltip--static">Print score sheet</span>
        <span className="fm-tooltip fm-tooltip--static" style={{ maxWidth: 280 }}>
          Moves this match to the next free table and tells both players. Their rest times are
          kept.
        </span>
      </div>
      <p className="doc-vo">Static copies above are visual only</p>
    </>
  )
}

// The design system page's Overlays section: the reference gallery's
// `section-overlays`, with its sheets and command palette. "Withdraw
// player…" opens the page's withdraw dialog through `onWithdraw`. A player
// in the palette goes to the opponent combobox and searches it for them
// through `onFindPlayer`.
export function OverlaysSection({
  onWithdraw,
  onFindPlayer,
}: {
  onWithdraw: () => void
  onFindPlayer: (name: string) => void
}) {
  const showToast = useToast()
  const matchSheet = useRef<HTMLDialogElement>(null)
  const moveSheet = useRef<HTMLDialogElement>(null)
  const palette = useRef<CommandPaletteHandle>(null)
  const [table, setTable] = useState('Table 3')
  const [choice, setChoice] = useState('')
  const choices = tables.filter((option) => option.name !== table)

  function openMoveSheet() {
    const sheet = moveSheet.current
    if (!sheet) return
    setChoice(choices[0].name)
    sheet.returnValue = ''
    sheet.showModal()
  }

  // The gallery's commands. "Go to" lists only the sections the page has so
  // far, where the gallery's palette lists them all.
  const listCommands = (): Command[] => [
    ...gallerySections
      .filter(([id]) => document.getElementById(id))
      .map(([id, label]): Command => ({
        group: 'Go to',
        label,
        icon: 'list',
        run: () => goTo(id),
      })),
    {
      group: 'Open',
      label: 'Match drawer',
      icon: 'table',
      keywords: 'sheet side',
      run: () => matchSheet.current?.showModal(),
    },
    {
      group: 'Open',
      label: 'Move match to another table',
      icon: 'table',
      keywords: 'bottom sheet',
      run: openMoveSheet,
    },
    {
      group: 'Open',
      label: 'Withdraw player dialog',
      icon: 'x',
      keywords: 'remove',
      run: onWithdraw,
    },
    {
      group: 'Open',
      label: 'State matrix',
      icon: 'list',
      run: () => window.location.assign(stateMatrixUrl),
    },
    ...checkedInPlayers.map(
      (player): Command => ({
        group: 'Players',
        label: player.name,
        hint: player.club,
        icon: 'user',
        run: () => {
          goTo('ex-combobox')
          onFindPlayer(player.name)
        },
      }),
    ),
  ]

  return (
    <GallerySection
      id="overlays"
      title="Overlays"
      lead="The only things with a shadow. Each has a clear way out: Esc, the backdrop, or a button."
    >
      <Example
        testId="ex-tooltip"
        title="Tooltip"
        description="Dark surface, 13px sentence case, wraps past 280px. Appears on hover and keyboard focus; Esc hides it. Supplementary only — never the only place information lives."
      >
        <TooltipDemo />
      </Example>
      <Example
        testId="ex-dialog"
        title="Dialog"
        description={
          'States the consequence, offers the safe choice first. Esc, the backdrop and "Keep in draw" all close it; focus returns to the trigger.'
        }
      >
        <div className="doc-row">
          <Button variant="danger" data-testid="dialog-trigger" onClick={onWithdraw}>
            Withdraw player…
          </Button>
        </div>
      </Example>
      <Example
        testId="ex-menu"
        title="Menu"
        description="Destructive items last, in red, after a divider."
      >
        <Menu
          label="Match actions"
          items={matchActions}
          style={{ alignSelf: 'flex-start' }}
        />
        <p className="doc-vo">Visual only</p>
      </Example>
      <Example
        testId="ex-sheet-and-drawer"
        title="Sheet and drawer"
        description="For a task that needs more room than a dialog while keeping the page in view. Drawer from the right on wide screens; bottom sheet for short choices and on phones. Title, scrolling body, actions pinned at the bottom. Esc, the backdrop or Close dismisses; focus returns to the trigger."
      >
        <div className="doc-row">
          <Button
            variant="secondary"
            data-testid="sheet-match-trigger"
            onClick={() => matchSheet.current?.showModal()}
          >
            Open match drawer
          </Button>
          <Button variant="secondary" data-testid="sheet-move-trigger" onClick={openMoveSheet}>
            Move match to another table…
          </Button>
        </div>
        <p className="fm-notice">
          <Icon name="table" />
          <span>
            Patel vs Wójcik-Szymańska is on <b>{table}</b>.
          </span>
        </p>
      </Example>
      <Example
        testId="ex-command-palette"
        title="Command palette"
        description="Jump to a section, open an overlay or find a player from anywhere. ⌘K or Ctrl+K opens it. Type to filter, ↑ ↓ move, Enter runs, Esc closes. Every command here really runs on this page."
      >
        <div className="doc-row">
          <Button
            variant="secondary"
            data-testid="palette-trigger"
            aria-keyshortcuts="Meta+K Control+K"
            onClick={() => palette.current?.open()}
          >
            <Icon name="search" />
            Search commands
            <span className="fm-kbd" aria-hidden="true">
              ⌘K
            </span>
          </Button>
        </div>
      </Example>
      <Sheet
        ref={matchSheet}
        data-testid="sheet-match"
        title="Patel vs Wójcik-Szymańska"
        subtitle="Table 3 · Open singles · Round of 32"
        footer={
          <>
            <a className="fm-btn fm-btn--primary" href={scoringScreenUrl}>
              Open scoring
            </a>
            <Button variant="ghost" onClick={closeDialog}>
              Close
            </Button>
          </>
        }
      >
        <MatchRow match={drawerMatch} large headHidden />
        <div>
          <h3 className="fm-section-title" style={{ marginBottom: 8 }}>
            Game scores
          </h3>
          <div className="fm-scroll">
            <GameScores match={drawerMatch} />
          </div>
        </div>
        <dl className="fm-dl">
          <div>
            <dt>Started</dt>
            <dd>11:05</dd>
          </div>
          <div>
            <dt>Umpire</dt>
            <dd>Haddad, Youssef</dd>
          </div>
          <div>
            <dt>Next on Table 3</dt>
            <dd>Dubois vs Lindqvist, 12:15</dd>
          </div>
        </dl>
        <p className="fm-notice fm-notice--rest">
          <Icon name="clock" />
          <span>Patel plays again at 12:05. She gets her 15 minutes’ rest if this ends by 11:50.</span>
        </p>
      </Sheet>
      <Sheet
        ref={moveSheet}
        data-testid="sheet-move"
        title="Move to another table"
        subtitle={`Patel vs Wójcik-Szymańska · now on ${table}`}
        bottom
        form
        onClose={(event) => {
          if (event.currentTarget.returnValue !== 'move') return
          const from = table
          setTable(choice)
          showToast(`Moved to ${choice}`, { undo: () => setTable(from) })
        }}
        footer={
          <>
            <Button variant="primary" type="submit" value="move">
              Move match
            </Button>
            <Button variant="ghost" type="submit" value="cancel">
              Cancel
            </Button>
          </>
        }
      >
        <fieldset className="fm-choices">
          <legend className="fm-sr">Table</legend>
          {choices.map((option) => (
            <label key={option.name} className="fm-radio">
              <input
                type="radio"
                name="table"
                value={option.name}
                disabled={!option.free}
                checked={choice === option.name}
                onChange={() => setChoice(option.name)}
              />
              <span>
                {option.name}
                <span className="fm-help" style={{ display: 'block' }}>
                  {option.note}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="fm-notice">
          <Icon name="info" />
          <span>In the app, both players are told the new table. This demo only updates the page.</span>
        </p>
      </Sheet>
      <CommandPalette
        ref={palette}
        data-testid="command-palette"
        listCommands={listCommands}
        shortcut
      />
    </GallerySection>
  )
}
