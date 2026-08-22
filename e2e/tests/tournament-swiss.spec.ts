import { test, expect, type Page } from '@playwright/test'
import { faker } from '@faker-js/faker'

import {
  SWISS_STANDINGS_COLUMNS,
  TournamentDetailPage,
} from '../page-objects/tournament-detail.page'
import { guestFromContext, type Guest } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  readSwissRounds,
  readSwissStandings,
  type SwissFixture,
  type SwissStanding,
} from '../support/swiss-draw'
import {
  createTournament,
  findEventByName,
  getDrawTypeCatalogue,
  seedEntrants,
} from '../support/tournament-api'
import {
  earlierRegisteredWins,
  inStraightGames,
  playSwissRound,
  type PickResult,
  type PickWinner,
} from '../support/tournament-play'

/** The event the director authors in the browser, and the handle the spec finds it by
 * afterwards — its id is minted server-side and never crosses back through the UI. */
const EVENT_NAME = 'Open Singles'

/** The draw type's **server-authored** label. The picker renders the served catalogue
 * (ADR 20260726), so this string is the `draw_types` seed row's `name` column, not the
 * client's — which is why choosing by it is itself the "a real name, not a raw slug"
 * assertion. */
const DRAW_TYPE_LABEL = 'Swiss'
/** The slug the same row is keyed by, and the value the event stores as its `draw_type`.
 * Named separately from the label precisely so the two can be compared. */
const DRAW_TYPE_KEY = 'swiss'

/** **R** — the round count, a **required** setting with no derived default (ADR "swiss
 * pre-cuts every round and pairs each one on advance"). Three, because the demoable
 * outcome is "round 1 paired, the later rounds present but not yet paired" and one later
 * round could be a coincidence of an off-by-one. It also stays under the cut's
 * `R <= n - 1` refusal for both fields below. */
const ROUNDS = 3

/** `n` for the two parities, which are two different code paths and not two sizes of the
 * same one. Eight pairs the whole field every round; seven leaves exactly one entrant
 * with **no fixture at all**, because a bye is the absence of a row (ADR-0786) — and that
 * is the case whose fixtures seat one fewer entrant than the event has, which is what
 * used to read as a stale draw and refuse go-live. */
const EVEN_FIELD = 8
const ODD_FIELD = 7

/**
 * Who wins round 1 of the even field, **by registration index** — deliberately alternating
 * across the draw order.
 *
 * This is the whole design of the pairing test. Round 1 seats draw-order position `i`
 * against `i + m/2`, so "the earlier-registered entrant wins" (`earlierRegisteredWins`,
 * what every other tournament spec plays with) makes the round-1 winners **exactly the
 * first half of the draw order** — and then the standings order and the draw order agree,
 * fixture for fixture. A pairing that ignored the standings entirely would deal the same
 * round 2, and an assertion about "paired by the standings" would pass against it.
 *
 * So the bottom half takes fixtures 1 and 3 and the top half takes 2 and 4: the winners are
 * registrations 4, 1, 6, 3, which interleave with the losers 0, 2, 5, 7. Now the two orders
 * cannot be confused — pairing down the draw order puts registration 0 (a loser) against
 * registration 1 (a winner) in the very first fixture.
 */
const ROUND_ONE_WINNERS = [4, 1, 6, 3]

/** `n` and `R` for the **Buchholz** test: six entrants over two rounds.
 *
 * Six because the tied group has to face *different* opposition. A field small enough for
 * everybody to have played everybody cannot discriminate at all: Buchholz would then be
 * `total wins − your own wins`, identical for any two entrants level on wins, by
 * arithmetic. Six players in two rounds leaves each of them having met a third of the
 * field, which is what makes strength of schedule a real difference.
 *
 * Two rounds because the whole fixture has to be **predicted**, not observed: round 2 is
 * paired from the round-1 standings, so the spec can only write down expected results if
 * it knows the pairing, and round 2 is the last round for which that is derivable without
 * re-implementing the greedy walk (see `consecutivePairs`). One round could not work — after
 * round 1 every opponent's win count is 0 or 1 and the tied entrants' Buchholz figures are
 * equal by symmetry.
 */
const BUCHHOLZ_FIELD = 6
const BUCHHOLZ_ROUNDS = 2

/** One fixture's planned outcome, by **registration index**: who wins, who loses, and how
 * many games the loser takes. The margin is the point — see `BUCHHOLZ_ROUND_ONE`. */
interface PlannedResult {
  readonly winner: number
  readonly loser: number
  readonly loserGames: number
}

/**
 * **Round 1 of the Buchholz fixture**, on the pairing the cut deals: draw-order position
 * `i` against `i + 3`, so `p0-p3`, `p1-p4`, `p2-p5`.
 *
 * The three winners are chosen with **three different margins** on purpose. After one round
 * every winner's Buchholz is 0 (their opponent has no wins yet) and every loser's is 1, so
 * Buchholz separates nobody and the standings fall through to game difference — which means
 * three distinct margins make the round-1 order, and therefore round 2's pairing, **fully
 * determined**. Give two winners the same margin and the order between them falls to the
 * entry-id tiebreak, the pairing becomes a coin flip, and every number below it is a
 * guess. (The editor's default best-of-5 is what affords three margins: 3-0, 3-1, 3-2.)
 */
const BUCHHOLZ_ROUND_ONE: ReadonlyArray<PlannedResult> = [
  { winner: 0, loser: 3, loserGames: 0 },
  { winner: 1, loser: 4, loserGames: 1 },
  { winner: 2, loser: 5, loserGames: 2 },
]

/**
 * **Round 2**, on the pairing those results force. The standings after round 1 read
 * `p0, p1, p2` (winners, by margin) then `p5, p4, p3` (losers, by margin), and the walk
 * gives each entrant the nearest following one they have not met:
 *
 * - `p0` takes `p1` — the two at the top of the table;
 * - `p2` skips `p5`, whom it has just beaten, and takes `p4`;
 * - `p5` and `p3` are left, and are strangers.
 *
 * The results below are then chosen to make **margin and strength of schedule point
 * opposite ways** among the four entrants who finish level on one win:
 *
 * | | wins | opponents | Buchholz | game difference |
 * | --- | --- | --- | --- | --- |
 * | `p4` | 1 | `p1` (2 wins), `p2` (1) | **3** | **-1** |
 * | `p0` | 1 | `p3` (0), `p1` (2) | 2 | +2 |
 * | `p2` | 1 | `p5` (1), `p4` (1) | 2 | 0 |
 * | `p5` | 1 | `p2` (1), `p3` (0) | **1** | **+2** |
 *
 * `p4` has the **worst** margin of the four and the **strongest** schedule; `p5` has the
 * joint-best margin and the weakest schedule. Buchholz above game difference ranks the
 * four `p4, p0, p2, p5` — the order this test asserts. Demote the step below game
 * difference and the two ends of that group swap: `p4` falls to the bottom of the field's
 * middle and `p0` takes the top of it, which is what the falsification of this test
 * measured.
 */
