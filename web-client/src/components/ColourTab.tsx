import { colourValue } from '../theme/token-value.ts'
import { Board, BoardGrid, BoardSection, Stage } from './Board.tsx'
import { colourGroups, surfaces } from './design-system-tokens.ts'
import './ColourTab.css'

// The design system page's Colour tab (/design-system/colour): every colour
// token, as the reference sheet's Colour board
// (references/design-system/Main.dc.html), with its data-testids. Each
// swatch paints from its token and shows the value the stylesheet gives it
// (colourValue()), so a token that changes changes its picture.
export function ColourTab() {
  return (
    <Board
      id="colour"
      title="Colour"
      intro="Every colour token, painted from the theme, with the value the theme gives it. Dark only."
    >
      {colourGroups.map((group) => (
        <BoardSection
          key={group.id}
          id={`colour-${group.id}`}
          testId={`section-${group.id}`}
          title={group.title}
          description={group.note}
        >
          <BoardGrid columns={group.columns}>
            {group.tokens.map((token) => (
              <Swatch key={token} token={token} />
            ))}
          </BoardGrid>
        </BoardSection>
      ))}

      <BoardSection
        id="colour-text-on-surfaces"
        testId="section-text-on-surfaces"
        title="Text on surfaces"
        description="Foreground tokens on each surface they are approved for. Disabled text sits below 4.5:1 by design."
      >
        <BoardGrid columns={3}>
          {surfaces.map((surface) => (
            <TextOnSurface key={surface} surface={surface} />
          ))}
        </BoardGrid>
      </BoardSection>
    </Board>
  )
}

// One token's swatch: the colour, its name and its value.
function Swatch({ token }: { token: string }) {
  return (
    <div className="swatch" data-testid={`color-${token}`}>
      <div
        className="swatch__chip"
        style={{ background: `var(--${token})` }}
      />
      <div className="swatch__meta">
        <b>--{token}</b>
        <span>{colourValue(token)}</span>
      </div>
    </div>
  )
}

// Each foreground token on one surface.
function TextOnSurface({ surface }: { surface: string }) {
  return (
    <Stage
      testId={`text-on-${surface}`}
      layout="column"
      className={`text-on-surface text-on-surface--${surface}`}
    >
      <span className="text-on-surface__name">--{surface}</span>
      <span className="text-on-surface__fg-1">fg-1 · Nguyen, Thanh 11</span>
      <span className="text-on-surface__fg-2">
        fg-2 · Your next match is at 19:40.
      </span>
      <span className="text-on-surface__fg-3">fg-3 · Riverside TT · 2,145</span>
      <span className="text-on-surface__placeholder">
        fg-placeholder · Search players
      </span>
      <span className="text-on-surface__disabled">
        fg-disabled · Call to table
      </span>
      <span className="text-on-surface__accent">
        accent-text on accent-soft
      </span>
    </Stage>
  )
}
