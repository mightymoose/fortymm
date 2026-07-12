import type { Page, Route } from '@playwright/test'

import type { components } from '../../../src/api/schema'
import { PERM } from '../../../src/lib/permissions'
import {
  buildTournamentDetailRead,
  buildTournamentEventRead,
  buildTournamentEntrantRead,
  entryStateFor,
} from '../../../src/mocks/factories/tournaments/tournament.factory'
import { sessionResponse } from '../../../src/test/factories'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type TournamentEventRead = components['schemas']['TournamentEventRead']
type TournamentEntrantRead = components['schemas']['TournamentEntrantRead']
/** The wire's status enum — the specs drive the store with it, so it is the
 * generated schema's, not a re-typed union of four strings. */
export type TournamentStatus = TournamentDetailRead['status']
type UnreadCountResponse = components['schemas']['UnreadCountResponse']

/** Every status a tournament can be in, in lifecycle order — so a spec that
 * sweeps "each of the four" cannot quietly sweep three. This is the sweep for an
 * OWNER, who can reach all four of their own. */
export const STATUSES: readonly TournamentStatus[] = [
  'draft',
  'published',
  'live',
  'archived',
]

/** The statuses in which a tournament has been ANNOUNCED — the only statuses a
 * NON-OWNER can ever have on screen: a draft is owner-only to read, so a stranger's
 * GET of one is a 404 and the detail page never renders at all.
 *
 * The viewer sweeps run over this list rather than over `STATUSES`, because a
 * viewer + `draft` fixture would be a world the server cannot produce — the spec
 * would be stubbing a response the API refuses to give, and asserting the UI is
 * well-behaved in a state it can never be in.
 *
 * Re-exported from the mock store, NOT re-typed here: there it is derived from the
 * exhaustiveness-checked `Record<TournamentStatus, boolean>` that mirrors the API's
 * `ANNOUNCED_STATUSES` (#967), so a new status is a compile error at the source
 * instead of a sweep that silently shrinks. (The store imports only types, so
 * pulling it into the Playwright process is inert — no MSW comes with it.) */
export { ANNOUNCED_STATUSES } from '../../../src/mocks/tournaments-store'

/** The app shell's notification bell polls this on every page, tournaments
 * included. It is nothing to do with entries — but with MSW off, an unanswered
 * call falls through to the vite dev server, so the shell around the feature has
 * to be fed too. */
const UNREAD_COUNT: UnreadCountResponse = { unread_count: 0 }

/**
 * A **stateful** network stub for the tournament-entries journey, installed as
 * Playwright `page.route` interceptors (this suite runs with MSW OFF).
 *
 * Stateful is not a nicety here, it is the whole requirement: the journey is
 * enter → withdraw → **re-enter**, and each step's assertion is about what the
 * *next* read returns. A static fixture cannot express "the roster now contains
 * me and the count went up", so a spec built on one would assert the fixture,
 * not the app.
 *
 * It is a **per-test instance**, never a module singleton: the suite runs
 * `fullyParallel`, and a shared store would let one test's entry leak into
 * another's "am I entered?" join.
 *
 * The wire shapes come from the same generated-schema-typed factories the MSW
 * mocks use, so a change to the OpenAPI contract reds this file at review time
 * rather than passing a stale shape into a green spec.
 */

export const TOURNAMENT_ID = 'bay-area-open-2026'

/** The events the specs drive, named so the specs never hard-code strings that
 * must agree with the seed below. */
export const EVENT = {
  /** Singles, 2 existing entrants, 64 slots — the enter/withdraw/re-enter one. */
  JOURNEY: 'Open Singles',
  /** Singles, nobody entered — the designed *empty* roster state. */
  EMPTY: 'U1500 Singles',
  /** Doubles — the *entry-closed* roster state, and no Enter control at all. */
  DOUBLES: 'Mixed Doubles',
  /** Singles with more entrants than a card lists — the *truncated* roster.
   * Opt-in (`crowded: true`), so the default seed's counts stay the ones the
   * other specs narrate. */
  CROWDED: 'Veterans Singles',
  /** Singles, FULL of strangers (`gated: true`) — the event that explains itself
   * instead of offering an Enter that could only 409 (#783). */
  FULL: 'Masters Singles',
  /** Singles, full **including me** (`gated: true` + `enteredIn`) — the trap: an
   * entrant in a full event must still be able to WITHDRAW. */
  FULL_WITH_ME: 'Legends Singles',
  /** Singles whose one rating rule refuses me (`gated: true`) — the other event
   * that explains itself rather than offering a doomed button (#783). */
  INELIGIBLE: 'U1200 Singles',
  /** Singles in which **every** entrant is unrated (`unrated: true`) — a brand-new
   * club's first beginners' event, where nobody has finished a rated match yet. The
   * degenerate roster: every chip marked, and the list must still render (ADR-0783
   * §3). */
  ALL_UNRATED: 'Beginners Singles',
} as const

