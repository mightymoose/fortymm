import { useLayoutEffect, useRef, type ComponentProps } from 'react'
import { useFieldControl } from './fieldContext'

// A checkbox with its label: a real <input type="checkbox">, visually hidden,
// and a `.checkbox-box` after it that draws its state, all inside a <label>
// with the label text (`children`). Styled by `.checkbox` in styles/base.css.
//
// Inside a Field it takes the field's invalid, required and disabled state
// and is described by its FieldHelp. It carries its own label, so the Field
// needs no Label.
//
// `indeterminate` sets the input's indeterminate property (read as "mixed"
// by assistive tech), shown as a dash. As natively, a click clears it; it's
// set again on the next render while the prop stays true.
export function Checkbox({
  indeterminate = false,
  className,
  children,
  ref,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & { indeterminate?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    inputRef.current!.indeterminate = indeterminate
  })
  return (
    <label className={className ? `checkbox ${className}` : 'checkbox'}>
      <input
        ref={(input) => {
          inputRef.current = input
          if (typeof ref === 'function') return ref(input)
          if (ref) ref.current = input
        }}
        className="checkbox-input visually-hidden"
        type="checkbox"
        {...useFieldControl(props)}
      />
      <span className="checkbox-box" aria-hidden="true">
        <svg
          className="checkbox-check"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <path d="M2 6.5l2.5 2.5L10 3" />
        </svg>
        <svg
          className="checkbox-dash"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <path d="M2.5 6h7" />
        </svg>
      </span>
      {children}
    </label>
  )
}
