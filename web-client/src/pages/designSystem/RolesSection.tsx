import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { DetailList } from '../../components/DetailList'
import { Icon } from '../../components/Icon'
import { RatingChange } from '../../components/RatingChange'
import { Toast } from '../../components/Toast'
import { BusyDemoButton } from './BusyDemoButton'
import { GallerySection } from './GallerySection'

// The design system page's Roles at a glance section: the reference
// gallery's `section-roles`. It has no examples, only each role side by side
// over its caption. It is visual only, so its buttons do nothing, except
// Retry now, which shows Retrying… as the gallery's `data-busy` does.
export function RolesSection() {
  return (
    <GallerySection
      id="roles"
      title="Roles at a glance"
      lead="Same tokens, different structure. You should know which one you're looking at before you read it."
    >
      <div className="doc-roles" style={{ marginTop: 48 }}>
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
            actions={
              <>
                <Button variant="primary">I'm at the table</Button>
                <Button variant="ghost">Directions</Button>
              </>
            }
          >
            <DetailList
              details={[
                { term: 'Opponent', value: 'Park, Ji-ho' },
                { term: 'Table', value: 'Table 2' },
              ]}
            />
            <p className="fm-notice fm-notice--rest">
              <Icon name="clock" />
              <span>
                You rest until <span className="num">11:55</span>. We'll call you after that.
              </span>
            </p>
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
            <p className="fm-notice">
              <Icon name="info" />
              <span>Draws are fixed. Seeds come from ratings on 1 April.</span>
            </p>
            <p className="fm-notice fm-notice--success">
              <Icon name="check" />
              <span>
                Check-in saved at <span className="num">09:42</span>.
              </span>
            </p>
          </div>
          <p className="doc-cap" style={{ marginTop: 40 }}>
            Toast — raised, brief, offers Undo
          </p>
          <Toast
            role="status"
            data-testid="role-toast"
            message={
              <>
                Result saved. Nguyen <RatingChange change={12} />
              </>
            }
            onUndo={() => {}}
          />
          <p className="doc-cap" style={{ marginTop: 40 }}>
            Tooltip — supplementary
          </p>
          <span className="fm-tooltip fm-tooltip--static" data-testid="role-tooltip">
            Johansen-Whitfield, Annika vs Rossi, Giulia · 11:05–11:40
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          <div data-testid="role-warning">
            <p className="doc-cap">Warning — problem and the fix</p>
            <div className="fm-alert fm-alert--warning">
              <Icon name="alert" />
              <p className="fm-alert__title">Patel would get 5 minutes’ rest</p>
              <p className="fm-alert__body">
                Her Table 3 match is running over. Starting at 12:05 keeps the 15-minute
                minimum.
              </p>
              <div className="fm-alert__actions">
                <Button variant="primary" size="sm">
                  Move to 12:05
                </Button>
                <Button variant="secondary" size="sm">
                  Keep 11:50
                </Button>
              </div>
            </div>
          </div>
          <div data-testid="role-error">
            <p className="doc-cap">Error — what failed and how to recover</p>
            <div className="fm-alert fm-alert--error">
              <Icon name="error" />
              <p className="fm-alert__title">Results didn't sync</p>
              <p className="fm-alert__body">You're offline. 3 results are saved on this device.</p>
              <div className="fm-alert__actions">
                <BusyDemoButton
                  variant="primary"
                  size="sm"
                  label="Retry now"
                  busyLabel="Retrying…"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="doc-vo" style={{ marginTop: 24 }}>
        Visual only · buttons in this overview are not wired up
      </p>
    </GallerySection>
  )
}