/** How many people are already in the crowded event before I enter it. Comfortably
 * past the card's 8-chip cut-off, so my own entry — appended LAST, the server lists
 * entrants oldest-entry-first — is truncated away unless the roster pins it (#781). */
const CROWD_SIZE = 12

/** The cap on the two full events. Small on purpose: "full" is `entrants.length >=
 * max_players`, and a four-seat event reaches it with a roster a human can still
 * read in a failure screenshot. */
const SMALL_CAP = 4

/** The rule the `INELIGIBLE` event is gated on, and the rating the server judged me
 * on. The client reads the rule back out of the event's own `predicates` by id, so
 * the two must be the same object — a refusal pointing at a rule the event does not
 * carry is a payload the server cannot send. */
const U1200_RULE = { id: 'pr-u1200', field: 'rating', op: '<', value: 1200 } as const

/** The rating the server judged me on — a **raw Glicko float**, because that is what
 * the server actually puts on the wire (`entry_state.rating`), thirteen decimals and
 * all. The card must print it as `1662`, like every other rating surface in the app.
 *
 * It was `1650` here, and that round number is precisely why the bug shipped: with
 * it, the rounded and unrounded renderings are the same string, so no assertion
 * anywhere — vitest or browser — could tell them apart. */
const MY_RATING = 1662.3108939062977

/** Rounded, as the UI prints it. The specs assert against THIS. */
export const MY_RATING_ROUNDED = 1662

/** `tournament_events.name` is `VARCHAR(255)` server-side, and a longer one is a
 * **422** — the other refusal QA watched the editor swallow (the sheet closed, the
 * event was never created, and the organizer's typing went with it). Mirrored here
 * so a browser spec can watch that 422 arrive and see the editor hold its ground. */
const EVENT_NAME_MAX = 255

/** The rule on the all-unrated event (`unrated: true`). The same cap as `U1200_RULE`
 * — but its entrants hold no rating at all, so every one of them *passed* it, while
 * it refuses me at 1650. That is the ADR-0783 §3 bargain in a single card, and it is
 * why the mark on those three chips is the only thing standing between the director
 * and an invisible loophole. */
const BEGINNERS_RULE = {
  id: 'pr-beg',
  field: 'rating',
  op: '<',
  value: 1200,
} as const

/**
 * ⚠️ The join key. The session payload carries a username and **no user id**, so
 * "am I entered?" is decided by matching an entrant's `username` against the
 * session's. The username the store stamps on an entry it mints MUST therefore
 * be the same one the session reports — otherwise the player enters, the roster
 * gains a stranger, Withdraw never appears, and the spec looks like an app bug.
 * One constant, used for both.
 */
export const ME = { username: 'rita.kovac', userId: 'u-me' } as const

/** Entrants that are *not* me — so the journey event starts with a real count to
 * increment, and the roster has something to show before I join it.
 *
 * **`player.2` is UNRATED** (`rating: null` — they hold no rating on the
 * tournament's ladder, ADR-0783 §3), which makes the default seed's roster a
 * *mixed* one. That is deliberate: the mark is the mitigation for a rating cap
 * being opt-out, and a mark that only ever appeared under an opt-in flag would be
 * scanned by no spec that did not go looking for it — including the axe pass over
 * the ordinary events tab. */
const OTHERS: TournamentEntrantRead[] = [
  buildTournamentEntrantRead({ id: 'entry-1', user_id: 'u-1', username: 'player.1' }),
  buildTournamentEntrantRead({
    id: 'entry-2',
    user_id: 'u-2',
    username: 'player.2',
    rating: null,
  }),
]

/** A crowd of strangers, `player.1` … `player.N`, in entry order — the roster a
 * late entrant lands behind. Rated, unless `overrides` say otherwise (which is how
 * the all-unrated event is built). */
function crowd(
  size: number,
  overrides: Partial<TournamentEntrantRead> = {},
): TournamentEntrantRead[] {
  return Array.from({ length: size }, (_, i) =>
    buildTournamentEntrantRead({
      id: `entry-crowd-${i + 1}`,
      user_id: `u-crowd-${i + 1}`,
      username: `player.${i + 1}`,
      ...overrides,
    }),
  )
}

/** All three roster states (`listed` / `empty` / `entry-closed`) on one page, on
 * purpose: it is the real shape of an Events tab, and it lets one axe scan cover
 * every state the roster can be in.
 *
 * The fourth — a roster *longer than the card lists* — is opt-in (`crowded`),
 * because its dozen entrants would move the tournament-level Entries total that
 * the journey spec asserts on. */