const BUCHHOLZ_ROUND_TWO: ReadonlyArray<PlannedResult> = [
  { winner: 1, loser: 0, loserGames: 2 },
  { winner: 4, loser: 2, loserGames: 2 },
  { winner: 5, loser: 3, loserGames: 0 },
]

/** One row of the standings the fixture above produces, in **finishing order** — so the
 * index is the rank and the whole table is one written-down expectation. Every column the
 * table shows is here, because a wrong number in the right order is still wrong. */
interface ExpectedStanding {
  /** The entrant, by registration index. */
  readonly player: number
  readonly wins: number
  readonly losses: number
  readonly buchholz: number
  readonly gameDifference: number
  readonly gamesWon: number
}

/**
 * **The standings the Buchholz fixture must produce**, top to bottom.
 *
 * `p1` leads on wins, `p3` is last on wins, and the four in between are level on one win
 * and ordered by Buchholz — the claim this test exists to make. Read the middle four
 * downwards: Buchholz falls 3, 2, 2, 1 while game difference goes -1, +2, 0, +2. The one
 * column descends; the other does not. That is what "ranked by strength of schedule rather
 * than by margin" looks like on a table.
 */
const BUCHHOLZ_STANDINGS: ReadonlyArray<ExpectedStanding> = [
  { player: 1, wins: 2, losses: 0, buchholz: 2, gameDifference: 3, gamesWon: 6 },
  { player: 4, wins: 1, losses: 1, buchholz: 3, gameDifference: -1, gamesWon: 4 },
  { player: 0, wins: 1, losses: 1, buchholz: 2, gameDifference: 2, gamesWon: 5 },
  { player: 2, wins: 1, losses: 1, buchholz: 2, gameDifference: 0, gamesWon: 5 },
  { player: 5, wins: 1, losses: 1, buchholz: 1, gameDifference: 2, gamesWon: 5 },
  { player: 3, wins: 0, losses: 2, buchholz: 2, gameDifference: -6, gamesWon: 0 },
]

/** The two entrants the claim rests on, **by registration index**: `p4` faced the stronger
 * schedule on a worse margin, `p0` the weaker schedule on a better one. The test asserts
 * their relationship off the *served* standings rather than off the table above, so a
 * fixture that stopped discriminating fails instead of passing quietly. */
const STRONGER_SCHEDULE = 4
const BETTER_MARGIN = 0

/** A game difference as the table renders it: signed when positive, because `+2` and `-2`
 * are different standings and a bare `2` would read as both. */
function signed(difference: number): string {
  return difference > 0 ? `+${difference}` : String(difference)
}

/** One expected row as the seven cells the table renders, in column order
 * (`SWISS_STANDINGS_COLUMNS`). */
function standingRowText(
  expected: ExpectedStanding,
  rank: number,
  username: string,
): string[] {
  return [
    String(rank),
    username,
    String(expected.wins),
    String(expected.losses),
    String(expected.buchholz),
    signed(expected.gameDifference),
    String(expected.gamesWon),
  ]
}

/**
 * Play a round to a **written-down plan**: each fixture decided by the row naming both its
 * entrants, at the margin that row gives.
 *
 * Refuses a pairing the plan does not name, and says which two it met. That refusal is
 * load-bearing rather than defensive: the plan is written against a pairing this spec
 * *derived* (see `BUCHHOLZ_ROUND_TWO`), so a server that paired the round differently would
 * otherwise produce plausible results for the wrong matches, and the failure would surface
 * as an inexplicable standings table two steps later.
 */
function asPlanned(
  plan: ReadonlyArray<PlannedResult>,
  entrants: ReadonlyArray<Guest>,
): PickResult {
  const indexOf = new Map(entrants.map((guest, index) => [guest.username, index]))
  const nameOf = (index: number): string => entrants[index].username
  return (a, b) => {
    const pair = [indexOf.get(a.username), indexOf.get(b.username)]
    const row = plan.find(
      (candidate) =>
        pair.includes(candidate.winner) && pair.includes(candidate.loser),
    )
    if (!row) {
      const planned = plan
        .map((r) => `${nameOf(r.winner)} vs ${nameOf(r.loser)}`)
        .join('; ')
      throw new Error(
        `the round paired ${a.username} vs ${b.username}, which this fixture's plan ` +
          `does not name — it expects: ${planned}`,
      )
    }
    return {
      winner: indexOf.get(a.username) === row.winner ? a : b,
      loserGames: row.loserGames,
    }
  }
}

/**
 * Round one, as the ADR seeds it: **top half against bottom half in draw order**.
 *
 * With `m = 2⌊n/2⌋` entrants actually playing, draw-order position `i` meets position
 * `i + m/2`, so `⌊n/2⌋` fixtures come out in position order. The draw order is
 * registration order here: `order_entrants` sorts by seed, then `created_at`, and nothing
 * seeds these entries — while `seedEntrants` enters its guests **sequentially**, on
 * purpose, exactly so this is derivable rather than a race.
 *
 * An odd field's last-registered entrant is therefore the lowest-ranked, and is the one
 * this function never names: they are the round's **bye**.
 *
 * Written as the arithmetic rather than a hand-listed table, so the expectation cannot
 * drift from the rule it is supposed to be checking.
 */
function roundOneLines(entrants: ReadonlyArray<Guest>): string[] {
  const half = Math.floor(entrants.length / 2)
  return Array.from(
    { length: half },
    (_, i) => `${entrants[i].username} vs ${entrants[i + half].username}`,
  )
}

/**
 * Author a `swiss` event **through the editor sheet** and return its id.
 *
 * Through the sheet, not seeded over the API, for the reason `tournament-rr-then-ko`
 * drives its own create: the body is `drawSettingsToApi`'s, and `rounds` is **required
 * with no default** on the swiss arm of the server's draw-settings union. A client that
 * names the format and sends no round count is a 422 at the request boundary, and nothing
 * that stubs the network can see it — the disagreement is *between* the two halves.
 *
 * Asserts the POST's status directly so that refusal names itself here, rather than
 * surfacing three steps later as a missing event.
 */
async function authorSwissEvent(
  page: Page,
  detail: TournamentDetailPage,
  director: Guest,
  tournamentId: string,
  rounds: number = ROUNDS,
): Promise<string> {
  const editor = await detail.openNewEvent()
  await editor.nameInput.fill(EVENT_NAME)
  await editor.chooseDrawType(DRAW_TYPE_LABEL)
  // The round-count box exists ONLY for this draw type — it is absent, not disabled, for
  // a format that does not ask the question. So its appearance is the proof the picker's
  // choice reached the form, before anything is submitted.
  await expect(editor.roundsInput).toBeVisible()
  await editor.setRounds(rounds)

  const createPost = page.waitForResponse(
    (r) => r.url().endsWith('/events') && r.request().method() === 'POST',
  )
  await editor.createEventButton.click()
  const createResponse = await createPost
  expect(
    createResponse.status(),
    `create event was refused: ${await createResponse.text()}`,
  ).toBe(201)
  // The sheet closes on success alone and keeps its refusal inline, so an empty error
  // slot is the second, independent word on the same fact.
  await expect(editor.errorAlert).toBeHidden()

  // A 201 says the body was accepted; only the read-back says R survived it. A server
  // that dropped the round count on the floor would answer 201 too — and then cut one
  // round, or none.
  const event = await findEventByName(director, tournamentId, EVENT_NAME)
  expect(event.draw_type).toBe(DRAW_TYPE_KEY)
  expect(event.rounds).toBe(rounds)
  return event.id
}

