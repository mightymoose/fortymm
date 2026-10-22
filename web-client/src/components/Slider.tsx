import {
  Fragment,
  useId,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useFieldControl } from './fieldContext'

// A number picks one value (one thumb); a pair picks a range (two thumbs).
export type SliderValue = number | readonly [low: number, high: number]

// A slider with its label and value: a `.slider-field` holding a header (the
// label text, `children`, and an <output> showing the value) and a `.slider`
// that draws the track, the fill and a thumb per value. A real
// <input type="range">, invisible, lies over each drawn thumb and takes the
// pointer and the keyboard. Styled by `.slider` in styles/base.css.
//
// `value`/`onValueChange` control the value; `defaultValue` sets it
// otherwise. Its shape picks the mode, and `onValueChange` gets the same
// shape back. A range's thumbs never cross: each stops at the other.
//
// Inside a Field it takes the field's disabled state and every input is
// described by its FieldHelp. It carries its own label, so the Field needs no
// Label. A slider always holds a value between `min` and `max`, so it takes
// no `required` or `aria-invalid`, from its props or the Field.
export function Slider<V extends SliderValue>({
  min,
  max,
  step,
  value,
  defaultValue,
  onValueChange,
  disabled,
  className,
  children,
}: {
  min: number
  max: number
  step?: number
  value?: V
  defaultValue?: V
  onValueChange?: (value: V) => void
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  const [uncontrolled, setUncontrolled] = useState<SliderValue>(
    defaultValue ?? min,
  )
  const current = value ?? uncontrolled
  const change = (next: SliderValue) => {
    if (value === undefined) setUncontrolled(next)
    onValueChange?.(next as V)
  }

  const labelId = useId()
  const wordIds = [useId(), useId()]
  const ownIds = [useId(), useId()]
  const control = useFieldControl<ComponentProps<'input'>>({
    ...(disabled !== undefined && { disabled }),
  })
  // A Field's control id goes to the first input only, so no two share it.
  const ids = [control.id ?? ownIds[0], ownIds[1]]
  const position = (v: number) => `${((v - min) * 100) / (max - min)}%`

  // One thumb per value, each with the words that finish its input's name
  // and how a new value from it becomes the slider's value.
  const thumbs: {
    value: number
    word?: string
    next: (value: number) => SliderValue
  }[] =
    typeof current === 'number'
      ? [{ value: current, next: (v) => v }]
      : [
          {
            value: current[0],
            word: 'minimum',
            next: (v) => [Math.min(v, current[1]), current[1]],
          },
          {
            value: current[1],
            word: 'maximum',
            next: (v) => [current[0], Math.max(v, current[0])],
          },
        ]
  const low = typeof current === 'number' ? min : current[0]
  // Where a range's thumbs meet, only the top input's thumb takes the
  // pointer, so the top one is the one that can move away: the high one near
  // `min`, the low one near `max`.
  const lowOnTop = thumbs.length === 2 && low > (min + max) / 2

  return (
    <div className={className ? `slider-field ${className}` : 'slider-field'}>
      <div className="slider-header">
        <span className="slider-label" id={labelId}>
          {children}
        </span>
        <output
          className="slider-value"
          htmlFor={ids.slice(0, thumbs.length).join(' ')}
          aria-live="off"
        >
          {thumbs.map((thumb) => thumb.value).join(' – ')}
        </output>
      </div>
      <div
        className={thumbs.length === 2 ? 'slider slider--range' : 'slider'}
        style={
          {
            '--slider-low': position(low),
            '--slider-high': position(thumbs[thumbs.length - 1].value),
          } as CSSProperties
        }
      >
        <div className="slider-track" aria-hidden="true">
          <div className="slider-fill" />
        </div>
        {thumbs.map((thumb, index) => (
          <Fragment key={index}>
            {thumb.word && (
              <span className="visually-hidden" id={wordIds[index]}>
                {thumb.word}
              </span>
            )}
            <input
              className={
                index === 0 && lowOnTop
                  ? 'slider-input slider-input--top'
                  : 'slider-input'
              }
              type="range"
              id={ids[index]}
              min={min}
              max={max}
              step={step}
              value={thumb.value}
              onChange={(event) =>
                change(thumb.next(Number(event.target.value)))
              }
              disabled={control.disabled}
              aria-labelledby={
                thumb.word ? `${labelId} ${wordIds[index]}` : labelId
              }
              aria-describedby={control['aria-describedby']}
            />
            <span
              className="slider-thumb"
              aria-hidden="true"
              style={{ left: position(thumb.value) }}
            />
          </Fragment>
        ))}
      </div>
    </div>
  )
}