function seed(options: TournamentsStoreOptions): TournamentDetailRead {
  const crowded = options.crowded ?? false
  return buildTournamentDetailRead({
    id: TOURNAMENT_ID,
    status: options.status ?? 'published',
    can_edit: options.canEdit ?? true,
    events: [
      buildTournamentEventRead({
        id: 'ev-open-singles',
        name: EVENT.JOURNEY,
        format: 'singles',
        max_players: 64,
        entrants: OTHERS,
      }),
      buildTournamentEventRead({
        id: 'ev-u1500',
        name: EVENT.EMPTY,
        format: 'singles',
        max_players: 48,
        entrants: [],
        pools: [],
      }),
      buildTournamentEventRead({
        id: 'ev-mixed-doubles',
        name: EVENT.DOUBLES,
        format: 'doubles',
        max_players: 32,
        entrants: [],
        pools: [],
      }),
      ...(crowded
        ? [
            buildTournamentEventRead({
              id: 'ev-veterans',
              name: EVENT.CROWDED,
              format: 'singles',
              max_players: 64,
              entrants: crowd(CROWD_SIZE),
              pools: [],
            }),
          ]
        : []),
      ...(options.unrated ?? false
        ? [
            buildTournamentEventRead({
              id: 'ev-beginners',
              name: EVENT.ALL_UNRATED,
              format: 'singles',
              max_players: 32,
              // Every one of them holds no rating on the tournament's ladder — so
              // every one of them PASSED this event's `rating < 1200` rule, which is
              // exactly the opt-out ADR-0783 accepts and this roster exists to
              // expose. Meanwhile the same rule refuses *me*, at a rating of 1650:
              // the whole decision, on one card. Three players the rules could not
              // judge are in; the one player they could judge is out.
              entrants: crowd(3, { rating: null }),
              predicates: [{ ...BEGINNERS_RULE }],
              entry_state: {
                state: 'rating_ineligible',
                predicate_id: BEGINNERS_RULE.id,
                rating: MY_RATING,
              },
              pools: [],
            }),
          ]
        : []),
      ...(options.gated ?? false ? gatedEvents() : []),
    ],
  })
}

/** The two events the *event itself* refuses the caller from (#783) — full, and
 * rating-ineligible. Opt-in (`gated: true`) for the same reason `crowded` is: their
 * entrants would move the tournament-level Entries total the journey spec narrates.
 *
 * `entry_state` on the full pair is **derived** by the factory from the entrants
 * (and re-derived on every read — see `read`), so entering or withdrawing really
 * does flip it; the ineligible one is stated, because no mock payload carries a
 * rating ladder to judge it from. */
function gatedEvents(): TournamentEventRead[] {
  return [
    buildTournamentEventRead({
      id: 'ev-masters',
      name: EVENT.FULL,
      format: 'singles',
      max_players: SMALL_CAP,
      entrants: crowd(SMALL_CAP),
      pools: [],
    }),
    buildTournamentEventRead({
      id: 'ev-legends',
      name: EVENT.FULL_WITH_ME,
      format: 'singles',
      max_players: SMALL_CAP,
      // One seat short of full — the spec fills it with ME (`enteredIn`), which is
      // the only honest way to reach "an entrant inside a FULL event".
      entrants: crowd(SMALL_CAP - 1),
      pools: [],
    }),
    buildTournamentEventRead({
      id: 'ev-u1200',
      name: EVENT.INELIGIBLE,
      format: 'singles',
      max_players: 24,
      entrants: crowd(2),
      predicates: [{ ...U1200_RULE }],
      entry_state: {
        state: 'rating_ineligible',
        predicate_id: U1200_RULE.id,
        rating: MY_RATING,
      },
      pools: [],
    }),
  ]
}

export interface TournamentsStoreOptions {
  /** The signed-in player's permissions. Defaults to a beta tester (can enter).
   * Pass `[PERM.TOURNAMENT_VIEW]` for the "no Enter control" case. */
  permissions?: string[]
  /** Add `EVENT.CROWDED` — a singles event already holding more entrants than a
   * card can list, so entering it puts me past the truncation cut-off. */
  crowded?: boolean
  /** Add the three events the *event itself* gates (#783): `EVENT.FULL`,
   * `EVENT.FULL_WITH_ME` and `EVENT.INELIGIBLE`. Opt-in, so their entrants stay out
   * of the counts the journey spec narrates. */
  gated?: boolean
  /** Add `EVENT.ALL_UNRATED` — a capped event whose entrants are *every one* of
   * them unrated (ADR-0783 §3). Opt-in for the same reason `crowded` is: its
   * entrants would move the tournament-level Entries total. (The *mixed* roster
   * needs no flag — `player.2` of the default seed is unrated.) */
  unrated?: boolean
  /** The status the tournament is in when the page loads. Defaults to
   * `published` — the one status whose registration window is OPEN, and the one
   * every enter/withdraw spec is written against (ADR-0017). */
  status?: TournamentStatus
  /** Does the signed-in player own it? Defaults to `true` (the owner, who is
   * offered the lifecycle buttons). `false` is the viewer: same page, no
   * transitions — the server 403s them, so the UI must not offer them. */
  canEdit?: boolean
  /** Events ME is already entered in when the page loads — by event name. The
   * only way to reach "an entered player on a *live* tournament", since entering
   * one through the UI is (rightly) refused. */
  enteredIn?: string[]
}

