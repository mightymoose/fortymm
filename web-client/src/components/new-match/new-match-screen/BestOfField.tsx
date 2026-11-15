import { useSingleSelection } from '../../single-selection.ts'
import { bestOfs, type BestOf } from '../../../scoring/scoring.ts'
import './BestOfField.css'

// How long a match is: the most games it can take (the form's schema says
// which), each with fortymm-real's name for it. The winner is first to more
// than half of them.
const names: Record<BestOf, string> = {
  1: 'Single',
  3: 'Short',
  5: 'Std',
  7: 'Long',
}

const options = bestOfs.map((n) => ({ n, label: names[n] }))

function help(bestOf: BestOf) {
  return bestOf === 1
    ? 'One game, winner takes all. Games to 11, win by 2.'
    : `First to ${Math.ceil(bestOf / 2)} games. Games to 11, win by 2.`
}

// The match's length (fortymm-real's BestOfField): a radiogroup named
// "Match length", one radio per length, each a big number over its name
// ("5", "Std") and named "Best of 5". The arrow keys move between them and
// choose (single-selection.ts, as the design system's segmented control
// does). Under it, what the choice means.
export function BestOfField({
  bestOf,
  onChange,
}: {
  bestOf: BestOf
  onChange: (bestOf: BestOf) => void
}) {
  const { optionProps } = useSingleSelection({
    options: options.map((option) => ({ value: String(option.n) })),
    defaultValue: String(bestOf),
    onChange: (value) => onChange(Number(value) as BestOf),
  })

  return (
    <div className="best-of">
      {/* The radiogroup is named "Match length" itself; this is that name,
          shown. */}
      <span className="best-of__label" aria-hidden="true">
        Match length
      </span>
      <div role="radiogroup" aria-label="Match length" className="best-of__options">
        {options.map((option) => (
          <button
            key={option.n}
            {...optionProps({ value: String(option.n) })}
            type="button"
            role="radio"
            aria-checked={option.n === bestOf}
            aria-label={`Best of ${option.n}`}
            className="best-of__option"
          >
            <span className="best-of__n">{option.n}</span>
            <span className="best-of__name">{option.label}</span>
          </button>
        ))}
      </div>
      <p className="best-of__help">{help(bestOf)}</p>
    </div>
  )
}
