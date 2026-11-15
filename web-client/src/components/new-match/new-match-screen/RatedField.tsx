import { useId } from 'react'
import { Switch } from '../../Switch.tsx'
import './RatedField.css'

// Whether the match counts toward both players' ratings (fortymm-real's
// RatedField), on the design system's Switch, named "Rated match". Only a
// match with an opponent can be rated: until the form has one (`ratable`),
// the switch is off and disabled (announced as unavailable), and the line
// under it, which describes it, says what to do. Otherwise that line says
// what the choice means. Its visible label, "Rated match", is the switch's
// name, so assistive technology skips the label itself.
//
// fortymm-real's hint to a guest to add an email once rated is on isn't
// here: this app has no emails.
export function RatedField({
  rated,
  ratable,
  onChange,
}: {
  rated: boolean
  ratable: boolean
  onChange: (rated: boolean) => void
}) {
  const id = useId()
  const on = rated && ratable
  const description = on
    ? 'Result will update both ratings.'
    : ratable
      ? 'No rating change. Still logged to history.'
      : 'Enter your opponent’s name to make this rated.'

  return (
    <div className="rated-field">
      <span className="rated-field__label" aria-hidden="true">
        Rated match
      </span>
      <div className="rated-field__box" data-on={on || undefined}>
        <Switch
          aria-label="Rated match"
          aria-describedby={`${id}-description`}
          checked={on}
          disabled={!ratable}
          onCheckedChange={onChange}
        >
          <span className="rated-field__title">
            {on ? 'Counts toward rating' : 'Just for fun'}
          </span>
        </Switch>
        <p id={`${id}-description`} className="rated-field__description">
          {description}
        </p>
      </div>
    </div>
  )
}