/**
 * The lifecycle's edge table, mirroring the server's `LEGAL_TRANSITIONS`
 * (`api/app/tournaments.py`, ADR-0017): the three forward edges are the whole
 * rule, and **every other (from, to) pair is a 409** — backwards, skipping a
 * stage, out of the terminal `archived`, and re-asserting the status a
 * tournament already holds.
 *
 * It is written out as pairs rather than derived from the client's own
 * `LIFECYCLE_EDGE`: a stub that imported the app's table could never disagree
 * with it, so a spec built on one would prove the app consistent with itself
 * instead of consistent with the server.
 */
const LEGAL_TRANSITIONS: ReadonlyArray<readonly [TournamentStatus, TournamentStatus]> =
  [
    ['draft', 'published'],
    ['published', 'live'],
    ['live', 'archived'],
  ]

/** Why registration is refused, in the API's exact words
 * (`_registration_closed_detail`). `published` is absent because it is the one
 * status that refuses nothing. */
const REGISTRATION_CLOSED_DETAIL: Record<
  Exclude<TournamentStatus, 'published'>,
  string
> = {
  draft:
    'This tournament has not been published yet, so its events are not open for entry.',
  live: 'This tournament is already under way, so its entries are locked.',
  archived: 'This tournament has ended, so its events can no longer be entered.',
}

interface RecordedRequest {
  method: string
  path: string
}

export class TournamentsStore {
  private detail: TournamentDetailRead
  private entryCounter = 0
  private gate: Promise<void> | null = null
  private refusingWrites = false
  private refusingTournamentCreate = false
  private faultingWrites = false
  private faultingTournamentCreate = false

  /** Every intercepted request, for tallies like "exactly one POST landed". */
  readonly requests: RecordedRequest[] = []
  /** Requests this store has no route for. A spec asserts this stays empty — an
   * unmocked call would otherwise fall through to a 404 and be read as an app
   * bug (or, without the catch-all, get `index.html` back from vite). */
  readonly unhandled: RecordedRequest[] = []

  constructor(private readonly options: TournamentsStoreOptions = {}) {
    this.detail = seed(options)
    // Seeded entries bypass the status gate on purpose: they are entries the
    // player made while the window was open, and the tournament has moved on
    // since. That is the only way a `live` tournament can hold an entrant of
    // mine — which is exactly the state the "locked, not Withdraw" case is about.
    for (const name of options.enteredIn ?? []) {
      this.addEntry(this.eventNamed(name).id)
    }
  }

  /** The tournament's status as the *server* now holds it — for asserting the
   * walk really moved it, rather than that the badge changed. */
  get status(): TournamentStatus {
    return this.detail.status
  }

  private eventNamed(eventName: string): TournamentEventRead {
    const event = this.detail.events.find((e) => e.name === eventName)
    if (!event) throw new Error(`no such event in the seed: ${eventName}`)
    return event
  }

  /** The event as the *server* would report it: the `entered` count derived from
   * the live entrants, never stored (ADR-0016). A stub that carried its own
   * counter could drift from its own roster and hide exactly the bug the derived
   * count exists to prevent.
   *
   * `entry_state`'s **capacity** arm is re-derived here for exactly the same reason
   * (ADR-0783 §4): entering the last free place must make the event report itself
   * `event_full` on the very next read, and withdrawing must free it again. A tag
   * frozen at seed time would let a stub keep saying `open` while its roster was at
   * `max_players` — precisely the state the card is supposed to explain.
   *
   * A **stated** `rating_ineligible` survives untouched: it is a fact about the
   * caller's rating, not about the roster, and nothing on the wire can derive it. */
  private read(event: TournamentEventRead): TournamentEventRead {
    const entry_state =
      event.entry_state.state === 'rating_ineligible'
        ? event.entry_state
        : entryStateFor(event)
    return { ...event, entered: event.entrants.length, entry_state }
  }

  private readDetail(): TournamentDetailRead {
    return { ...this.detail, events: this.detail.events.map((e) => this.read(e)) }
  }

  /** The active entrants of an event, by event name — for assertions that want
   * the server's view rather than the DOM's. */
  entrantsOf(eventName: string): TournamentEntrantRead[] {
    return this.detail.events.find((e) => e.name === eventName)?.entrants ?? []
  }

