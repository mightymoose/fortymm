import { zodResolver } from '@hookform/resolvers/zod'
import { useBlocker } from '@tanstack/react-router'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { BestOfField } from './new-match-screen/BestOfField.tsx'
import { Button } from '../Button.tsx'
import { ButtonLink } from '../ButtonLink.tsx'
import { DiscardChangesDialog } from './new-match-screen/DiscardChangesDialog.tsx'
import { Field } from '../Field.tsx'
import { Icon } from '../Icon.tsx'
import { opponentLabel } from '../opponent.ts'
import {
  newMatchDefaults,
  newMatchSchema,
  opponentNameSchema,
  type NewMatch,
  type NewMatchValues,
} from './NewMatchScreen.schema.ts'
import { RatedField } from './new-match-screen/RatedField.tsx'
import { TextInput } from '../TextInput.tsx'
import './NewMatchScreen.css'

// What the form gives its handler (NewMatchScreen.schema.ts): the opponent's
// name as typed, trimmed, or `null` with none; the match's format (`format:
// {bestOf}`); and whether it is rated.
export type { NewMatch }

// The new match screen, at /matches/new, after fortymm-real's match setup:
// the title, then one card. In it: the opponent's name, the match's length
// and whether it is rated (side by side where the card is wide enough), then
// a summary of the match ("Ready: You vs Ana", or "You vs Anonymous" with no
// name) with Cancel and Start match.
//
// A React Hook Form form whose rules are `newMatchSchema` (web-client/
// CLAUDE.md, "Forms"). Start match hands what the schema makes of the form
// to `onSubmit`. The opponent's name is optional: left empty, the match is
// recorded with no opponent. Rated needs an opponent: with no name it is off
// and disabled, and clearing the name turns it off.
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
    formState: { errors, isDirty },
    handleSubmit,
    register,
    setValue,
  } = useForm<NewMatchValues, unknown, NewMatch>({
    resolver: zodResolver(newMatchSchema),
    defaultValues: newMatchDefaults,
  })
  const [opponentName, bestOf, rated] = useWatch({
    control,
    name: ['opponentName', 'bestOf', 'rated'],
  })

  // Every string parses: a blank one to `null`, no opponent. So rated is
  // available when the name parses to a name, never by whether it parses.
  const name = opponentNameSchema.parse(opponentName)
  const ratable = name !== null
  const isRated = rated && ratable

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
        <div className="new-match__opponent">
          <Field
            label="Opponent’s name"
            help="Optional. Leave it empty to record a match without an opponent."
            error={errors.opponentName?.message}
          >
            {(fieldControl) => (
              <TextInput
                {...fieldControl}
                autoComplete="off"
                autoCapitalize="words"
                {...register('opponentName', {
                  // No opponent, no rating: a rated match whose opponent is
                  // cleared is not rated again when another name is typed.
                  onChange: (event: { target: { value: string } }) => {
                    if (opponentNameSchema.parse(event.target.value) === null)
                      setValue('rated', false, { shouldDirty: true })
                  },
                })}
              />
            )}
          </Field>
        </div>

        <div className="new-match__settings">
          <Controller
            control={control}
            name="bestOf"
            render={({ field }) => (
              <BestOfField bestOf={field.value} onChange={field.onChange} />
            )}
          />
          <Controller
            control={control}
            name="rated"
            render={({ field }) => (
              <RatedField
                rated={field.value}
                ratable={ratable}
                onChange={field.onChange}
              />
            )}
          />
        </div>

        <div className="new-match__summary">
          <div className="new-match__read">
            <p className="new-match__headline">
              Ready: <b>You</b> vs <b>{opponentLabel(name)}</b>
            </p>
            <p className="new-match__sub">
              {bestOf === 1
                ? 'Single game'
                : `Best of ${bestOf} · first to ${Math.ceil(bestOf / 2)}`}
              {' · '}
              {isRated ? (
                <span className="new-match__rated">Rated</span>
              ) : (
                'Unrated'
              )}
              {' · games to 11, win by 2'}
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
