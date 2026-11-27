import { useId } from 'react'
import { Alert } from '../../design-system/Alert.tsx'
import { Button } from '../../design-system/Button.tsx'
import { ButtonLink } from '../../design-system/ButtonLink.tsx'
import { Card } from '../../design-system/Card.tsx'
import { Icon } from '../../design-system/Icon.tsx'
import { Kbd } from '../../design-system/Kbd.tsx'
import { Notice } from '../../design-system/Notice.tsx'
import { Toast } from '../../design-system/Toast.tsx'
import './showcase.css'
import { ShowcaseExample } from './ShowcaseExample.tsx'
import { StaticTooltip } from './StaticTooltip.tsx'

// The design system's Roles board (requirements/design-system/reference/Roles.dc.html): the roles
// at a glance, and the buttons. Text is copied from the board. As on the board, the buttons do
// nothing when pressed.
export function DesignSystemRolesScreen() {
  const startMatchReason = useId()
  return (
    <main className="doc" data-testid="page-roles">
      <section className="doc-cat" data-testid="section-roles">
        <h2>Roles at a glance</h2>
        <p>
          Same tokens, different structure. You should know which one you're looking at before you
          read it.
        </p>
        <div className="doc-roles">
          <div data-testid="role-card">
            <p className="doc-cap">Card — persistent, structured</p>
            <Card
              title="Your next match"
              subtitle="Open singles · Round of 16"
              status={
                <span className="fm-status">
                  <Icon name="clock" />
                  <span className="num">12:05</span>
                </span>
              }
              footer={
                <>
                  <Button variant="primary">I'm at the table</Button>
                  <Button variant="ghost">Directions</Button>
                </>
              }
            >
              <dl className="fm-dl">
                <div>
                  <dt>Opponent</dt>
                  <dd>Park, Ji-ho</dd>
                </div>
                <div>
                  <dt>Table</dt>
                  <dd>Table 2</dd>
                </div>
              </dl>
              <Notice tone="rest">
                You rest until <span className="num">11:55</span>. We'll call you after that.
              </Notice>
            </Card>
          </div>
          <div>
            <p className="doc-cap">Inline notice — part of the text</p>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
              data-testid="role-notice-examples"
            >
              <p className="body" style={{ margin: 0 }}>
                Round of 16 starts on all four tables once the last Round of 32 match finishes.
              </p>
              <Notice>Draws are fixed. Seeds come from ratings on 1 April.</Notice>
              <Notice tone="success">
                Check-in saved at <span className="num">09:42</span>.
              </Notice>
            </div>
            <p className="doc-cap" style={{ marginTop: 40 }}>
              Toast — raised, brief, offers Undo
            </p>
            <Toast actionLabel="Undo">
              Result saved. Nguyen <span className="rating-up">▲ +12</span>
            </Toast>
            <p className="doc-cap" style={{ marginTop: 40 }}>
              Tooltip — supplementary
            </p>
            <StaticTooltip>Johansen-Whitfield, Annika vs Rossi, Giulia · 11:05–11:40</StaticTooltip>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
            <div data-testid="role-warning">
              <p className="doc-cap">Warning — problem and the fix</p>
              <Alert
                tone="warning"
                title="Patel would get 5 minutes’ rest"
                actions={
                  <>
                    <Button variant="primary" size="sm">
                      Move to 12:05
                    </Button>
                    <Button variant="secondary" size="sm">
                      Keep 11:50
                    </Button>
                  </>
                }
              >
                Her Table 3 match is running over. Starting at 12:05 keeps the 15-minute minimum.
              </Alert>
            </div>
            <div data-testid="role-error">
              <p className="doc-cap">Error — what failed and how to recover</p>
              <Alert
                tone="error"
                title="Results didn't sync"
                actions={
                  <Button variant="primary" size="sm">
                    Retry now
                  </Button>
                }
              >
                You're offline. 3 results are saved on this device.
              </Alert>
            </div>
          </div>
        </div>
        <p className="doc-vo" style={{ marginTop: 24 }}>
          Visual only · buttons in this overview are not wired up
        </p>
      </section>
      <section className="doc-cat" data-testid="section-actions">
        <h2>Buttons</h2>
        <p>Label with the verb that happens. One primary per card or dialog.</p>
        <ShowcaseExample
          testId="ex-variants"
          title="Variants"
          description="Primary for the main action, secondary for alternatives, ghost for low-weight actions in a row, danger for removal (always confirmed)."
        >
          <div className="doc-row">
            <Button variant="primary">Call to table</Button>
            <Button variant="secondary">Reschedule</Button>
            <Button variant="ghost">Print score sheet</Button>
            <Button variant="danger">Withdraw player…</Button>
            <Button variant="danger-solid">Withdraw</Button>
            <ButtonLink to="/design-system/match">View draw</ButtonLink>
          </div>
          <div className="doc-row">
            <Button variant="secondary" size="sm">
              Small
            </Button>
            <Button variant="secondary">Default</Button>
            <Button variant="secondary" size="lg">
              Large
            </Button>
            <Button variant="primary" size="xl">
              Extra large
            </Button>
            <Button variant="secondary" isIconOnly aria-label="More options">
              <Icon name="ellipsis" />
            </Button>
            <Button variant="ghost" size="sm" isIconOnly aria-label="Close">
              <Icon name="x" size="sm" />
            </Button>
          </div>
          <div className="doc-row">
            <Button variant="secondary">
              <Icon name="undo-2" />
              Undo last point
            </Button>
            <Button variant="secondary">
              <Icon name="search" />
              Search commands
              <Kbd>⌘K</Kbd>
            </Button>
          </div>
          <div style={{ maxWidth: 360 }}>
            <Button variant="primary" size="xl" isBlock>
              +1 Patel
            </Button>
          </div>
        </ShowcaseExample>
        <ShowcaseExample
          testId="ex-loading-and-disabled"
          title="Loading and disabled"
          description={`Loading keeps the button's colours and swaps the label ("Saving…"). Disabled looks the same under the pointer, and says why nearby.`}
        >
          <div className="doc-row">
            <Button variant="primary" isPending>
              Saving…
            </Button>
            <Button variant="secondary" isPending>
              Exporting…
            </Button>
            <Button variant="ghost" isPending>
              Printing…
            </Button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
            <Button variant="primary" isDisabled disabledReason={startMatchReason}>
              Start match
            </Button>
            <p className="fm-help" id={startMatchReason}>
              Both players need to check in first. Park hasn't yet.
            </p>
          </div>
          <div className="doc-row">
            <Button variant="primary" isDisabled>
              Call to table
            </Button>
            <Button variant="secondary" isDisabled>
              Reschedule
            </Button>
            <Button variant="ghost" isDisabled>
              Print sheet
            </Button>
            <Button variant="danger" isDisabled>
              Withdraw…
            </Button>
          </div>
        </ShowcaseExample>
      </section>
    </main>
  )
}
