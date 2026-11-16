import { zodResolver } from '@hookform/resolvers/zod'
import { useBlocker } from '@tanstack/react-router'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { BestOfField } from './new-match-screen/BestOfField.tsx'
import { Button } from '../Button.tsx'
import { ButtonLink } from '../ButtonLink.tsx'
import { DiscardChangesDialog } from './new-match-screen/DiscardChangesDialog.tsx'
import { Icon } from '../Icon.tsx'
import { opponentLabel } from '../opponent.ts'
import {
  newMatchDefaults,
  newMatchSchema,
  type NewMatch,
  type NewMatchValues,
} from './NewMatchScreen.schema.ts'
import './NewMatchScreen.css'

// What the form gives its handler (NewMatchScreen.schema.ts): the match's
// format (`format: {bestOf}`), and whether it is rated (never, for now).
export type { NewMatch }

// The new match screen, at /matches/new, after fortymm-real's match setup:
// the title, then one card. In it: the match's length, then a summary of
// the match ("Ready: You vs Anonymous", its length, "Unrated") with Cancel
// and Start match. The form asks no opponent's name and no rating: every
// match is against "Anonymous" (components/opponent.ts), and unrated.
//
// A React Hook Form form whose rules are `newMatchSchema` (web-client/
// CLAUDE.md, "Forms"). Start match hands what the schema makes of the form
// to `onSubmit`.
//
// Leaving a changed form (one that isn't as it opened) asks first, "Discard
// changes?", whether by Cancel, any other link, or the browser's back;
// closing or reloading the tab asks through the browser.
// It renders in the layout's <main> (AppLayout).
export function NewMatchScreen({
  onSubmit,
}: {
  onSubmit: (match: NewMatch) => void
}) {
  const {
    control,
    formState: { isDirty },
    handleSubmit,
  } = useForm<NewMatchValues, unknown, NewMatch>({
    resolver: zodResolver(newMatchSchema),
    defaultValues: newMatchDefaults,
  })
  const bestOf = useWatch({ control, name: 'bestOf' })

  // The one leave guard: the form's own dirty state, against its defaults.
  const blocker = useBlocker({
    shouldBlockFn: () => isDirty,
    enableBeforeUnload: () => isDirty,
    withResolver: true,
  })

  return (
    <>
    <div className="new-match">
      <h1 className="new-match__title">
        New match
        <span className="new-match__dot" aria-hidden="true">
          .
        </span>
      </h1>

      <form
        className="new-match__card"
        aria-label="New match"
        noValidate
        onSubmit={handleSubmit((match) => onSubmit(match))}
      >
        <div className="new-match__settings">
          <Controller
            control={control}
            name="bestOf"
            render={({ field }) => (
              <BestOfField bestOf={field.value} onChange={field.onChange} />
            )}
          />
        </div>

        <div className="new-match__summary">
          <div className="new-match__read">
            <p className="new-match__headline">
              Ready: <b>You</b> vs <b>{opponentLabel}</b>
            </p>
            <p className="new-match__sub">
              {bestOf === 1
                ? 'Single game'
                : `Best of ${bestOf} · first to ${Math.ceil(bestOf / 2)}`}
              {' · Unrated · games to 11, win by 2'}
            </p>
          </div>
          <div className="new-match__actions">
            <ButtonLink to="/" variant="secondary" size="lg">
              Cancel
            </ButtonLink>
            <Button variant="primary" size="lg" type="submit">
              Start match
              <Icon name="arrow-right" />
            </Button>
          </div>
        </div>
      </form>
    </div>
    {/* Outside the page's box, so nothing of the page's layout reaches it:
        it covers the whole screen. */}
    {blocker.status === 'blocked' && (
      <DiscardChangesDialog
        onLeave={() => blocker.proceed()}
        onStay={() => blocker.reset()}
      />
    )}
    </>
  )
}
