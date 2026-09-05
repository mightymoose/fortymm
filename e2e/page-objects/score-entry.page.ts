import { Locator, Page } from '@playwright/test'

/**
 * The per-game score-entry surface (`/matches/$id/games/$n/scores/edit`) —
 * scoped to what the 409-conflict spec drives: the two numeric score inputs
 * (labelled `"<username> score"`), the primary Save button, and the
 * `ScoreConflictNotice` an out-from-under-you save raises.
 *
 * Raw selectors stay here; the spec reads intent-named locators.
 */
export class ScoreEntryPage {
  constructor(private readonly page: Page) {}

  /** Open a game's *edit* screen (an existing score), returning the instance. */
  static async navigateToEdit(
    page: Page,
    matchId: string,
    gameNumber: number,
  ): Promise<ScoreEntryPage> {
    await page.goto(`/matches/${matchId}/games/${gameNumber}/scores/edit`)
    return new ScoreEntryPage(page)
  }

  /** Open a game's *new* screen (no score yet) — how the winner of a freshly
   * materialized tournament match records its result. */
  static async navigateToNew(
    page: Page,
    matchId: string,
    gameNumber: number,
  ): Promise<ScoreEntryPage> {
    await page.goto(`/matches/${matchId}/games/${gameNumber}/scores/new`)
    return new ScoreEntryPage(page)
  }

  /** The submit button once the typed board decides the match: it swaps to
   * finalize. On an **unrated** match this is "Finalize result" (an immediate
   * self-accept), on a rated one "Post result" — matched loosely to cover both. */
  get finalizeButton(): Locator {
    return this.page.getByRole('button', {
      name: /Finalize result|Post result/,
    })
  }

  /** A participant's numeric score input, by their username (its accessible
   * label is `"<username> score"`, see `score-pad-side.tsx`). */
  scoreInput(username: string): Locator {
    return this.page.getByLabel(`${username} score`)
  }

  /** The primary submit button on the edit screen ("Save changes →"). Matched
   * loosely so a cosmetic tweak to the arrow doesn't red the test. */
  get saveButton(): Locator {
    return this.page.getByRole('button', { name: /Save changes/ })
  }

  get saveNextButton(): Locator {
    return this.page.getByRole('button', { name: /Save game & next/ })
  }

  failedGameLink(gameNumber: number): Locator {
    return this.page.getByRole('link', {
      name: new RegExp(`Game ${gameNumber} didn't save,`),
    })
  }

  savedGameLink(gameNumber: number): Locator {
    return this.page.getByRole('link', {
      name: new RegExp(`Game ${gameNumber}, saved,`),
    })
  }

  /** The in-page conflict notice raised when this game's save 409'd because a
   * concurrent participant already committed a different score. Only rendered
   * on the conflicted game's own edit screen. */
  get conflictNotice(): Locator {
    return this.page.getByRole('alert').filter({
      hasText: 'This game was saved by someone else.',
    })
  }

  /** The list-level conflict-review banner that surfaces on the *next* game
   * after a fire-and-forget save 409'd in the background — it routes back to
   * the conflicted game rather than showing the notice inline. */
  conflictReviewBanner(gameNumber: number): Locator {
    return this.page.getByRole('alert').filter({
      hasText: `Game ${gameNumber} was saved by someone else.`,
    })
  }

  /** "Review game N" — hops back to that game's edit screen (where the in-page
   * conflict notice lives). */
  reviewGameButton(gameNumber: number): Locator {
    return this.page.getByRole('button', { name: `Review game ${gameNumber}` })
  }

  /** "Replace with my score" — re-fires the save against the now-fresh version,
   * deliberately overwriting the committed score. */
  get replaceButton(): Locator {
    return this.page.getByRole('button', { name: 'Replace with my score' })
  }

  /** "Keep saved score" — the other way out of the conflict notice: drop the
   * viewer's own entry and adopt the committed one. */
  get keepSavedButton(): Locator {
    return this.page.getByRole('button', { name: 'Keep saved score' })
  }

  /** The screen's heading — `Enter game N score.` / `Edit game N score.` — which
   * names the game the inputs are for. */
  get heading(): Locator {
    return this.page.getByRole('heading', {
      name: /(Enter|Edit) game \d+ score\./,
    })
  }

  /** The boundary refusal (`Can't enter a score here`) with the API's own reason
   * as its description — what a participant sees on a game they may not score
   * (the match is over, or an earlier game is still unsaved). */
  get refusal(): Locator {
    return this.page
      .getByRole('alert')
      .filter({ hasText: "Can't enter a score here" })
  }
}
