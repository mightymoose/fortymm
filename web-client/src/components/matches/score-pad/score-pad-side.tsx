import { User as UserIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ScorePadSideProps {
  side: 'me' | 'opp'
  name: string
  /** `null` means there's no player on this side — render the ghost avatar
   * (dashed circle + person icon) instead of a contrived monogram. */
  initials: string | null
  value: string
  inputRef?: React.RefObject<HTMLInputElement | null>
  autoFocus?: boolean
  disabled?: boolean
  invalid?: boolean
  onChange: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}

/**
 * One participant's score input — the avatar/identity header plus the big
 * numeric field. Side `'me'` puts the avatar on the left of its name, `'opp'`
 * mirrors it. Presentational: the parent owns the value, validity, and key
 * handling; this renders them. Extracted from the scratchpad score-entry so the
 * scratchpad save and the propose-a-result surfaces share the same input.
 */
export const ScorePadSide = ({
  side,
  name,
  initials,
  value,
  inputRef,
  autoFocus,
  disabled,
  invalid,
  onChange,
  onKeyDown,
}: ScorePadSideProps) => {
  const noPlayer = initials === null
  const avatar = (
    <div className="av" aria-hidden={noPlayer || undefined}>
      {noPlayer ? <UserIcon size={20} strokeWidth={1.75} /> : initials}
    </div>
  )
  const identity = (
    <div className="id">
      <div className="nm">{name}</div>
    </div>
  )

  return (
    <div className={cn('se-side', side, noPlayer && 'no-opponent')}>
      <div className={cn('se-head', side === 'opp' && 'right')}>
        {side === 'opp' && identity}
        {avatar}
        {side === 'me' && identity}
      </div>
      <input
        ref={inputRef}
        className="big-input"
        type="text"
        inputMode="numeric"
        aria-label={`${name} score`}
        aria-invalid={invalid || undefined}
        placeholder="0"
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onFocus={(e) => e.target.select()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
