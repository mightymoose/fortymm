import { useLayoutEffect, useRef, useState } from 'react'
import { tokenValue } from '../theme/token-value.ts'
import { Board, BoardGrid, BoardSection, Spec, Stage } from './Board.tsx'
import { lineHeights, textSizes } from './design-system-tokens.ts'
import { typeSpec } from './type-tab/type-spec.ts'
import './TypeTab.css'

// The type styles (the role classes of tokens.css), in the board's order,
// with a sample of each.
const styles = [
  { name: 'h1', sample: 'Round of 16' },
  { name: 'h2', sample: 'Table 3 is free' },
  { name: 'h3', sample: 'Nguyen, Thanh vs Okafor, Daniel' },
  {
    name: 'body',
    sample: 'Your next match is at 19:40. You have 25 minutes to rest.',
  },
  { name: 'meta', sample: 'Riverside TT · 2,145' },
  { name: 'label', sample: 'Labels are sentence case, 13px, no letter-spacing' },
  { name: 'score', sample: '11' },
  { name: 'scoreboard-display', sample: 'Nguyen' },
]

const weights = [400, 500, 600, 700]

// The design system page's Type tab (/design-system/type): the three
// families, the type styles, the size scale and the line heights, as the
// reference sheet's Type board (references/design-system/Typography.dc.html),
// with its data-testids. Each value shown is read from the theme (a token's
// value, or what the browser computed for a style's sample), never copied.
export function TypeTab() {
  return (
    <Board
      id="type"
      title="Type"
      intro="Space Grotesk for every word, JetBrains Mono for numbers that align, Bebas Neue only for the wordmark and venue scoreboards. Labels are sentence case, 13px, weight 500, no tracking. Minimum 12px."
    >
      <BoardSection
        id="type-families"
        testId="section-families"
        title="Families"
        description="One specimen per family at each shipped weight."
      >
        <BoardGrid columns={3}>
          <Spec title="--font-ui" detail="headings, labels, body">
            <Stage testId="family-ui" layout="column" panel className="family">
              {weights.map((weight) => (
                <span key={weight} className={`family__ui w${weight}`}>
                  Space Grotesk {weight}
                </span>
              ))}
            </Stage>
          </Spec>
          <Spec title="--font-num" detail="scores, ratings, times">
            <Stage
              testId="family-num"
              layout="column"
              panel
              className="family"
            >
              {weights.map((weight) => (
                <span key={weight} className={`family__num w${weight}`}>
                  0123456789 {weight}
                </span>
              ))}
            </Stage>
          </Spec>
          <Spec title="--font-display" detail="wordmark, venue boards only">
            <Stage
              testId="family-display"
              layout="column"
              panel
              className="family family--display"
            >
              <span className="scoreboard-display">FortyMM</span>
              <span className="scoreboard-display">Nguyen · Okafor</span>
            </Stage>
          </Spec>
        </BoardGrid>
      </BoardSection>

      <BoardSection
        id="type-styles"
        testId="section-type-styles"
        title="Type styles"
        description={
          <>
            The role classes from <code>tokens.css</code>. Each row is one
            target: <code>type-&lt;style&gt;</code>.
          </>
        }
      >
        <div className="type-styles">
          {styles.map((style) => (
            <TypeStyle key={style.name} {...style} />
          ))}
        </div>
      </BoardSection>

      <BoardSection
        id="type-size-scale"
        testId="section-size-scale"
        title="Size scale"
        description="48 / 32 / 24 / 20 / 17 / 15 / 13 / 12, plus 96 for the scoring screen (shown in Type styles)."
      >
        <Stage testId="type-scale" layout="column" className="size-scale">
          {textSizes.map((token) => (
            <div key={token} className="size-scale__row" data-testid={`size-${token}`}>
              <span className="size-scale__name">
                --{token} · {tokenValue(token)}
              </span>
              <span
                className="size-scale__sample"
                style={{ fontSize: `var(--${token})` }}
              >
                Table 3 is free
              </span>
            </div>
          ))}
        </Stage>
      </BoardSection>

      <BoardSection
        id="type-line-heights"
        testId="section-line-heights"
        title="Line heights"
        description="Two lines each at 20px so the leading is measurable."
      >
        <BoardGrid columns={3}>
          {lineHeights.map(({ token, use }) => (
            <Spec
              key={token}
              title={`--${token}`}
              detail={`${tokenValue(token)} · ${use}`}
            >
              <Stage testId={`lh-${token}`} panel>
                <span
                  className="line-height__sample"
                  style={{ lineHeight: `var(--${token})` }}
                >
                  Okafor's singles runs
                  <br />
                  15 min over on Table 2
                </span>
              </Stage>
            </Spec>
          ))}
        </BoardGrid>
      </BoardSection>
    </Board>
  )
}

// One type style: its class and spec (worked out from what the browser
// computed for the sample, type-spec.ts), and the sample.
function TypeStyle({ name, sample }: { name: string; sample: string }) {
  const sampleRef = useRef<HTMLSpanElement>(null)
  const [spec, setSpec] = useState('')

  useLayoutEffect(() => {
    if (sampleRef.current === null) return
    setSpec(
      typeSpec(getComputedStyle(sampleRef.current), {
        numFamily: tokenValue('font-num'),
        displayFamily: tokenValue('font-display'),
        colours: { 'fg-2': tokenValue('fg-2'), 'fg-3': tokenValue('fg-3') },
      }),
    )
  }, [])

  return (
    <div className="type-styles__row">
      <div className="type-styles__name">
        <span>.{name}</span>
        <span>{spec}</span>
      </div>
      <Stage testId={`type-${name}`} className="type-styles__stage">
        <span ref={sampleRef} className={`type-sample ${name}`}>
          {sample}
        </span>
      </Stage>
    </div>
  )
}
