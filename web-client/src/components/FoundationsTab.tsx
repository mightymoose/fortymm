import type { ReactNode } from 'react'
import { tokenValue } from '../theme/token-value.ts'
import { Board, BoardGrid, BoardSection, Spec, Stage } from './Board.tsx'
import { radii, spaces } from './design-system-tokens.ts'
import { Icon, type IconName } from './Icon.tsx'
import { LiveMarker } from './LiveMarker.tsx'
import { RatingChange } from './RatingChange.tsx'
import { RestMarker } from './RestMarker.tsx'
import { ServeMarker } from './ServeMarker.tsx'
import { StatusMarker } from './StatusMarker.tsx'
import './FoundationsTab.css'

// The icons, in the board's order: each at 20px, then three at 16px.
const icons: IconName[] = [
  'check',
  'circle-check',
  'x',
  'plus',
  'triangle-alert',
  'circle-alert',
  'info',
  'clock',
  'calendar',
  'search',
  'chevron-down',
  'ellipsis',
  'undo',
]
const smallIcons: IconName[] = ['check', 'clock', 'search']

// The design system page's Foundations tab (/design-system/foundations):
// spacing, radii, the two shadows and the focus ring, the status markers
// and the icons, as the reference sheet's "Spacing, radii, shadows, icons"
// board (references/design-system/Foundations.dc.html), with its
// data-testids. Each token's value is read from the theme, never copied.
export function FoundationsTab() {
  return (
    <Board
      id="foundations"
      title="Foundations"
      intro="Layout tokens, the only two shadows, the focus ring, status markers and the Lucide icon set at 20px / 1.75 stroke."
    >
      <BoardSection
        id="foundations-spacing"
        testId="section-spacing"
        title="Spacing"
        description="4px base. 8–12 within a row, 16–24 between groups, 48–64 between page sections."
      >
        <Stage testId="spacing-scale" layout="column" className="spacing-scale">
          {spaces.map((token) => (
            <div
              key={token}
              className="spacing-scale__row"
              data-testid={`space-${token}`}
            >
              <span className="spacing-scale__name">--{token}</span>
              <span className="spacing-scale__value">{tokenValue(token)}</span>
              <span
                className="spacing-scale__bar"
                style={{ width: `var(--${token})` }}
              />
            </div>
          ))}
        </Stage>
      </BoardSection>

      <BoardSection
        id="foundations-radii"
        testId="section-radii"
        title="Radii"
        description="6 chips and inputs · 8 buttons and cards · 12 sheets, dialogs, score pads · pill for filter chips only."
      >
        <BoardGrid columns={4}>
          {radii.map(({ token, use }) => (
            <Spec
              key={token}
              title={`--${token}`}
              detail={`${tokenValue(token)} · ${use}`}
            >
              <Stage testId={`radius-${token}`} layout="center">
                <span
                  className="radius-sample"
                  style={{ borderRadius: `var(--${token})` }}
                />
              </Stage>
            </Spec>
          ))}
        </BoardGrid>
      </BoardSection>

      <BoardSection
        id="foundations-shadows"
        testId="section-shadows"
        title="Shadows and focus"
        description="Overlays only. Nothing in the page flow has a shadow. Focus is always the same 2px orange ring with a dark gap."
      >
        <BoardGrid columns={3}>
          <Spec title="--shadow-overlay" detail="menus, dialogs, toasts">
            <Stage testId="shadow-overlay" layout="center" className="shadow-stage">
              <span className="shadow-sample shadow-sample--overlay" />
            </Stage>
          </Spec>
          <Spec title="--shadow-tooltip" detail="tooltips">
            <Stage testId="shadow-tooltip" layout="center" className="shadow-stage">
              <span className="shadow-sample shadow-sample--tooltip" />
            </Stage>
          </Spec>
          <Spec title="--focus-ring" detail="2px ink-950 + 2px ball-500">
            <Stage testId="focus-ring" layout="center" className="shadow-stage">
              <span className="shadow-sample shadow-sample--focus" />
            </Stage>
          </Spec>
        </BoardGrid>
      </BoardSection>

      <BoardSection
        id="foundations-status-markers"
        testId="section-status-markers"
        title="Status markers"
        description="One signal per element. Each status has a hue and a non-colour cue (word, shape or sign)."
      >
        <BoardGrid columns={4}>
          {marker('marker-live', 'LiveMarker', '--live', <LiveMarker />)}
          {marker(
            'marker-serve',
            'ServeMarker',
            '--serving',
            <>
              <ServeMarker />
              <span className="marker-player">Nguyen, Thanh</span>
            </>,
          )}
          {marker(
            'marker-rating-up',
            'RatingChange',
            '--rating-up',
            <RatingChange change={12} />,
          )}
          {marker(
            'marker-rating-down',
            'RatingChange',
            '--rating-down',
            <RatingChange change={-8} />,
          )}
          {marker('marker-rest', 'RestMarker', '--rest', <RestMarker until="19:35" />)}
          {marker(
            'marker-offline',
            'StatusMarker offline',
            '--fg-3 ring',
            <StatusMarker status="offline">Offline · updated 11:42</StatusMarker>,
          )}
          {marker(
            'marker-conflict',
            'StatusMarker conflict',
            '--conflict',
            <StatusMarker status="conflict">Needs decision</StatusMarker>,
          )}
          {marker(
            'marker-danger',
            'StatusMarker danger',
            '--danger',
            <StatusMarker status="danger">Withdrawn</StatusMarker>,
          )}
        </BoardGrid>
      </BoardSection>

      <BoardSection
        id="foundations-icons"
        testId="section-icons"
        title="Icons"
        description={
          <>
            Lucide, stroke 1.75, 20px (16px in dense tables). Inherit{' '}
            <code>currentColor</code>. No emoji.
          </>
        }
      >
        <Stage testId="icon-set" className="icon-set">
          {icons.map((name) => (
            <span key={name} className="icon-set__icon" data-testid={`icon-${name}`}>
              <Icon name={name} />
            </span>
          ))}
          {smallIcons.map((name) => (
            <span
              key={name}
              className="icon-set__icon icon-set__icon--sm"
              data-testid={`icon-${name}-sm`}
            >
              <Icon name={name} size="sm" />
            </span>
          ))}
        </Stage>
      </BoardSection>
    </Board>
  )
}

// A status marker's example, captioned with its component and its colour.
function marker(
  testId: string,
  component: string,
  colour: string,
  example: ReactNode,
) {
  return (
    <Spec key={testId} title={component} detail={colour}>
      <Stage testId={testId}>{example}</Stage>
    </Spec>
  )
}
