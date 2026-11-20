import { zodResolver } from '@hookform/resolvers/zod'
import { useBlocker } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import type { Failure } from '../../stores/match-source.ts'
import { BestOfField } from './new-match-screen/BestOfField.tsx'
import { Button } from '../Button.tsx'
import { ButtonLink } from '../ButtonLink.tsx'
import { DeviceAlert, type NewVersionOffer } from '../DeviceAlert.tsx'
import { DiscardChangesDialog } from './new-match-screen/DiscardChangesDialog.tsx'
import { dropKeys, keepKeys } from '../type-ahead.ts'
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
// to `onSubmit`, and waits for its answer. One the device refused (its
// storage, its locks, signing, or the core not loaded) shows an error alert
// above the summary, read out at once (DeviceAlert: what failed, what we know, what to do),
// with the form as chosen. The next Start match takes it away the moment it
// is pressed; a refusal again shows it anew. Where a kept match goes is the
// caller's. Start match pressed again while the first is on its way, or
// once it was kept, does nothing: one press, at most one match.
//
// Leaving a changed form (one that isn't as it opened) asks first, "Discard
// changes?", whether by Cancel, any other link, or the browser's back;
// closing or reloading the tab asks through the browser, except the reload
// to a new version the alert offers.
// It renders in the layout's <main> (AppLayout).
export function NewMatchScreen({
  onSubmit,
  newVersion,
}: {
  onSubmit: (match: NewMatch) => Promise<{ ok: true } | ({ ok: false } & Failure)>
  newVersion: NewVersionOffer
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
  // What the device refused of the last Start match, if it did, and which
  // answer that was: each refusal is a new alert, read out again, even when
  // its words are the same.
  const [refused, setRefused] = useState<Failure['reason'] | null>(null)
  const [answers, setAnswers] = useState(0)
  // Set once the person asked for the new version: that reload doesn't ask.
  const reloading = useRef(false)
  // Set from Start match's press until the device refuses it: a kept match
  // can't be taken back, so a second press while the first is on its way,
  // or after it was kept, starts nothing (a double tap keeps one match).
  // Set in the press itself, before the form's asynchronous validation.
  const starting = useRef(false)
  // Set once the match is kept: game 1's page, which takes the kept keys,
  // opens next. Until then, leaving this page drops them: keys typed on
  // another page are that page's, never the new match's.
  const kept = useRef(false)
  useEffect(
    () => () => {
      if (!kept.current) dropKeys()
    },
    [],
  )

  // The one leave guard: the form's own dirty state, against its defaults.
  const blocker = useBlocker({
    shouldBlockFn: () => isDirty,
    enableBeforeUnload: () => isDirty && !reloading.current,
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
        onSubmit={(event) => {
          event.preventDefault()
          if (starting.current) return
          starting.current = true
          // Keys typed while the match is being kept are for game 1's page.
          keepKeys()
          void handleSubmit(
            async (match) => {
              setRefused(null)
              const result = await onSubmit(match)
              kept.current = result.ok
              if (result.ok) return
              dropKeys()
              starting.current = false
              setAnswers((n) => n + 1)
              setRefused(result.reason)
            },
            () => {
              dropKeys()
              starting.current = false
            },
          )(event)
        }}
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

        {refused !== null && (
          <div key={answers} className="new-match__refused">
            <DeviceAlert
              refusal={{ action: 'start', reason: refused }}
              newVersion={newVersion}
              unsaved={isDirty}
              onReload={() => {
                reloading.current = true
              }}
            />
          </div>
        )}

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
