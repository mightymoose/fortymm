import { cn } from '@/lib/utils'

import { type FormChipsView } from '../rating-panel-query'

export interface FormChipsProps {
  form: FormChipsView
}

/**
 * The player's last ten decided matches, newest first — one chip per result.
 *
 * The label comes from the view, so it always names exactly the chips rendered:
 * a player with four decided matches is announced as "Last 4", not "Last 10".
 * (The `/players` roster renders the same wire field five-wide; that slice lives
 * there, not here — the profile is the surface that wants all ten.)
 */
export const FormChips = ({ form }: FormChipsProps) => (
  <span className="player-profile__form" aria-label={form.label}>
    {form.results.map((result, i) => (
      <span
        key={i}
        aria-hidden="true"
        className={cn(
          'player-profile__form-chip',
          result === 'W'
            ? 'player-profile__form-chip--w'
            : 'player-profile__form-chip--l',
        )}
      >
        {result}
      </span>
    ))}
  </span>
)
