import { fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach } from 'vitest'

import { ApiError } from '@/api/client'
import { screen, waitFor } from '@/test/utilities'

import { emptyEvent } from '../data/helpers'
import { eventToUpdateBody } from '../data/api'
import {
  buildEvent,
  buildFixture,
  buildPool,
  buildPredicate,
  buildRrThenKoEvent,
  buildTournament,
} from '../data/seed.factory'
import { eventEditorPage } from './event-editor.page'

// A name genuinely past the server's VARCHAR(255) limit — the #933 case. A short
// name would sail through the client schema and prove nothing.
const OVER_LONG_NAME = 'A'.repeat(300)

describe('EventEditor', () => {
  it('saves the working draft and closes on success', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    eventEditorPage.render({
      event: buildEvent({ name: 'Open Singles' }),
      onSave,
      onOpenChange,
    })

    await userEvent.click(eventEditorPage.getSaveButton())
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Open Singles' }),
      ),
    )
    // The panel closes only after the save resolves.
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  /**
   * **K**, through the whole editor (ADR 20260727) — the picker, the resolver, and the
   * body that leaves the client.
   *
   * The section's own tests prove the row is conditional; these prove the three things
   * only the *editor* can: that switching the served picker reveals and hides it, that a
   * bad count is refused BEFORE anything is sent, and — the one that matters most — that
   * the value a director types is on the object handed to `onSave`, which is what
   * `eventToUpdateBody` turns into the request. A test that stopped at form state would
   * pass just as happily against a mapper that dropped the field on the floor.
   */
  describe('the qualifier count, end to end', () => {
    it('reveals the control when the director picks the two-stage format, and hides it again', async () => {
      eventEditorPage.render({ event: buildEvent({ drawType: 'round-robin' }) })
      expect(eventEditorPage.queryQualifiersInput()).toBeNull()

      // The label is the SERVER's (`draw_type_catalogue`), not a string this client keeps.
      await eventEditorPage.chooseDrawType('Round-robin then knockout')
      expect(await screen.findByLabelText(/Qualifiers per pool/)).toBeInTheDocument()

      await eventEditorPage.chooseDrawType('Round robin')
      await waitFor(() =>
        expect(eventEditorPage.queryQualifiersInput()).toBeNull(),
      )
    })

    // ⚠️ THE CLAIM IS ABOUT THE REQUEST, not the box. `onSave` receives the event the
    // page maps with `eventToUpdateBody`, so mapping it here is what the client would
    // really put on the wire — and 2 is neither the planner's fallback (1) nor absent.
    it('SENDS the configured count — the value reaches the request body', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildRrThenKoEvent({ qualifiersPerPool: 1 }),
        onSave,
      })

      fireEvent.change(eventEditorPage.getQualifiersInput(), {
        target: { value: '2' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(eventToUpdateBody(onSave.mock.calls[0][0]).qualifiers_per_pool).toBe(2)
    })

    // The stale-value case, and the reason the mapper keys off the draw type rather than
    // off "is there a number in the box": switching away leaves K in form state (RHF does
    // not clear a field because its control unmounted), and the two count-less arms of the
    // server's draw-settings union are `extra="forbid"` — so a body that still carried it
    // would be a **422**, produced by a control the director can no longer even see.
    it('drops the count from the body when the director switches away from rr-then-ko', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildRrThenKoEvent({ qualifiersPerPool: 2 }),
        onSave,
      })

      await eventEditorPage.chooseDrawType('Round robin')
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      const body = eventToUpdateBody(onSave.mock.calls[0][0])
      expect(body.draw_type).toBe('round-robin')
      expect('qualifiers_per_pool' in body).toBe(false)
    })

    // Refused HERE, so nothing was sent — `onSave` not called at all is the assertion
    // that separates "told the director" from "asked the server and read the answer out".
    it.each([
      ['0', 'At least 1 player must advance from each pool.'],
      ['-1', 'At least 1 player must advance from each pool.'],
      ['', 'Say how many players advance from each pool.'],
    ])(
      'refuses %s inline and sends NOTHING',
      async (typed, message) => {
        const onSave = vi.fn()
        eventEditorPage.render({
          event: buildRrThenKoEvent({ qualifiersPerPool: 2 }),
          onSave,
        })

        fireEvent.change(eventEditorPage.getQualifiersInput(), {
          target: { value: typed },
        })
        await userEvent.click(eventEditorPage.getSaveButton())

        await waitFor(() =>
          expect(eventEditorPage.queryFieldError(message)).toBeInTheDocument(),
        )
        expect(onSave).not.toHaveBeenCalled()
      },
    )

    // The far half of the round trip (chores 3c/3d): what the SERVER stored is what the
    // control opens on. Without this the editor could show a default while the event ran
    // at a different K — the quiet failure the whole server-side detour was to prevent.
    it('opens on the count the server sent back', () => {
      eventEditorPage.render({ event: buildRrThenKoEvent({ qualifiersPerPool: 3 }) })

      expect(eventEditorPage.getQualifiersInput()).toHaveValue(3)
    })
  })

  /**
   * A rule with no value is not a rule. It used to go to the server anyway — where
   * a scalar one was ACCEPTED (201) and came back onto the event card as the chip
   * `Rating < ?`, a restriction on nobody wearing the clothes of a real one, while a
   * `between` with no bounds earned a 422 the editor threw away along with the
   * organizer's work.
   *
   * So: refused in the form. Nothing is sent — `onSave` is not called at all, which
   * is the assertion that separates "told the user" from "asked the server and
   * ignored the answer".
   */
  describe('a rule the server could not evaluate', () => {
    it('refuses a scalar rule with no value, and sends NOTHING', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({
          predicates: [buildPredicate({ op: '<', value: null })],
        }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getRuleErrorMessages()).toEqual(['Enter a rating.'])
      // …and it took the organizer to the rule that is wrong. A message on a tab
      // you cannot see is indistinguishable from a button that does nothing.
      expect(eventEditorPage.getSectionTab('Eligibility')).toHaveAttribute(
        'aria-selected',
        'true',
      )
    })

    // QA's data-loss repro, exactly: add a rule, set "is between", leave both
    // bounds empty, press Create event.
    it('refuses a between with both bounds empty', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({
          id: 'new-1',
          predicates: [buildPredicate({ op: 'between', value: [null, null] })],
        }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getRuleErrorMessages()).toEqual(['Enter a rating.'])
    })

    it('refuses INVERTED bounds — a rule no player can satisfy', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({
          predicates: [buildPredicate({ op: 'between', value: [1600, 1200] })],
        }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getRuleErrorMessages()).toEqual([
        'The upper bound must be at least the lower bound.',
      ])
    })

    it('refuses a rating that is not a rating', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({
          predicates: [buildPredicate({ op: '<', value: 999_999_999 })],
        }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getRuleErrorMessages()).toEqual([
        'Rating must be 0–3000.',
      ])
    })

    it('says nothing in red until the organizer actually tries to save', () => {
      // A value box they have not filled in yet is not yet wrong.
      eventEditorPage.render({
        event: buildEvent({
          predicates: [buildPredicate({ op: '<', value: null })],
        }),
      })
      expect(eventEditorPage.getRuleErrors()).toHaveLength(0)
    })

    it('clears the message the moment the rule is fixed, and then saves', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({
          predicates: [buildPredicate({ op: '<', value: null })],
        }),
        onSave,
      })
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(eventEditorPage.getRuleErrors()).toHaveLength(1)

      await userEvent.type(eventEditorPage.getValueInput(), '1500')

      expect(eventEditorPage.getRuleErrors()).toHaveLength(0)
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          predicates: [expect.objectContaining({ value: 1500 })],
        }),
      )
    })
  })

  /**
   * The fields the *server* can refuse — and which the form now refuses first (#783
   * QA, round two). The rules got a guard and the name did not, so an empty name and
   * a 256-character one both round-tripped to a 422 while an empty rule was caught in
   * the form. Same click, two different stories.
   *
   * As with the rules: nothing is sent (`onSave` is never called), the message is
   * under the field, and the organizer lands on the tab that holds it.
   */
  describe('a field the server would refuse', () => {
    it('refuses a BLANK name in the form, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent({ id: 'new-1', name: '' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getNameInput()).toHaveAttribute('aria-invalid', 'true')
      expect(eventEditorPage.queryFieldError('Name is required.')).toBeInTheDocument()
      // No banner: a banner is for a refusal that came back from somewhere. This one
      // never left the room.
      expect(eventEditorPage.queryFailure()).toBeNull()
    })

    it('refuses a name past 255 characters in the form, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', name: 'A'.repeat(256) }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(
        eventEditorPage.queryFieldError('Name must be 255 characters or fewer.'),
      ).toBeInTheDocument()
    })

    // ⚠️ The one field where a blank box is **not** an error. `Number('')` is `0`, and
    // the old control's coercion turned an emptied player limit into an event of zero
    // players — a 422 the form never caught. The fix is NOT to make the field required
    // (that would un-ship the uncapped event): a blank cap is `null`, which means *no
    // cap*, and it is a perfectly good thing to save (ADR-0935). What is refused is the
    // typed `0` — see 'rejects a zero player limit inline' below, and the two are
    // asserted separately precisely because one coercion used to collapse them.
    it('SAVES a cleared player limit as null — a blank cap is no cap, not an error', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', maxPlayers: 64 }),
        onSave,
      })

      await userEvent.clear(eventEditorPage.getPlayerLimitInput())
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      // `null`, never `0` and never `NaN` — the three are one keystroke apart and only
      // one of them means "no cap".
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ maxPlayers: null }),
      )
      // …and nothing was reported as wrong, because nothing is.
      expect(eventEditorPage.getPlayerLimitInput()).not.toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(eventEditorPage.queryFailure()).toBeNull()
    })

    it('refuses a player limit the server cannot STORE (the 500), and sends nothing', async () => {
      // `9999999999` satisfies every rule Pydantic states (`int`, `gt=0`) and then
      // detonates on the `Integer` column. The `<input max>` attribute steers a spinner
      // and stops nothing that is typed or pasted, so the bound has to be in the schema.
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      fireEvent.change(eventEditorPage.getPlayerLimitInput(), {
        target: { value: '9999999999' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(
          eventEditorPage.queryFieldError('The player limit must be 512 or fewer.'),
        ).toBeInTheDocument(),
      )
      expect(onSave).not.toHaveBeenCalled()
    })

    it('takes the organizer to BASICS, where the broken field is', async () => {
      // The rule builder's lesson, applied to the other tab: a message on a tab you
      // cannot see is indistinguishable from a button that does nothing. Start them
      // on Eligibility to prove the editor really moves them.
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1', name: '' }), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Eligibility'))
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(eventEditorPage.getSectionTab('Basics')).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(onSave).not.toHaveBeenCalled()
    })

    it('says nothing in red until the organizer actually tries to save', () => {
      eventEditorPage.render({ event: buildEvent({ id: 'new-1', name: '' }) })
      expect(eventEditorPage.queryFieldError('Name is required.')).toBeNull()
    })

    it('clears the message the moment the name is typed, and then saves', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent({ id: 'new-1', name: '' }), onSave })
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(eventEditorPage.queryFieldError('Name is required.')).toBeInTheDocument()

      await userEvent.type(eventEditorPage.getNameInput(), 'Open Singles')

      expect(eventEditorPage.queryFieldError('Name is required.')).toBeNull()
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Open Singles' }),
      )
    })
  })

  /**
   * The same lesson, one tab over — and the last field in this editor that could still
   * author a 422 (#786).
   *
   * The pools editor **mints** a pool's id and its default name ("Pool A"), so the happy
   * path could never make a blank one. But the name **box is live**, and an emptied box
   * was a save the form allowed and the server refused — with Pydantic's own prose
   * ("String should have at least 1 character") arriving in the editor's banner, naming
   * no field, in the wire's vocabulary. The API now states the floor (`Pool.name`,
   * `min_length=1`), and this is what means the organizer never meets it.
   *
   * ⚠️ The assertion that discriminates is **`onSave`**, not the red. A form that
   * rendered the message and fired the request anyway would sail through a test that
   * only looked for the message — and the 422 would come back and land in the banner
   * exactly as before. Nothing may be *sent*.
   */
  describe('a pool the server would refuse', () => {
    it('refuses a BLANK pool name in the form, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ pools: [buildPool({ name: 'Pool A' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      await userEvent.clear(eventEditorPage.getPoolNameInput())
      await userEvent.click(eventEditorPage.getSaveButton())

      // Nothing left the room — so the 422 that would have come back never existed.
      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getPoolNameInput()).toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(eventEditorPage.getPoolNameErrors()).toEqual(['Name is required.'])
      // And no banner: a banner reports a refusal that came back from somewhere.
      expect(eventEditorPage.queryFailure()).toBeNull()
    })

    // A space is not a name, and the server agrees — Pydantic's `min_length` counts the
    // characters it was *sent*, so a client that trimmed only on display would post
    // `" "` and be refused. The schema trims first, exactly as the event's name does.
    it('refuses a WHITESPACE-ONLY pool name, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ pools: [buildPool({ name: 'Pool A' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      await userEvent.clear(eventEditorPage.getPoolNameInput())
      await userEvent.type(eventEditorPage.getPoolNameInput(), '   ')
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getPoolNameErrors()).toEqual(['Name is required.'])
    })

    it('takes the organizer to TABLE POOLS, where the broken pool is', async () => {
      // A message on a tab you cannot see is indistinguishable from a button that does
      // nothing — the rule builder's lesson, and the name box's, applied to the fourth
      // tab. The editor opens on Basics, so this proves it really moves them.
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ pools: [buildPool({ name: '' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(eventEditorPage.getSectionTab('Table pools')).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(onSave).not.toHaveBeenCalled()
    })

    // Per ROW, not per section: the red belongs under the box that is empty. A section
    // that raised one error for the whole list would point a director with six pools at
    // all six.
    it('reds the pool that is blank, and leaves the one that is not alone', async () => {
      eventEditorPage.render({
        event: buildEvent({
          pools: [
            buildPool({ id: 'p-a', name: '' }),
            buildPool({ id: 'p-b', name: 'Pool B' }),
          ],
        }),
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(eventEditorPage.getPoolNameErrors()).toEqual(['Name is required.'])
      const [blank, named] = eventEditorPage.getPoolNameInputs()
      expect(blank).toHaveAttribute('aria-invalid', 'true')
      expect(named).not.toHaveAttribute('aria-invalid', 'true')
    })

    it('says nothing in red until the organizer actually tries to save', async () => {
      eventEditorPage.render({
        event: buildEvent({ pools: [buildPool({ name: 'Pool A' })] }),
      })

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      await userEvent.clear(eventEditorPage.getPoolNameInput())

      // A box they are halfway through re-typing is not yet wrong.
      expect(eventEditorPage.getPoolNameErrors()).toEqual([])
    })

    it('clears the message the moment the name is typed, and then saves', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ pools: [buildPool({ name: '' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())
      expect(eventEditorPage.getPoolNameErrors()).toEqual(['Name is required.'])

      await userEvent.type(eventEditorPage.getPoolNameInput(), 'Championship')

      await waitFor(() => expect(eventEditorPage.getPoolNameErrors()).toEqual([]))
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave.mock.calls.at(-1)?.[0].pools[0].name).toBe('Championship')
    })

    // The name is trimmed on the way out, so what is saved is the name that will be
    // read off a wall — and what is *counted* by the server's `min_length` is the same
    // string the client judged.
    it('saves the pool name trimmed', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ pools: [buildPool({ name: 'Pool A' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      await userEvent.clear(eventEditorPage.getPoolNameInput())
      await userEvent.type(eventEditorPage.getPoolNameInput(), '  Championship  ')
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave.mock.calls.at(-1)?.[0].pools[0].name).toBe('Championship')
    })
  })

  /**
   * THE data-loss half — and the half that matters most, because client validation
   * only ever prevents the refusals we already know about. Whatever the *next*
   * unknown 422 is, it must not silently eat somebody's work: the sheet stays open,
   * the draft stays in it, and the organizer is told.
   *
   * Told **in our words**. The banner used to print `ApiError.detail`, which for a
   * 422 is Pydantic's: *"String should have at most 255 characters"* — the wire's
   * vocabulary, a constraint rather than an instruction, and no clue which of eight
   * fields it is about. `DEFINITION_OF_COMPLETE.md`: *"Raw API detail strings never
   * reach the UI."*
   */
  describe('a save the server refuses', () => {
    const rejectWith = (error: unknown) => vi.fn().mockRejectedValue(error)

    /** FastAPI's real 422 body — a `detail` ARRAY of pydantic errors. The editor is
     * handed the whole `ApiError`, `body` included, because the `loc` in there is the
     * one thing it could not have guessed: which field. */
    const pydantic422 = (field: string, msg: string) =>
      new ApiError(422, msg, 'create event', {
        detail: [{ type: 'string_too_long', loc: ['body', field], msg }],
      })

    it('keeps the sheet OPEN, keeps the draft, and says what happened — in OUR words', async () => {
      const onSave = rejectWith(
        pydantic422('name', 'String should have at most 255 characters'),
      )
      const onOpenChange = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'new-1', name: 'Open Singles' }),
        onSave,
        onOpenChange,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      // NOT Pydantic's sentence…
      expect(eventEditorPage.queryFailure()).not.toHaveTextContent(
        'String should have at most',
      )
      // …but the field it named, in the words the form puts above that field.
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'The Event name was rejected. Check that field and try again.',
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'your changes are still here',
      )
      // Still open — and it is the EDITOR that has not closed, not merely a parent
      // that happens to have kept it mounted: nothing asked for it to close.
      expect(eventEditorPage.querySheet()).toBeInTheDocument()
      expect(onOpenChange).not.toHaveBeenCalled()
      // …and the work is still in it.
      expect(eventEditorPage.getNameInput()).toHaveValue('Open Singles')
    })

    it('words a 422 it cannot map to a field generically — still never pydantic’s', async () => {
      const onSave = rejectWith(
        pydantic422('seeding_policy', 'Input should be a valid string'),
      )
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        "Some of this event's details were rejected",
      )
      expect(eventEditorPage.queryFailure()).not.toHaveTextContent('Input should be')
    })

    it('says a 5xx is OUR fault — and never blames the organizer’s connection', async () => {
      // THE round-three regression, on this side of the pair: a 500 read out "The server
      // couldn't be reached. Check your connection and try again." The server WAS
      // reached — it answered, with a fault of ours — and that sentence sends the
      // organizer off to debug their wifi over it.
      const onSave = rejectWith(new ApiError(500, null, 'update event'))
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        "Couldn't save your changes",
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'Something went wrong on our end. Nothing you did caused it',
      )
      expect(eventEditorPage.queryFailure()).not.toHaveTextContent(
        /connection|couldn't be reached/,
      )
    })

    it('blames the connection only for a request that got NO answer', async () => {
      // The other designed state (`DEFINITION_OF_COMPLETE.md`: 5xx and network-down are
      // distinct). A rejected `fetch` is re-thrown by openapi-fetch, so it lands here as
      // a raw `TypeError` — never as an `ApiError` with a status to read.
      const onSave = rejectWith(new TypeError('Failed to fetch'))
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        "The server couldn't be reached. Check your connection and try again.",
      )
      // The work is still here either way — that is the contract, whatever went wrong.
      expect(eventEditorPage.getNameInput()).toHaveValue('Open Singles')
    })

    it('passes on a sentence the server wrote for a HUMAN (ADR-0968 fallback)', async () => {
      // A 403 is not a validator's complaint: its `detail` is prose we wrote, and it
      // is a refusal the client has no copy of its own for. Show it.
      const onSave = rejectWith(
        new ApiError(403, 'You can only modify tournaments you created.', 'update event', {
          detail: 'You can only modify tournaments you created.',
        }),
      )
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'You can only modify tournaments you created.',
      )
    })

    it('reports nothing when the save succeeds', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
      expect(eventEditorPage.queryFailure()).toBeNull()
    })

    // **The race.** The editor disables the add/remove-pool controls of an event whose
    // draw is cut (ADR-0786) — but "is the draw cut?" was answered when the page loaded.
    // A director with two tabs open, or a co-director across the hall, can cut one after
    // that, and this sheet's live-looking Add button becomes a change the server will
    // refuse. So the 409 has to land somewhere designed, and it does: the same inline
    // banner, with the SERVER's sentence, which is the only copy that knows which pool
    // went missing and that the way out is to delete the draw.
    //
    // That sentence survives *because* `saveFailure` classifies a 409 as `refused` (prose
    // the API wrote for a human) rather than as `invalid` (a validator's machine words,
    // which are never shown). This test is what stops a future tidy-up from collapsing
    // the two.
    it('surfaces a pool-set 409 with the server’s own sentence — the cut-draw race', async () => {
      const refusal =
        'This event’s draw is already cut, so its set of pools is frozen: “Pool B” ' +
        'already has fixtures drawn into it. A pool’s tables, its time and its name ' +
        'can all still be changed. To add, remove or re-identify a pool, remove the ' +
        'draw first, then cut it again.'
      const onSave = rejectWith(
        new ApiError(409, refusal, 'update event', { detail: refusal }),
      )
      const onOpenChange = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', pools: [buildPool()] }),
        onSave,
        onOpenChange,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(refusal)
      // Not swallowed, not a raw crash, and not a closed sheet over a discarded draft.
      expect(eventEditorPage.querySheet()).toBeInTheDocument()
      expect(onOpenChange).not.toHaveBeenCalled()
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'your changes are still here',
      )
    })
  })

  // The two freezes, wired end to end through the real sheet — the sections own the
  // controls, the editor owns the derivation, and this is the seam between them. Both
  // are read off the event's `fixtures`, which is not a form field: nothing on this
  // sheet can cut or delete a draw.
  describe('an event whose draw is cut', () => {
    const drawn = () =>
      buildEvent({
        id: 'ev-1',
        drawType: 'round-robin',
        pools: [buildPool()],
        fixtures: [buildFixture({ poolId: 'p-1' })],
      })

    it('freezes the draw type on Basics and the pool set on Table pools', async () => {
      eventEditorPage.render({ event: drawn() })

      // Basics is the tab it opens on.
      expect(
        screen.getByRole('combobox', { name: 'Draw type' }),
      ).toBeDisabled()
      // …while the format beside it — which no fixture depends on — stays live.
      expect(screen.getByRole('combobox', { name: 'Format' })).toBeEnabled()

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      expect(screen.getByRole('button', { name: 'Add pool' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Remove pool' })).toBeDisabled()
      expect(screen.getByTestId('pools-frozen-notice')).toHaveTextContent(
        'Delete the draw',
      )
      // The venue attributes the freeze exists to protect are still editable.
      expect(screen.getByLabelText('Pool name')).toBeEnabled()
      expect(screen.getByRole('button', { name: 'T1' })).toBeEnabled()
    })

    it('freezes nothing when no draw is cut', async () => {
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', pools: [buildPool()] }),
      })

      expect(screen.getByRole('combobox', { name: 'Draw type' })).toBeEnabled()

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      expect(screen.getByRole('button', { name: 'Add pool' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Remove pool' })).toBeEnabled()
      expect(screen.queryByTestId('pools-frozen-notice')).toBeNull()
    })
  })

  it('offers delete only for an existing event', () => {
    eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }) })
    expect(eventEditorPage.queryDeleteButton()).toBeInTheDocument()
    expect(eventEditorPage.getSaveButton()).toHaveTextContent('Save changes')
  })

  it('labels a new event and hides delete', () => {
    eventEditorPage.render({ event: buildEvent({ id: 'new-123' }) })
    expect(eventEditorPage.queryDeleteButton()).toBeNull()
    expect(eventEditorPage.getSaveButton()).toHaveTextContent('Create event')
  })

  it('switches sections via the tabs', async () => {
    eventEditorPage.render({ event: buildEvent() })
    await userEvent.click(eventEditorPage.getSectionTab('Match settings'))
    expect(screen.getByRole('switch', { name: 'Rated' })).toBeInTheDocument()
  })

  it('hides save and delete for a non-creator (read-only view)', () => {
    eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), canEdit: false })
    expect(eventEditorPage.querySaveButton()).toBeNull()
    expect(eventEditorPage.queryDeleteButton()).toBeNull()
    expect(eventEditorPage.getDismissButton()).toHaveTextContent('Done')
  })

  // #933 / #934: a client-side rejection must surface inline and keep the panel
  // open with the typed values intact — never close over a silent discard.
  describe('validation keeps the panel open', () => {
    it('rejects an over-long name inline without saving or closing', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      const onOpenChange = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'new-1', name: '' }),
        onSave,
        onOpenChange,
      })

      fireEvent.change(eventEditorPage.getNameInput(), {
        target: { value: OVER_LONG_NAME },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(
          eventEditorPage.queryError(/255 characters or fewer/),
        ).toBeInTheDocument(),
      )
      expect(onSave).not.toHaveBeenCalled()
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      // The typed value is retained, not discarded.
      expect(eventEditorPage.getNameInput()).toHaveValue(OVER_LONG_NAME)
    })

    it('rejects a zero player limit inline', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent(), onSave })

      fireEvent.change(eventEditorPage.getPlayerLimitInput(), {
        target: { value: '0' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(
          eventEditorPage.queryError(/at least 1, or blank for no cap/),
        ).toBeInTheDocument(),
      )
      expect(onSave).not.toHaveBeenCalled()
    })

    it('submits a blank player limit as null (no cap)', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent({ maxPlayers: 64 }), onSave })

      fireEvent.change(eventEditorPage.getPlayerLimitInput(), {
        target: { value: '' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ maxPlayers: null }),
      )
    })

    it('requires an entry fee but accepts a zero fee (free event)', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent({ entryFee: 45 }), onSave })

      // Blank → required error, no save.
      fireEvent.change(eventEditorPage.getEntryFeeInput(), {
        target: { value: '' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() =>
        expect(
          eventEditorPage.queryError(/Entry fee is required/),
        ).toBeInTheDocument(),
      )
      expect(onSave).not.toHaveBeenCalled()

      // A typed 0 is a legitimate free event — it saves.
      fireEvent.change(eventEditorPage.getEntryFeeInput(), {
        target: { value: '0' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ entryFee: 0 }),
      )
    })

    // The two silent-discard fixes met here, and the banner won: a 422's `detail` is a
    // string we do not control (Pydantic's, when it is not one of ours), and
    // DEFINITION_OF_COMPLETE forbids it reaching the UI. So the panel stays open — the
    // protection both fixes were for — but the copy is the classifier's, not the wire's.
    it('surfaces a server 422 and keeps the panel open — in OUR words, not the wire’s', async () => {
      const onSave = vi
        .fn()
        .mockRejectedValue(
          new ApiError(422, 'That name is already taken.', 'save event'),
        )
      const onOpenChange = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ name: 'Open Singles' }),
        onSave,
        onOpenChange,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        "Some of this event's details were rejected",
      )
      expect(eventEditorPage.queryFailure()).not.toHaveTextContent(
        'That name is already taken.',
      )
      // Rejected: the panel did not close, and the work is still in it.
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      expect(eventEditorPage.getNameInput()).toHaveValue('Open Singles')
    })
  })

  // The overline names what the panel *is*. "Edit event" is addressed to the
  // person in control (ADR 0015, rule 5) — a viewer is being shown an event, not
  // invited to edit one. Both sides are asserted, so the editor's own labels
  // cannot be deleted to satisfy the viewer's.
  describe('the header overline', () => {
    it('says "Edit event" to the creator of an existing event', () => {
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }) })
      expect(eventEditorPage.getOverline()).toHaveTextContent('Edit event')
    })

    it('says "New event" to the creator of a new one', () => {
      eventEditorPage.render({ event: buildEvent({ id: 'new-123' }) })
      expect(eventEditorPage.getOverline()).toHaveTextContent('New event')
    })

    it('says just "Event" to a non-creator', () => {
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1' }),
        canEdit: false,
      })
      // Exact: "Edit event" would satisfy a substring match on "event".
      expect(eventEditorPage.getOverline()).toHaveTextContent(/^Event$/)
      expect(eventEditorPage.getOverline()).not.toHaveTextContent(/Edit/)
    })
  })

  // The nested-array sub-forms (Eligibility, Table pools) drive the one
  // React-Hook-Form via `useFieldArray` (chore 1e), so add / edit / remove is
  // form state that rides out on Save with the rest of the event — proved here
  // end to end through `onSave`, not just in form state.
  describe('the nested-array sub-forms persist on save', () => {
    const savePayload = (onSave: ReturnType<typeof vi.fn>) =>
      onSave.mock.calls.at(-1)?.[0]

    it('carries an added eligibility rule into the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ predicates: [] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Eligibility'))
      // Both the header "Add rule" and the empty-state "Add a rule" are present;
      // the exact name pins the header action.
      await userEvent.click(screen.getByRole('button', { name: 'Add rule' }))
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(savePayload(onSave).predicates).toHaveLength(1)
    })

    it('carries an added table pool into the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent({ pools: [] }), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      // Both the header "Add pool" and the empty-state "Add first pool" are
      // present; the exact name pins the header action.
      await userEvent.click(screen.getByRole('button', { name: 'Add pool' }))
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(savePayload(onSave).pools).toHaveLength(1)
    })

    it('drops a removed table pool from the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      // The seeded event carries one pool; removing it must save an empty list.
      eventEditorPage.render({ event: buildEvent(), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      await userEvent.click(screen.getByRole('button', { name: 'Remove pool' }))
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(savePayload(onSave).pools).toHaveLength(0)
    })

    // A multi-character edit is the discriminating case for the `useFieldArray`
    // wiring: an in-place `update` that remounted the row would drop focus after
    // the first keystroke, and only the first character would land. Keying the
    // row on the stable domain id keeps it mounted, so the whole name persists.
    it('carries a multi-character pool rename into the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ pools: [buildPool({ name: 'Pool A' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      const nameInput = screen.getByLabelText('Pool name')
      await userEvent.clear(nameInput)
      await userEvent.type(nameInput, 'Championship')
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(savePayload(onSave).pools[0].name).toBe('Championship')
    })
  })

  /**
   * The event timezone anchors its wall-clock windows to real instants (ADR
   * 20260719). A new event pre-fills the picker from the browser's resolved zone; the
   * director can change it via the searchable picker; and it rides the saved payload.
   */
  describe('the event timezone (ADR 20260719)', () => {
    afterEach(() => vi.restoreAllMocks())

    /** Point the browser's resolved zone at `zone` for one test — the only way to
     * prove the default *follows the browser* is to move the browser. */
    function stubBrowserZone(zone: string) {
      const real = Intl.DateTimeFormat
      vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
        (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
          const fmt = new real(...args)
          const opts = fmt.resolvedOptions()
          vi.spyOn(fmt, 'resolvedOptions').mockReturnValue({
            ...opts,
            timeZone: zone,
          })
          return fmt
        },
      )
    }

    it("pre-fills a new event's picker and window label from the browser zone", () => {
      stubBrowserZone('Pacific/Auckland')
      eventEditorPage.render({ event: emptyEvent(buildTournament()) })

      expect(
        screen.getByRole('combobox', { name: 'Timezone' }),
      ).toHaveTextContent('Pacific/Auckland')
      expect(screen.getByTestId('event-timezone-label')).toHaveTextContent(
        'Pacific/Auckland',
      )
    })

    it('carries a picked timezone into the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({
          id: 'new-1',
          name: 'Open Singles',
          timezone: 'America/Chicago',
        }),
        onSave,
      })

      await userEvent.click(screen.getByRole('combobox', { name: 'Timezone' }))
      await userEvent.type(
        await screen.findByPlaceholderText('Search timezones…'),
        'Denver',
      )
      await userEvent.click(
        await screen.findByRole('option', { name: 'America/Denver' }),
      )
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: 'America/Denver' }),
      )
    })
  })
})