  /**
   * Enter **me** into an event *behind this page's back* — the second tab of the
   * two-tab race (#943). No request is recorded, because none came from the page
   * under test: from its point of view the server simply moved on without it, and
   * whatever it is currently rendering is now stale.
   *
   * The next thing that page does with this event (clicking the Enter button it
   * still shows) is therefore a duplicate entry, which the server refuses with a
   * 409 — exactly as `enter()` below does.
   */
  enterElsewhere(eventName: string): TournamentEntrantRead {
    return this.addEntry(this.eventNamed(eventName).id)
  }

  /**
   * Move the tournament along its lifecycle *behind this page's back* — the
   * director's other tab, or their phone (#780). No request is recorded: nothing
   * the page under test did caused it, and from its point of view the world has
   * simply moved on without it.
   *
   * The button it is still showing therefore names an edge that no longer exists,
   * and clicking it is a request the server refuses with a **409** — the stale-view
   * case that `POST …/transitions` reconciles from.
   */
  transitionElsewhere(to: TournamentStatus) {
    this.detail = { ...this.detail, status: to }
  }

  /** Mint one active entry for ME on an event. A fresh entry id each time — as on
   * the server, where re-entry after a withdrawal INSERTs a new row rather than
   * resurrecting the tombstoned one. The withdraw address therefore changes, and
   * a client that cached the old entry id would 404 on the second withdrawal. */
  private addEntry(eventId: string): TournamentEntrantRead {
    this.entryCounter += 1
    const entrant = buildTournamentEntrantRead({
      id: `entry-me-${this.entryCounter}`,
      user_id: ME.userId,
      username: ME.username,
      // I am RATED — the same 1650 the ineligible event judged me on. So my own
      // chip is never the unrated one, and a spec asserting "the unrated mark is on
      // player.2" cannot pass by landing on me instead.
      rating: MY_RATING,
    })
    this.mutateEvent(eventId, (e) => ({ ...e, entrants: [...e.entrants, entrant] }))
    return entrant
  }

  countOf(method: string): number {
    return this.requests.filter((r) => r.method === method).length
  }

  /**
   * Refuse every event write with FastAPI's **422** until the returned callback is
   * invoked — the *unknown* refusal, which is the only kind left worth testing.
   *
   * The editor now mirrors every constraint the server actually has on an event
   * (`data/event-validation`), so no draft a spec can author through the UI reaches
   * the wire and comes back 422 — an over-long name is refused in the form now, which
   * is the whole point of #783's second QA pass and which took away this suite's only
   * way of *provoking* a server refusal. That must not quietly delete the assertion
   * underneath it: client validation only ever prevents the refusals we already know
   * about, and the editor's contract is that **the next unknown one does not eat
   * somebody's work** — and does not read Pydantic's prose out to them.
   *
   * So the refusal is forced rather than provoked, and it answers in FastAPI's own
   * body shape (a `detail` ARRAY of `{loc, msg}`): whatever the server's next
   * constraint turns out to be, that is the shape it will arrive in.
   */
  refuseEventWrites(): () => void {
    this.refusingWrites = true
    return () => {
      this.refusingWrites = false
    }
  }

  /**
   * The same forced 422, for `POST /v1/tournaments` — the "New tournament" dialog's
   * one write, and for the same reason: the dialog mirrors every constraint the
   * server has on what it sends (a name is `VARCHAR(255)` and `NOT NULL`), so the
   * only 422 left to test is the *unknown* one, and it cannot be provoked through
   * the form. It is the residual case the dialog exists to survive — and the case it
   * used to answer by printing Pydantic's sentence onto the name field.
   */
  refuseTournamentCreate(): () => void {
    this.refusingTournamentCreate = true
    return () => {
      this.refusingTournamentCreate = false
    }
  }

  /**
   * Answer every event write with a **500** — a fault of the SERVER's, not a refusal of
   * the request (#783 QA, round three).
   *
   * It is a separate switch from `refuseEventWrites` (the 422) because they are separate
   * *states*, and the editor got them wrong by treating them as one: a 5xx used to be
   * classified `unreachable` and read out as "the server couldn't be reached — check
   * your connection", which is false twice over (the server was reached; their
   * connection is fine) and sends an organizer to go and restart their router over our
   * crash. `DEFINITION_OF_COMPLETE.md` lists 5xx and network-down as distinct designed
   * states, so the suite has to be able to produce each of them.
   *
   * The body is FastAPI's real one for an unhandled exception — a plain `detail` string,
   * which is machinery, and which must therefore appear nowhere on screen either.
   */
  faultEventWrites(): () => void {
    this.faultingWrites = true
    return () => {
      this.faultingWrites = false
    }
  }

  /**
   * The same 500, for `POST /v1/tournaments` — the failure QA injected and got **nothing
   * at all** back from: no inline error, no toast, no alert. The dialog's 5xx branch was
   * never wired to the classifier, so the Create button went back to idle and the app
   * silently did not create a tournament.
   */
  faultTournamentCreate(): () => void {
    this.faultingTournamentCreate = true
    return () => {
      this.faultingTournamentCreate = false
    }
  }