/**
 * Cut the event's draw **from the event card**, asserting the POST's own status.
 *
 * The status rather than the panel appearing: a refused cut leaves the card as it was, so a
 * spec that only waited for fixtures would fail as a timeout naming nothing. The 201's body
 * is read into the message, so a `DegenerateDraw` refusal names its own reason here.
 */
async function cutTheDraw(page: Page, detail: TournamentDetailPage): Promise<void> {
  const drawPost = page.waitForResponse(
    (r) => r.url().endsWith('/draw') && r.request().method() === 'POST',
  )
  await detail.generateDrawButton(EVENT_NAME).click()
  const response = await drawPost
  expect(
    response.status(),
    `cutting the draw was refused: ${await response.text()}`,
  ).toBe(201)
}

/**
 * Take the tournament **live** from the header, asserting the transition's own status and
 * then the two independent signs it landed: the header now offers the only edge a live
 * tournament has, and the inline slot a refused transition lands in is empty.
 *
 * Go-live is what turns round 1's fixtures into real matches — without it there is nothing
 * to play and therefore no round to decide.
 */
async function goLive(page: Page, detail: TournamentDetailPage): Promise<void> {
  const transitionPost = page.waitForResponse(
    (r) => r.url().endsWith('/transitions') && r.request().method() === 'POST',
  )
  // `startTournament`, not `startButton.click()`: the header's button only opens the
  // confirm now, and the transition is fired by the dialog's. Armed before the act so the
  // response lands inside the wait either way.
  await detail.startTournament()
  const response = await transitionPost
  expect(
    response.status(),
    `going live was refused: ${await response.text()}`,
  ).toBe(201)
  await expect(detail.endButton).toBeVisible()
  await expect(detail.lifecycleNotice).toBeHidden()
}

/** The usernames a fixture seats, refusing an unseated side by name.
 *
 * A `null` side is `TBD` — a round that has not been paired (ADR-0786) — so meeting one
 * where a pairing is expected is the failure itself, not a case to skip. */
function namesOf(fixture: SwissFixture, round: number): [string, string] {
  const { a, b } = fixture
  if (a === null || b === null) {
    throw new Error(
      `round-${round} pairing ${fixture.position} is only half seated ` +
        `(${a ?? 'TBD'} vs ${b ?? 'TBD'}) — the round was not paired`,
    )
  }
  return [a, b]
}

/** The order walked in pairs: `[o0, o1], [o2, o3], …` — what pairing a standings order
 * produces when nobody in it has met anybody adjacent to them.
 *
 * That condition holds for round 2 and is not a general truth about swiss: after one round
 * every entrant has met exactly one opponent, and wins outrank everything else in the
 * standings, so a pair of neighbours is either two entrants with the same round-1 result
 * (who cannot have played each other — one of them would have lost) or straddles the
 * boundary between results, where the two are again strangers. From round 3 on the greedy
 * walk really does have to skip somebody, and a rematch is the last resort rather than a
 * refusal — which is why only round 2's pairings are asserted this exactly. */
function consecutivePairs(order: ReadonlyArray<string>): Array<[string, string]> {
  return Array.from(
    { length: Math.floor(order.length / 2) },
    (_, index): [string, string] => [order[index * 2], order[index * 2 + 1]],
  )
}

/** A standings read as a lookup from username to the **server-minted entry id** its row is
 * keyed by — the handle `TournamentDetailPage.swissStandingRow` takes.
 *
 * Entry ids, never names, because the row's test hook is the entry: asking for the row by
 * id is what makes "this entrant's row" a statement about the server's entry rather than
 * about a name that happens to be a substring of another. */
function entryIds(standings: ReadonlyArray<SwissStanding>): Map<string, string> {
  return new Map(standings.map((row) => [row.username, row.entryId]))
}

/** Look one entrant's standings row up, failing by name when the field does not hold them
 * — an entrant missing from the table is a real finding, and `undefined` threaded onward
 * would surface as an inexplicable locator timeout. */
function standingOf(
  standings: ReadonlyArray<SwissStanding>,
  username: string,
): SwissStanding {
  const row = standings.find((candidate) => candidate.username === username)
  if (!row) {
    const named = standings.map((r) => r.username).join(', ') || '(none)'
    throw new Error(`${username} has no standings row — the table holds: ${named}`)
  }
  return row
}

/**
 * **Swiss, through the composed stack** (#1276, ADR "swiss pre-cuts every round and pairs
 * each one on advance").
 *
 * A director creates a swiss event **in the browser**, sets its round count, publishes,
 * has a field entered, cuts the draw, and reads it: round 1 paired with real players, and
 * every later round present, cut, and announced as forthcoming. Then the event is played:
 * finishing a round pairs the next one **from the standings**, and an odd field's bye moves
 * from entrant to entrant, scoring as a win the moment its round is decided.
 *
 * ## Both parities, because they are different code
 *
 * A swiss round emits `⌊n/2⌋` fixtures whatever the parity, so an **even** field is
 * wholly seated by its own draw and an **odd** one leaves exactly one entrant referenced
 * by no fixture at all — a bye is the *absence of a row* (ADR-0786), never a row with a
 * NULL side, which here would be indistinguishable from a later round awaiting its
 * pairing.
 *
 * That difference is not cosmetic. Draw currency ("the fixtures seat exactly the active
 * entrants") compared the two sets for equality, so a seven-player swiss cut from exactly
 * those seven read **stale** the moment it was cut, and go-live refused it with a 409 no
 * re-cut could clear. Hence the odd test does not stop at the cut: it takes the
 * tournament **live**, which is the assertion that would have failed.
 *
 * ## What this spec deliberately does NOT test
 *
 * **That no pairing is ever a rematch.** It is not true and it is not meant to be: the walk
 * gives each entrant the nearest following one they have not met, and when everybody below
 * is an old opponent it takes the nearest all the same. Refusing to pair would strand a
 * live event with no move a director could make, which is far worse than one repeated
 * fixture — and a greedy walk does not always find the rematch-free pairing that exists
 * (five entrants over four rounds repeat one). So the pairing assertions below stop at
 * round 2, the last round for which "the standings, walked in pairs" is exactly the answer.
 *
 * **Buchholz**, and the ordering that puts it above game difference: a later slice. The
 * table these tests read is the shared standings finishing order.
 *
 * ## Seed vs UI split
 *
 * Inert scaffolding over the API (`support/tournament-api.ts`): the tournament shell and
 * the entrants — director-entry has no web UI, and fifteen browser sign-ins to test a
 * *draw* would be fifteen chances to fail for an unrelated reason. Load-bearing steps in
 * the browser: authoring the event and its round count, publishing, cutting the draw,
 * going live, and every reading of the draw.
 *
 * ## RBAC
 *
 * As in `tournament-lifecycle.spec.ts`: a minted user holds only the permissionless
 * default role, so `grantBetaTester` hands the director the tournament bundle over the
 * stack's own `postgres` container before any tournament write. Skipped against an
 * external `E2E_BASE_URL` stack, where the caller owns provisioning.
 */
