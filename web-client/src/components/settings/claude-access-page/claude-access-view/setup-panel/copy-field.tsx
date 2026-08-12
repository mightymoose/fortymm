import { useId } from 'react'

/** How the last copy attempt on *this* field went — `null` when the last
 * attempt was on the other field, or when there hasn't been one. */
export type CopyFieldOutcome = 'copied' | 'failed' | null

export interface CopyFieldProps {
  /** The overline above the value, e.g. `Connector URL`. Also names the field's
   * group, and describes its copy button. */
  label: string
  /** The value a player pastes into Claude. Shown verbatim, in mono. */
  value: string
  /** The copy button's visible label — always says *what* it copies, so two
   * buttons on one panel never read as the same control. */
  buttonLabel: string
  /** `primary` for the value a player cannot skip (the URL), `secondary` for
   * the one tucked behind Claude's Advanced settings. */
  tone: 'primary' | 'secondary'
  outcome: CopyFieldOutcome
  onCopy: () => void
}

/**
 * One labelled, copyable connector value.
 *
 * Three things a player can get the value with, in descending order of
 * convenience: the button, a single click on the value itself
 * (`user-select: all`, from CSS), and — when the clipboard is unavailable —
 * the same click plus their own copy shortcut, which is what the failure line
 * tells them to do.
 *
 * The field is a **named group** so that its marker, its value and its button
 * are one addressable unit: "the marker is on the URL field" is then a fact
 * about this subtree rather than about the page.
 */
export function CopyField({
  label,
  value,
  buttonLabel,
  tone,
  outcome,
  onCopy,
}: CopyFieldProps) {
  const labelId = useId()

  return (
    <div className="fmm-claude__copy" role="group" aria-labelledby={labelId}>
      <div className="fmm-claude__copy-head">
        <span className="fmm-claude__copy-label" id={labelId}>
          {label}
        </span>
        {outcome === 'copied' && (
          <span className="fmm-claude__copied">COPIED</span>
        )}
      </div>
      <div className="fmm-claude__copy-row">
        <span className="fmm-claude__copy-value">{value}</span>
        <button
          type="button"
          className={`fmm-claude__copy-button fmm-claude__copy-button--${tone}`}
          onClick={onCopy}
          // So "Copy URL" is announced with the field it belongs to rather than
          // as one of two similarly-named buttons.
          aria-describedby={labelId}
        >
          {buttonLabel}
        </button>
      </div>
      {outcome === 'failed' && (
        <p className="fmm-claude__copy-error">
          We couldn't reach your clipboard. Select the value above and copy it
          yourself.
        </p>
      )}
    </div>
  )
}