  /**
   * Hold every *mutating* response open until the returned callback is invoked —
   * so a spec can look at the UI mid-flight (e.g. "Enter is disabled while the
   * entry is in the air", which is the double-submit guard). Reads keep flowing,
   * so the page still renders.
   */
  holdWrites(): () => void {
    let release!: () => void
    this.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return () => {
      release()
      this.gate = null
    }
  }

  async install(page: Page) {
    // The client resolves its base URL to `${origin}/api`, so this one glob
    // catches everything the app asks for — session included. Anything NOT
    // routed here would be served `index.html` by the vite dev server and blow
    // up as a JSON parse error somewhere far from its cause.
    await page.route('**/api/v1/**', (route) => this.handle(route))
  }

  private session() {
    return sessionResponse({
      user: {
        username: ME.username,
        permissions: this.options.permissions ?? [
          PERM.TOURNAMENT_VIEW,
          PERM.TOURNAMENT_ENTER,
        ],
      },
    })
  }

  private async handle(route: Route) {
    const request = route.request()
    const method = request.method()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    this.requests.push({ method, path })

    if (path === '/v1/session') {
      return json(route, 200, this.session())
    }
    if (path === '/v1/notifications/unread-count') {
      return json(route, 200, UNREAD_COUNT)
    }

    // Writes wait on the gate (reads never do) — see `holdWrites`.
    if (method !== 'GET' && this.gate) await this.gate

    if (method === 'GET' && path === '/v1/tournaments') {
      return json(route, 200, [this.readDetail()])
    }
    if (method === 'GET' && path === `/v1/tournaments/${TOURNAMENT_ID}`) {
      return json(route, 200, this.readDetail())
    }

    // The list page's one write: `POST /v1/tournaments`, the "New tournament" dialog.
    if (method === 'POST' && path === '/v1/tournaments') {
      return this.createTournament(route, request.postDataJSON())
    }

    if (method === 'POST' && path === `/v1/tournaments/${TOURNAMENT_ID}/transitions`) {
      return this.transition(route, request.postDataJSON())
    }

    const enter = path.match(/^\/v1\/tournaments\/([^/]+)\/events\/([^/]+)\/entries$/)
    if (method === 'POST' && enter) {
      return this.enter(route, enter[2])
    }

    // The event editor's two writes. They were unmocked until #783's QA pass, which
    // is not a coincidence: nothing in this suite had ever *saved* an event, so
    // nothing had ever watched the editor receive an answer — and the answer it was
    // getting (a 422) was being thrown away along with the organizer's work.
    if (method === 'POST' && path === `/v1/tournaments/${TOURNAMENT_ID}/events`) {
      return this.createEvent(route, request.postDataJSON())
    }
    const updateEvent = path.match(/^\/v1\/tournaments\/([^/]+)\/events\/([^/]+)$/)
    if (method === 'PATCH' && updateEvent) {
      return this.updateEvent(route, updateEvent[2], request.postDataJSON())
    }

    const withdraw = path.match(
      /^\/v1\/tournaments\/([^/]+)\/events\/([^/]+)\/entries\/([^/]+)$/,
    )
    if (method === 'DELETE' && withdraw) {
      return this.withdraw(route, withdraw[2], withdraw[3])
    }

    this.unhandled.push({ method, path })
    return json(route, 404, { detail: `unmocked ${method} ${path}` })
  }

  /**
   * `POST …/transitions` — the ONE way a status moves (ADR-0017). Mirrors the
   * server's three refusals, in its order: 403 for a non-owner (`can_edit`), then
   * 409 for an edge that is not in the table.
   *
   * The 409's `detail` is the API's, verbatim, because it is what the user is
   * shown — the toast's description is the error's message, so a stub that
   * invented its own wording would test the toast against a string the server
   * never sends.
   */
  private async transition(route: Route, body: unknown) {
    const to = (body as { to?: TournamentStatus } | null)?.to
    if (!to) return json(route, 422, { detail: 'a transition needs a target' })

    if (!this.detail.can_edit) {
      return json(route, 403, {
        detail: 'You can only modify tournaments you created.',
      })
    }

    const from = this.detail.status
    if (!LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to)) {
      return json(route, 409, {
        // Both of the server's shapes. A self-transition (`from === to`) — the
        // stale tab, the commonest refusal there is — is told *what happened*
        // ("This tournament is already live."), not the tautology the two-ended
        // phrasing degenerates into there. Every other illegal edge names both
        // ends, since the target alone doesn't say why it was refused.
        detail:
          from === to
            ? `This tournament is already ${to}.`
            : `This tournament is ${from}; it cannot be moved to ${to}.`,
      })
    }