test.describe('Tournament — swiss draw', () => {
  test('a director cuts an even swiss field into a paired round 1 and forthcoming later rounds', async ({
    page,
    baseURL,
  }) => {
    // Eight minted guests, eight director-entries and a real cut, on top of the ordinary
    // page work.
    test.setTimeout(300_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session, so page navigations run as them.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    const name = `Swiss ${faker.string.alphanumeric(8)}`
    const { tournamentId } = await createTournament(director, name)

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    // `toContainText`, not `toHaveText`: the hero sets its own full stop after the name.
    //
    // The long timeout is for the FIRST navigation only, and it is about the stack rather
    // than the app: the composed web-client is a Vite **dev** server, so the very first
    // request for a route pays for transforming it on demand.
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    // ----- the format is OFFERED, with the server's own copy ------------------
    // Read first, before anything is authored: a stack serving a build without swiss
    // fails here, by name, rather than three steps later as an empty picker.
    //
    // `name` and `description` are **seed data** — a `draw_types` row a migration inserts
    // — so this asks the server what it is serving. The sentence itself is not retyped:
    // pinning that copy in a spec as well as in the migration is how a wording change
    // reds a suite in a file nobody thought to look at. What is asserted is that both are
    // real, director-facing strings and neither is the raw slug.
    const catalogue = await getDrawTypeCatalogue(director, tournamentId)
    const swiss = catalogue.find((row) => row.key === DRAW_TYPE_KEY)
    if (!swiss) {
      const keys = catalogue.map((row) => row.key).join(', ') || '(none)'
      throw new Error(
        `the served draw-type catalogue does not offer swiss — has: ${keys}`,
      )
    }
    expect(swiss.name).toBe(DRAW_TYPE_LABEL)
    expect(swiss.name).not.toBe(DRAW_TYPE_KEY)
    expect(swiss.description.length).toBeGreaterThan(0)
    expect(swiss.description).not.toBe(DRAW_TYPE_KEY)

    // ----- author the swiss event, in the browser -----------------------------
    // `chooseDrawType` picks the option by that same server-authored label, EXACTLY — so
    // a picker rendering `swiss` (or nothing) finds no option and reds here. It is the
    // browser's half of the assertion above.
    const eventId = await authorSwissEvent(page, detail, director, tournamentId)

    // ----- publish, then fill the field --------------------------------------
    await detail.publishTournament()
    await expect(detail.startButton).toBeVisible()

    const entrants = await seedEntrants(
      director,
      baseURL!,
      tournamentId,
      eventId,
      EVEN_FIELD,
    )
    // How many entries landed is asked of the SERVER, not counted off the roster: the
    // card lists eight chips and collapses the rest into "+N more", so a list-item count
    // here would be counting the truncation rather than the field.
    const filled = await findEventByName(director, tournamentId, EVENT_NAME)
    expect(filled.entered).toBe(EVEN_FIELD)

    await detail.reload(tournamentId)
    await expect(detail.entrantsList(EVENT_NAME)).toContainText(entrants[0].username)

    // ----- cut the draw: all R rounds, in one stroke --------------------------
    await cutTheDraw(page, detail)

    // ----- the rounds view, NOT the bracket ----------------------------------
    // Both facts, because either alone passes against the view it is not about. Swiss and
    // an `rr-then-ko` knockout stage share `group_id IS NULL`, and routing on that null
    // alone rendered a swiss draw through single-elimination's successor arithmetic —
    // columns named back from a Final that a format eliminating nobody does not have.
    await expect(detail.swissRounds(eventId)).toBeVisible()
    await expect(detail.bracket(eventId)).toHaveCount(0)
    // A swiss draw is group-less: the whole field is ranked in one table.
    await expect(detail.groupDraws(eventId)).toHaveCount(0)

    // ----- round 1 is PAIRED, with real players ------------------------------
    // One statement pinning the count, the order and the pairings: `⌊8/2⌋` = four
    // fixtures, in position order, top half against bottom half of the draw order.
    await expect(detail.swissRoundFixtures(eventId, 1)).toHaveText(
      roundOneLines(entrants),
    )
    // An even field seats everybody, so nobody sits out — the half that makes the odd
    // test's single absence mean something.
    for (const entrant of entrants) {
      await expect(
        detail.swissRounds(eventId),
        `${entrant.username} entered an even field and is in no round-1 fixture`,
      ).toContainText(entrant.username)
    }

    // ----- …and rounds 2..R are CUT but not paired ---------------------------
    // The ADR's whole shape: `R × ⌊n/2⌋` fixtures written at the cut, every side of the
    // later rounds NULL. So each later round is a *forthcoming* announcement carrying its
    // own match count — not a paired list, and not absent.
    for (let round = 2; round <= ROUNDS; round += 1) {
      await expect(detail.swissRound(eventId, round)).toHaveCount(0)
      await expect(detail.swissRoundForthcoming(eventId, round)).toBeVisible()
      // `⌊n/2⌋` per round, whatever the round. The client's sentence around it is not
      // retyped — only the number the ADR fixes.
      await expect(detail.swissRoundForthcoming(eventId, round)).toContainText(
        `${EVEN_FIELD / 2} matches`,
      )
    }
    // R rounds and no more: the round count is the director's setting, never derived from
    // the field. A fourth round would mean the server had sized the draw off something
    // else.
    await expect(detail.swissRound(eventId, ROUNDS + 1)).toHaveCount(0)
    await expect(detail.swissRoundForthcoming(eventId, ROUNDS + 1)).toHaveCount(0)

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })

  test('a director cuts an odd swiss field, one entrant sits out round 1, and the tournament goes live', async ({
    page,
    baseURL,
  }) => {
    // Seven minted guests, seven director-entries, a real cut and a real go-live (which
    // materializes round 1 into matches and enqueues the schedule solve on the stack's
    // own worker), on top of the ordinary page work.
    test.setTimeout(300_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    const name = `Swiss odd ${faker.string.alphanumeric(8)}`
    const { tournamentId } = await createTournament(director, name)

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    const eventId = await authorSwissEvent(page, detail, director, tournamentId)

    await detail.publishTournament()
    await expect(detail.startButton).toBeVisible()

    const entrants = await seedEntrants(
      director,
      baseURL!,
      tournamentId,
      eventId,
      ODD_FIELD,
    )
    const filled = await findEventByName(director, tournamentId, EVENT_NAME)
    // Seven, off the server. The bye assertion below is "seven entered and six are
    // named", so this number is half of it and cannot be counted off a roster that
    // truncates.
    expect(filled.entered).toBe(ODD_FIELD)

    await detail.reload(tournamentId)

    // ----- cut the draw ------------------------------------------------------
    await cutTheDraw(page, detail)

    await expect(detail.swissRounds(eventId)).toBeVisible()
    await expect(detail.bracket(eventId)).toHaveCount(0)

    // ----- exactly one entrant sits out round 1 ------------------------------
    // `⌊7/2⌋` = three fixtures naming six of the seven, in position order.
    await expect(detail.swissRoundFixtures(eventId, 1)).toHaveText(
      roundOneLines(entrants),
    )
    // …and the seventh is the round's **bye**: the format byes the lowest-ranked entrant,
    // who under registration draw order is the last one in.
    //
    // Two different claims, asserted separately on purpose.
    //
    // A bye is still the absence of a fixture row (ADR-0786) — that domain rule has not
    // moved. What the page now does is *name the entrant that absence implies*, derived
    // client-side from the entrants a round's fixtures do not mention. Before it did, the
    // seventh player of a seven-player event appeared nowhere at all, and a director could
    // only work out who was sitting out by diffing the standings against the pairings by
    // hand. So the first claim is that the round says who it left out.
    //
    // The second is the one the whole assertion originally existed for, and it survives
    // the change: they must not be **in a pairing**. `toContainText` alone would pass just
    // as happily if they had been wrongly seated in a fixture, so it is scoped to the
    // fixtures list — which the bye line is a sibling of, never an item in.
    const byed = entrants[entrants.length - 1]
    await expect(
      detail.swissRoundBye(eventId, 1),
      `${byed.username} sits round 1 out, so the round should name them as its bye`,
    ).toContainText(byed.username)
    await expect(
      detail.swissRound(eventId, 1),
      `${byed.username} is round 1's bye — a bye is the absence of a fixture, so they ` +
        'must appear in no pairing of it',
    ).not.toContainText(byed.username)

    // Rounds 2..R are cut and forthcoming here too, at `⌊7/2⌋` matches apiece — the byed
    // entrant costs the round a fixture, they do not get one of their own.
    for (let round = 2; round <= ROUNDS; round += 1) {
      await expect(detail.swissRound(eventId, round)).toHaveCount(0)
      await expect(detail.swissRoundForthcoming(eventId, round)).toContainText(
        `${Math.floor(ODD_FIELD / 2)} matches`,
      )
      // …and NO bye line on a round nobody is paired into. The bye is derived from the
      // entrants a round's fixtures do not name, so without the "only a paired round"
      // gate every entrant qualifies on a forthcoming one and the whole field would be
      // listed as sitting it out.
      await expect(
        detail.swissRoundBye(eventId, round),
        `round ${round} has not been paired, so it byes nobody yet`,
      ).toHaveCount(0)
    }

    // ----- GO LIVE — the assertion this test exists for -----------------------
    // An odd swiss field's fixtures seat six of its seven entrants, and draw currency
    // used to read that shortfall as an entry that landed after the cut: the draw was
    // `stale`, and go-live answered 409 with a refusal no re-cut could clear. So the
    // transition's own status is asserted, not merely that a button changed.
    //
    // `goLive` asserts the transition's own status and the two independent words on the
    // same fact — the live-only edge appearing, and the inline refusal slot staying empty.
    // Without the second, a 409 would surface as a button that never appeared.
    await goLive(page, detail)

    // ----- …and going live paired nothing new --------------------------------
    // Materializing the draw turns *ready* fixtures into matches; it does not seat
    // anybody. Round 1's lines now carry their match link and status, so they are no
    // longer compared as text — but the later rounds must still be forthcoming, which is
    // the statement that go-live did not quietly fill a round nothing has paired yet.
    await expect(detail.swissRoundFixtures(eventId, 1)).toHaveCount(
      Math.floor(ODD_FIELD / 2),
    )
    for (let round = 2; round <= ROUNDS; round += 1) {
      await expect(detail.swissRound(eventId, round)).toHaveCount(0)
      await expect(detail.swissRoundForthcoming(eventId, round)).toBeVisible()
    }

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })

  /**
   * **A decided round pairs the next one, and pairs it from the STANDINGS.**
   *
   * The whole claim of `advance` (ADR "swiss pre-cuts every round and pairs each one on
   * advance"): when every match of round `r` is decided, the field is ordered by the
   * standings that round produced, walked, and each entrant given the nearest following one
   * they have not met — into the rows the cut already wrote, in rank order.
   *
   * ## The trap this test is built around
   *
   * "Round 2 has real names in it" is not evidence of any of that. Round 1 seats the draw
   * order's top half against its bottom half, so if the earlier-registered entrant wins
   * every fixture — the rule every other tournament spec plays with — the standings after
   * round 1 are the draw order, and **a pairing that ignored the standings entirely would
   * deal the identical round 2**. The assertion would pass against the bug it exists to
   * catch.
   *
   * So the winners alternate across the draw order (`ROUND_ONE_WINNERS`), which prises the
   * two orders apart, and the sharp assertion is the one that follows: **no round-2 fixture
   * puts a round-1 winner against a round-1 loser.** Pairing down the draw order pairs
   * registration 0 with registration 1 — a loser against a winner — and reds naming both.
   */
  test('completing every match in round 1 pairs round 2 from the standings, not the draw order', async ({
    page,
    baseURL,
  }) => {
    // Eight minted guests, eight director-entries, a real cut, a real go-live and four
    // matches played out over the API, on top of the ordinary page work.
    test.setTimeout(420_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    const name = `Swiss pairing ${faker.string.alphanumeric(8)}`
    const { tournamentId } = await createTournament(director, name)

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    const eventId = await authorSwissEvent(page, detail, director, tournamentId)

    await detail.publishTournament()
    await expect(detail.startButton).toBeVisible()

    const entrants = await seedEntrants(
      director,
      baseURL!,
      tournamentId,
      eventId,
      EVEN_FIELD,
    )
    const filled = await findEventByName(director, tournamentId, EVENT_NAME)
    expect(filled.entered).toBe(EVEN_FIELD)

    await detail.reload(tournamentId)
    await cutTheDraw(page, detail)

    // ----- the state this test moves OFF -------------------------------------
    // Round 1 seeded from the draw order, round 2 cut and announced as forthcoming. Read
    // first, so "round 2 is paired" below is a change this test caused rather than
    // something that was already true.
    await expect(detail.swissRoundFixtures(eventId, 1)).toHaveText(
      roundOneLines(entrants),
    )
    await expect(detail.swissRound(eventId, 2)).toHaveCount(0)
    await expect(detail.swissRoundForthcoming(eventId, 2)).toBeVisible()

    await goLive(page, detail)

    // ----- play round 1, winners INTERLEAVED ---------------------------------
    const winners = new Set(ROUND_ONE_WINNERS.map((index) => entrants[index].username))
    // The picker refuses a fixture that names two winners or none, which is also how a
    // round 1 seeded some other way than top-half-against-bottom-half announces itself
    // here rather than as a baffling standings order later.
    const pickInterleavedWinner: PickWinner = (a, b) => {
      const aWins = winners.has(a.username)
      if (aWins === winners.has(b.username)) {
        throw new Error(
          `round-1 fixture ${a.username} vs ${b.username} names ` +
            `${aWins ? 'two' : 'no'} designated winners — was round 1 seeded top half ` +
            'against bottom half?',
        )
      }
      return aWins ? a : b
    }
    expect(
      await playSwissRound(
        director,
        tournamentId,
        eventId,
        entrants,
        1,
        // Straight games: this test's subject is WHO won, not by how much — the margins
        // are the Buchholz test's business.
        inStraightGames(pickInterleavedWinner),
      ),
      'round 1 of an eight-player swiss is four matches',
    ).toBe(EVEN_FIELD / 2)

    await detail.reload(tournamentId)

    // ----- round 2 is PAIRED, where it read as forthcoming -------------------
    await expect(detail.swissRoundForthcoming(eventId, 2)).toHaveCount(0)
    await expect(detail.swissRoundFixtures(eventId, 2)).toHaveCount(EVEN_FIELD / 2)
    // …and ONLY round 2. One decided round pairs one round: round 3 waits for round 2,
    // which is what stops a bug that paired everything it could from passing as this one.
    await expect(detail.swissRound(eventId, 3)).toHaveCount(0)
    await expect(detail.swissRoundForthcoming(eventId, 3)).toBeVisible()

    // ----- the standings the pairing is judged against -----------------------
    // Taken from the server, because that is where both the table on screen and the
    // pairing walk take it from — a spec that re-derived its own order could only ever
    // prove the two agreed with the spec, not with each other.
    const standings = await readSwissStandings(director, tournamentId, eventId)
    expect(standings.map((row) => row.rank)).toEqual(
      Array.from({ length: EVEN_FIELD }, (_, index) => index + 1),
    )
    const order = standings.map((row) => row.username)
    expect(
      new Set(order.slice(0, EVEN_FIELD / 2)),
      `the round-1 winners should top the table; it reads ${order.join(', ')}`,
    ).toEqual(winners)
    // The same order, on screen, row for row — keyed by the server-minted entry id, so
    // this says the table a director reads IS the order paired against, not a client
    // re-sort that happens to agree.
    await expect(detail.swissStandingsRows(eventId)).toHaveCount(EVEN_FIELD)
    for (const [index, row] of standings.entries()) {
      await expect(detail.swissStandingsRows(eventId).nth(index)).toHaveAttribute(
        'data-testid',
        `standing-row-${row.entryId}`,
      )
    }

    // ----- THE assertion: paired by standings, not by draw order -------------
    const rounds = await readSwissRounds(director, tournamentId, eventId)
    const roundTwo = rounds.find((round) => round.round === 2)
    if (!roundTwo) throw new Error('the draw has no round 2 — was it cut for R rounds?')
    expect(roundTwo.satOut, 'an even field byes nobody').toEqual([])

    // 1 — nobody meets somebody who did not do what they did in round 1. This is the one
    // that reds under a pairing that walks the draw order: it would seat registration 0
    // (a loser) against registration 1 (a winner) in the very first fixture.
    for (const fixture of roundTwo.fixtures) {
      const [a, b] = namesOf(fixture, 2)
      expect(
        [a, b].filter((name) => winners.has(name)).length,
        `round-2 pairing ${fixture.position} is ${a} vs ${b}, which puts a round-1 ` +
          `winner against a round-1 loser — the standings read ${order.join(', ')}`,
      ).not.toBe(1)
    }

    // 2 — and exactly the standings order, walked in pairs, in rank order. A fixture's
    // position IS its pairing rank (ADR), so this pins the pairings AND their order in
    // one statement: the top of the table meets the top of the table.
    expect(roundTwo.fixtures.map((fixture) => namesOf(fixture, 2))).toEqual(
      consecutivePairs(order),
    )

    // 3 — and the director reads those very pairings off the page. The lines carry their
    // match link and status now that round 2 has materialized, so each is asked for the
    // two names it seats rather than compared as whole text.
    for (const [index, fixture] of roundTwo.fixtures.entries()) {
      const line = detail.swissRoundFixtures(eventId, 2).nth(index)
      for (const name of namesOf(fixture, 2)) {
        await expect(line).toContainText(name)
      }
    }

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })

  /**
   * **An odd field byes exactly one entrant a round, the bye moves, and it scores as a win
   * — but only once its round is decided** (ADR "swiss standings add Buchholz, and
   * head-to-head is guarded on having met"; CONTEXT.md, "Bye").
   *
   * Seven entrants and three rounds, played out two rounds deep, so the bye is observed
   * three times: handed out at the cut, moved at round 2, moved again at round 3.
   *
   * ## When the win lands is half the claim
   *
   * A bye is credited when its round is **decided**, not when it is paired. Crediting it at
   * the pairing would put a win on the table for a round nobody has played — a
   * seven-player draw would be cut and immediately show its byed entrant top of the
   * standings, ahead of six players who have not been given the chance to hit a ball. So
   * **both** states are asserted: nought wins on the freshly cut draw, one win once round 1
   * is decided. Asserting only the second would pass against the version of this the ADR
   * rejected.
   *
   * ## And the bye moves
   *
   * The next bye goes to the lowest-ranked entrant who has not had one, so nobody sits out
   * twice while somebody else has not sat out at all. Every bye here is **derived from the
   * fixtures** (`readSwissRounds`) rather than predicted, so the rotation is read off the
   * draw the server dealt: a bye is the absence of a row, and who is missing is the only
   * record of it there is.
   */
  test('an odd swiss field byes one entrant a round, and the bye scores as a win once its round is decided', async ({
    page,
    baseURL,
  }) => {
    // Seven minted guests, seven director-entries, a real cut, a real go-live and two
    // rounds — six matches — played out over the API, on top of the ordinary page work.
    test.setTimeout(420_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    const name = `Swiss byes ${faker.string.alphanumeric(8)}`
    const { tournamentId } = await createTournament(director, name)

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    const eventId = await authorSwissEvent(page, detail, director, tournamentId)

    await detail.publishTournament()
    await expect(detail.startButton).toBeVisible()

    const entrants = await seedEntrants(
      director,
      baseURL!,
      tournamentId,
      eventId,
      ODD_FIELD,
    )
    const filled = await findEventByName(director, tournamentId, EVENT_NAME)
    expect(filled.entered).toBe(ODD_FIELD)

    await detail.reload(tournamentId)
    await cutTheDraw(page, detail)

    const perRound = Math.floor(ODD_FIELD / 2)
    await expect(detail.swissRoundFixtures(eventId, 1)).toHaveCount(perRound)

    // ----- the cut credits NOBODY, not even the entrant who sits out ---------
    // The trap, and the half of the rule that is easy to get backwards: the byed entrant
    // is already known — they are in no fixture — and their win is still a round away.
    const atCut = await readSwissStandings(director, tournamentId, eventId)
    expect(atCut, 'the whole field is ranked in one group-less table').toHaveLength(
      ODD_FIELD,
    )
    const idOf = entryIds(atCut)
    await expect(detail.swissStandingsRows(eventId)).toHaveCount(ODD_FIELD)
    for (const row of atCut) {
      await expect(
        detail.swissStandingWins(eventId, row.entryId),
        `${row.username} has a win on a draw nobody has played yet`,
      ).toHaveText('0')
    }

    await goLive(page, detail)

    // ----- round 1: who sat out, off the draw the server dealt ---------------
    const afterCut = await readSwissRounds(director, tournamentId, eventId)
    expect(
      afterCut.map((round) => round.round),
      'the cut writes all R rounds at once',
    ).toEqual(Array.from({ length: ROUNDS }, (_, index) => index + 1))
    const roundOne = afterCut[0]
    expect(
      roundOne.satOut,
      'exactly one of an odd field sits round 1 out — a bye is the absence of a fixture',
    ).toHaveLength(1)
    const byedInRoundOne = roundOne.satOut[0]

    expect(
      await playSwissRound(
        director,
        tournamentId,
        eventId,
        entrants,
        1,
        inStraightGames(earlierRegisteredWins(entrants)),
      ),
      'round 1 of a seven-player swiss is three matches',
    ).toBe(perRound)

    await detail.reload(tournamentId)

    // ----- NOW the bye scores: a win worth zero games ------------------------
    const byedOneId = idOf.get(byedInRoundOne)
    if (!byedOneId) throw new Error(`${byedInRoundOne} has no standings row`)
    await expect(
      detail.swissStandingWins(eventId, byedOneId),
      `${byedInRoundOne} sat round 1 out and round 1 is decided — a bye is a win`,
    ).toHaveText('1')
    await expect(
      detail.swissStandingGamesWon(eventId, byedOneId),
      `${byedInRoundOne}'s bye is a win worth ZERO games — a nominal 3-0 would lift ` +
        'them over somebody who beat a real opponent',
    ).toHaveText('0')

    // ----- round 2 is paired, and the bye has MOVED --------------------------
    const afterRoundOne = await readSwissRounds(director, tournamentId, eventId)
    const roundTwo = afterRoundOne[1]
    expect(roundTwo.round).toBe(2)
    expect(roundTwo.paired, 'a decided round 1 pairs round 2').toBe(true)
    expect(roundTwo.fixtures).toHaveLength(perRound)
    expect(roundTwo.satOut, 'exactly one entrant sits round 2 out').toHaveLength(1)
    const byedInRoundTwo = roundTwo.satOut[0]
    expect(
      byedInRoundTwo,
      `${byedInRoundOne} sat out round 1 and would sit out round 2 as well, while ` +
        'somebody who has never sat out plays',
    ).not.toBe(byedInRoundOne)

    // The same facts on the page: round 2's lines name the entrant who sat round 1 out, do
    // not name the one sitting round 2 out, and the round says who that is.
    //
    // The bye line is asserted on every round the bye moves to, not only on the first,
    // because round 2 is where the derivation is doing something: round 1's bye is the
    // entrant no fixture was ever written for, while this one has to come out of a pairing
    // the server dealt at advance. A rotation that moved the bye and a page that kept
    // naming round 1's would both pass on the negative alone.
    await expect(detail.swissRoundFixtures(eventId, 2)).toHaveCount(perRound)
    await expect(detail.swissRound(eventId, 2)).toContainText(byedInRoundOne)
    await expect(
      detail.swissRound(eventId, 2),
      `${byedInRoundTwo} is round 2's bye, so no round-2 fixture names them`,
    ).not.toContainText(byedInRoundTwo)
    await expect(
      detail.swissRoundBye(eventId, 2),
      `${byedInRoundTwo} sits round 2 out, so the round should name them as its bye`,
    ).toContainText(byedInRoundTwo)

    // ----- play round 2, and watch the SECOND bye score ---------------------
    // Read the byed entrant's tally before the round is decided, so what is asserted
    // afterwards is the bye's own contribution — one win, no games — rather than a number
    // that happens to be right. The first bye's credit was an absolute (they had played
    // nothing at all); this one is an increment on a real record.
    const beforeRoundTwo = standingOf(
      await readSwissStandings(director, tournamentId, eventId),
      byedInRoundTwo,
    )
    expect(
      await playSwissRound(
        director,
        tournamentId,
        eventId,
        entrants,
        2,
        inStraightGames(earlierRegisteredWins(entrants)),
      ),
      'round 2 is three matches — the byed entrant costs the round a fixture',
    ).toBe(perRound)

    await detail.reload(tournamentId)

    const byedTwoId = idOf.get(byedInRoundTwo)
    if (!byedTwoId) throw new Error(`${byedInRoundTwo} has no standings row`)
    await expect(
      detail.swissStandingWins(eventId, byedTwoId),
      `${byedInRoundTwo} sat round 2 out, so round 2 being decided is worth one win`,
    ).toHaveText(String(beforeRoundTwo.wins + 1))
    await expect(
      detail.swissStandingGamesWon(eventId, byedTwoId),
      `${byedInRoundTwo}'s bye must move no game count`,
    ).toHaveText(String(beforeRoundTwo.gamesWon))

    // ----- round 3 is paired, and the bye moves a THIRD time -----------------
    const afterRoundTwo = await readSwissRounds(director, tournamentId, eventId)
    const roundThree = afterRoundTwo[2]
    expect(roundThree.round).toBe(ROUNDS)
    expect(roundThree.paired, 'a decided round 2 pairs round 3').toBe(true)
    expect(roundThree.fixtures).toHaveLength(perRound)
    expect(roundThree.satOut, 'exactly one entrant sits round 3 out').toHaveLength(1)
    const byedInRoundThree = roundThree.satOut[0]
    const byes = [byedInRoundOne, byedInRoundTwo, byedInRoundThree]
    expect(
      new Set(byes).size,
      `three rounds byed ${byes.join(', ')} — somebody sat out twice while four ` +
        'entrants have never sat out at all',
    ).toBe(byes.length)

    await expect(detail.swissRoundFixtures(eventId, ROUNDS)).toHaveCount(perRound)
    await expect(
      detail.swissRound(eventId, ROUNDS),
      `${byedInRoundThree} is round 3's bye, so no round-3 fixture names them`,
    ).not.toContainText(byedInRoundThree)
    await expect(
      detail.swissRoundBye(eventId, ROUNDS),
      `${byedInRoundThree} sits round 3 out, so the round should name them as its bye`,
    ).toContainText(byedInRoundThree)

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })

  /**
   * **Swiss standings rank by strength of schedule, not by margin** (ADR "swiss standings
   * add Buchholz, and head-to-head is guarded on having met").
   *
   * Buchholz — the sum of an entrant's opponents' win counts — sits **above** game
   * difference in the chain: wins, head-to-head when the tied pair met, Buchholz, game
   * difference, games won, entry id. Swiss deliberately pairs you against players on your
   * own score, so two entrants level on wins may have faced completely different halves of
   * the field, and margin against unequal opposition says less than who you had to beat.
   *
   * ## The whole test is the fixture
   *
   * An assertion that the table comes out in *some* order proves nothing about Buchholz:
   * for most results Buchholz and game difference agree, and then the standings are the
   * same whether the step exists or not. So `BUCHHOLZ_ROUND_ONE` and `BUCHHOLZ_ROUND_TWO`
   * engineer four entrants level on one win whose two columns point **opposite** ways —
   * `p4` strongest schedule and worst margin, `p5` weakest schedule and joint-best margin —
   * and the claim is that the table reads `p4` first and `p5` last of the four.
   *
   * That the fixture still discriminates is itself asserted, off the **served** standings
   * rather than the written-down table: level on wins, higher Buchholz, *worse* game
   * difference, ranked above. An edit that let the two columns agree again would red here
   * instead of quietly turning this into a test of nothing.
   *
   * ## Six entrants, two rounds, three margins
   *
   * Each constant says why in its own docstring. In short: a field small enough for
   * everybody to play everybody makes Buchholz constant across a tie by arithmetic; two
   * rounds is as far as the pairing can be *predicted* rather than observed; and three
   * distinct round-1 margins are what make the round-1 order — and so round 2's pairing —
   * fall out of game difference rather than out of the entry-id tiebreak.
   *
   * ## And the figure itself, not merely the order
   *
   * A wrong number in the right order is still wrong, so every rendered cell of every row
   * is pinned: rank, player, W, L, **Buc**, Diff, GW. The `Buc` column's *position* is
   * pinned too (`SWISS_STANDINGS_COLUMNS`) — it was inserted between `L` and `Diff`, which
   * moved `GW` and silently turned a "games won" assertion into a game-difference one.
   */
  test('swiss standings rank two entrants level on wins by Buchholz, above game difference', async ({
    page,
    baseURL,
  }) => {
    // Six minted guests, six director-entries, a real cut, a real go-live and two rounds —
    // six matches — played out over the API, on top of the ordinary page work.
    test.setTimeout(420_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    const name = `Swiss Buchholz ${faker.string.alphanumeric(8)}`
    const { tournamentId } = await createTournament(director, name)

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    const eventId = await authorSwissEvent(
      page,
      detail,
      director,
      tournamentId,
      BUCHHOLZ_ROUNDS,
    )

    await detail.publishTournament()
    await expect(detail.startButton).toBeVisible()

    const entrants = await seedEntrants(
      director,
      baseURL!,
      tournamentId,
      eventId,
      BUCHHOLZ_FIELD,
    )
    const filled = await findEventByName(director, tournamentId, EVENT_NAME)
    expect(filled.entered).toBe(BUCHHOLZ_FIELD)

    await detail.reload(tournamentId)
    await cutTheDraw(page, detail)

    // The cut deals round 1 top half against bottom half, which is the pairing
    // `BUCHHOLZ_ROUND_ONE` is written against. Asserted before a ball is hit, so a
    // different seeding fails here rather than as a standings table nobody can explain.
    await expect(detail.swissRoundFixtures(eventId, 1)).toHaveText(
      roundOneLines(entrants),
    )

    await goLive(page, detail)

    // ----- two rounds, to plan -----------------------------------------------
    const perRound = BUCHHOLZ_FIELD / 2
    expect(
      await playSwissRound(
        director,
        tournamentId,
        eventId,
        entrants,
        1,
        asPlanned(BUCHHOLZ_ROUND_ONE, entrants),
      ),
    ).toBe(perRound)

    await detail.reload(tournamentId)
    await expect(detail.swissRoundFixtures(eventId, 2)).toHaveCount(perRound)

    expect(
      await playSwissRound(
        director,
        tournamentId,
        eventId,
        entrants,
        2,
        // `asPlanned` refuses a pairing this plan does not name, so this call is also the
        // assertion that round 2 was paired the way the fixture derived it would be.
        asPlanned(BUCHHOLZ_ROUND_TWO, entrants),
      ),
    ).toBe(perRound)

    await detail.reload(tournamentId)

    // ----- the fixture DISCRIMINATES, off the served standings ---------------
    // Before reading the order, establish that reading it is worth anything: the two
    // entrants the claim rests on are level on wins and their two tiebreak columns
    // disagree. Taken from the server, so this cannot agree with the written-down table
    // by construction.
    const served = await readSwissStandings(director, tournamentId, eventId)
    const stronger = standingOf(served, entrants[STRONGER_SCHEDULE].username)
    const weaker = standingOf(served, entrants[BETTER_MARGIN].username)
    expect(
      stronger.wins,
      `${stronger.username} and ${weaker.username} must be LEVEL ON WINS for Buchholz ` +
        'to be what separates them',
    ).toBe(weaker.wins)
    expect(
      stronger.buchholz,
      `${stronger.username} must have faced the stronger schedule`,
    ).toBeGreaterThan(weaker.buchholz)
    expect(
      stronger.gameDifference,
      `${stronger.username} must have the WORSE game difference — with the two columns ` +
        'agreeing, this table would come out the same with no Buchholz step at all',
    ).toBeLessThan(weaker.gameDifference)

    // …and the entrant with the stronger schedule ranks above the one with the better
    // margin. This is the sentence the chore is about.
    expect(
      stronger.rank,
      `${stronger.username} (Buchholz ${stronger.buchholz}, difference ` +
        `${stronger.gameDifference}) must rank above ${weaker.username} (Buchholz ` +
        `${weaker.buchholz}, difference ${weaker.gameDifference})`,
    ).toBeLessThan(weaker.rank)

    // ----- the whole table, in order, off the page ---------------------------
    // The column positions the cell accessors read, verified against the headers on
    // screen: an inserted column would otherwise move every number one place and be read
    // as a wrong value rather than as a wrong index.
    for (const column of Object.values(SWISS_STANDINGS_COLUMNS)) {
      await expect(detail.swissStandingsHeader(eventId, column)).toHaveAccessibleName(
        column.name,
      )
    }

    const expectedOrder = BUCHHOLZ_STANDINGS.map(
      (row) => entrants[row.player].username,
    )
    expect(
      served.map((row) => row.username),
      'the served finishing order',
    ).toEqual(expectedOrder)

    await expect(detail.swissStandingsRows(eventId)).toHaveCount(BUCHHOLZ_FIELD)
    for (const [index, expected] of BUCHHOLZ_STANDINGS.entries()) {
      const username = entrants[expected.player].username
      const entryId = standingOf(served, username).entryId
      // The row in the position the fixture says it holds, keyed by the server-minted
      // entry id — so this pins the order on screen, not just that the row exists.
      await expect(detail.swissStandingsRows(eventId).nth(index)).toHaveAttribute(
        'data-testid',
        `standing-row-${entryId}`,
      )
      // …and every cell of it, Buchholz included.
      await expect(
        detail.swissStandingCells(eventId, entryId),
        `${username}'s standings line`,
      ).toHaveText(standingRowText(expected, index + 1, username))
    }

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })
})