    this.detail = { ...this.detail, status: to }
    // **201**, as the route is declared (`status_code=status.HTTP_201_CREATED` —
    // a transition CREATES a move, it does not update a field), and as the MSW
    // mock answers. A stub that answered 200 would be the one thing this table of
    // hand-written responses exists to prevent: a client agreeing with a server
    // that is not the one it will meet.
    return json(route, 201, this.readDetail())
  }

  /** `POST …/entries` — self-registration. No request body: the caller is always
   * the entrant. Mirrors the API's refusals so the spec cannot pass against a
   * stub more permissive than the server (400 non-singles, 409 window shut, 409
   * duplicate) — in the API's order: the permanent refusal first, then the
   * "not now" ones.
   *
   * ⚠️ **Every refusal is a CODED 409** (ADR-0968):
   * `{"detail": {"code": …, "message": …}}`. The client switches on the `code` and
   * owns the copy it shows; the `message` is what it falls back on for a code it
   * does not know. This suite runs with **MSW off** and nothing type-checks these
   * stub bodies — a stub still answering the pre-ADR `{"detail": "<sentence>"}`
   * would take the client's unknown-refusal path and the spec would fail on the
   * toast, which is the only place the mismatch could show. */
  private async enter(route: Route, eventId: string) {
    const event = this.detail.events.find((e) => e.id === eventId)
    if (!event) return json(route, 404, { detail: 'event not found' })
    if (event.format !== 'singles') {
      return json(route, 400, { detail: 'only singles events can be entered' })
    }
    const closed = this.registrationClosed()
    if (closed) {
      return json(route, 409, {
        detail: { code: 'registration_closed', message: closed },
      })
    }
    if (event.entrants.some((e) => e.user_id === ME.userId)) {
      // The server's partial unique index, in miniature: at most one *active*
      // entry per player per event. Asked BEFORE the event's own refusals below, so
      // an entrant in a full event is told "you are already in" — never "it's full".
      return json(route, 409, {
        detail: {
          code: 'already_entered',
          message: 'You have already entered this event.',
        },
      })
    }
    // The event's own refusals (#783), in the server's precedence — eligibility,
    // then capacity. The UI is supposed to render these as copy and offer no button
    // at all, so a spec should never reach them; they are here because a stub that
    // 201'd a full event would be more permissive than the server, and a regression
    // that kept offering Enter would then look perfect.
    const state = this.read(event).entry_state
    if (state.state === 'rating_ineligible') {
      return json(route, 409, {
        detail: {
          code: 'rating_ineligible',
          message: 'Your rating does not meet this event’s eligibility rules.',
        },
      })
    }
    if (state.state === 'event_full') {
      return json(route, 409, {
        detail: { code: 'event_full', message: 'This event is full.' },
      })
    }

    return json(route, 201, this.addEntry(eventId))
  }

  /**
   * `POST /v1/tournaments` — the "New tournament" dialog's write. Refused with the
   * same FastAPI 422 (a `detail` ARRAY, `loc: ["body", "name"]`) while
   * `refuseTournamentCreate()` is in force; otherwise a 201 whose id is the one the
   * store serves a detail page for, so the dialog's success navigation lands
   * somewhere real.
   */
  private async createTournament(route: Route, body: unknown) {
    if (this.faultingTournamentCreate) return serverFault(route)
    if (this.refusingTournamentCreate) return this.unprocessableName(route)

    const fields = body as { name?: string }
    this.detail = { ...this.detail, name: fields.name ?? this.detail.name }
    return json(route, 201, this.readDetail())
  }

  /**
   * `POST …/events` — create an event, and **refuse an over-long name with a 422**,
   * as the server does (`VARCHAR(255)`), in FastAPI's own body shape: a `detail`
   * ARRAY of `{msg}` objects, which `extractDetail` (`src/api/client.ts`) is what
   * turns into the sentence the editor shows. A stub that answered `{detail: "…"}`
   * would be testing the client against a server it will never meet.
   *
   * Everything else is a 201. Notably a rule with a **null value** is one of them:
   * the API deliberately still accepts a half-written rule (it constrains nobody),
   * which is exactly why the guard against `Rating < ?` has to live in the client.
   * A stub that 422'd it would let a spec pass against a server stricter than the
   * real one — and would prove nothing about the form.
   */
  private async createEvent(route: Route, body: unknown) {
    if (this.faultingWrites) return serverFault(route)
    if (this.refusingWrites || nameTooLong(body)) return this.unprocessableName(route)

    // The wire body (`TournamentEventCreate`) is the read shape minus the fields the
    // server owns — `entered` is derived, and a new event has no entrants.
    const fields = body as Partial<Omit<TournamentEventRead, 'entered'>>
    const created = buildTournamentEventRead({
      ...fields,
      id: `ev-created-${this.detail.events.length + 1}`,
      entrants: [],
    })
    this.detail = { ...this.detail, events: [...this.detail.events, created] }
    return json(route, 201, this.read(created))
  }

  /** `PATCH …/events/{event_id}` — edit an event, with the same 422. */
  private async updateEvent(route: Route, eventId: string, body: unknown) {
    const event = this.detail.events.find((e) => e.id === eventId)
    if (!event) return json(route, 404, { detail: 'event not found' })
    if (this.faultingWrites) return serverFault(route)
    if (this.refusingWrites || nameTooLong(body)) return this.unprocessableName(route)

    const fields = body as Partial<Omit<TournamentEventRead, 'entered'>>
    // `entrants` and `entered` are the server's, not the editor's — the write body
    // does not carry them, and echoing the client's view back would clobber
    // registrations it never saw.
    this.mutateEvent(eventId, (e) => ({ ...e, ...fields, entrants: e.entrants }))
    return json(route, 200, this.read(this.eventNamed(fields.name ?? event.name)))
  }

  /** FastAPI's 422, verbatim: `detail` is an ARRAY of pydantic errors. A stub
   * answering `{detail: "…"}` here would be testing the client against a server it
   * will never meet — and would hide the very thing round two was about, because a
   * plain-string detail is *our* copy and may legitimately be shown, while this `msg`
   * is **Pydantic's** and may not. The client reads the `loc` (which field) and words
   * the rest itself (`data/save-failure`); this `msg` must appear NOWHERE on screen.
   *
   * Shared by the event writes and `POST /v1/tournaments`, because it is the same
   * refusal: both names are `VARCHAR(255)`, and FastAPI words them identically. */
  private unprocessableName(route: Route) {
    return json(route, 422, {
      detail: [
        {
          type: 'string_too_long',
          loc: ['body', 'name'],
          msg: `String should have at most ${EVENT_NAME_MAX} characters`,
        },
      ],
    })
  }

  /** `DELETE …/entries/{entry_id}` — withdrawal. The server soft-deletes; from
   * the wire that is indistinguishable from dropping the row, since a withdrawn
   * entry appears in neither the roster nor the count. Withdrawing an entry
   * that is already gone is idempotent (204), exactly as on the server. */
  private async withdraw(route: Route, eventId: string, entryId: string) {
    const event = this.detail.events.find((e) => e.id === eventId)
    if (!event) return json(route, 404, { detail: 'event not found' })

    const entrant = event.entrants.find((e) => e.id === entryId)
    // Idempotent in EVERY status, gate or no gate (ADR-0017): an entry that is
    // already withdrawn has nothing left to lock, so this stays a 204 rather than
    // becoming the 409 a blunt gate would make it.
    if (!entrant) return noContent(route)
    if (entrant.user_id !== ME.userId) {
      return json(route, 403, { detail: 'not your entry' })
    }
    // …but withdrawing a LIVE entry is refused once the window shuts: pulling a
    // player out from under a draw cut from the field they were in is precisely
    // what going live forbids.
    const closed = this.registrationClosed()
    if (closed) return json(route, 409, { detail: closed })

    this.mutateEvent(eventId, (e) => ({
      ...e,
      entrants: e.entrants.filter((x) => x.id !== entryId),
    }))
    return noContent(route)
  }

  /** The server's SENTENCE for why a *state change* to an entry is refused right
   * now, or `null` while the window is open. Only `published` is open — the status
   * IS the state of the registration window (ADR-0017).
   *
   * Entering wraps this in the `registration_closed` CODE (ADR-0968); withdrawing
   * still sends it bare, because the withdraw route's 409 is still prose. */
  private registrationClosed(): string | null {
    const status = this.detail.status
    return status === 'published' ? null : REGISTRATION_CLOSED_DETAIL[status]
  }

  private mutateEvent(
    eventId: string,
    fn: (event: TournamentEventRead) => TournamentEventRead,
  ) {
    this.detail = {
      ...this.detail,
      events: this.detail.events.map((e) => (e.id === eventId ? fn(e) : e)),
    }
  }
}

/** The one server-side constraint on an event write this suite mirrors: the name
 * column's length. Everything else the editor can author, the API accepts — a rule
 * with no value included, which is exactly why the client has to refuse it. */
function nameTooLong(body: unknown): boolean {
  const name = (body as { name?: unknown } | null)?.name
  return typeof name === 'string' && name.length > EVENT_NAME_MAX
}

/** FastAPI's 500 for an unhandled exception, verbatim: a plain-string `detail`. Which
 * is the trap — a plain-string `detail` is normally *our* copy and may be shown, so a
 * classifier reading the body instead of the STATUS would print "Internal Server Error"
 * to an organizer. It must appear nowhere on screen; what the user is told is the
 * client's own sentence, and it is not about their connection. */
function serverFault(route: Route) {
  return json(route, 500, { detail: 'Internal Server Error' })
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function noContent(route: Route) {
  return route.fulfill({ status: 204 })
}
