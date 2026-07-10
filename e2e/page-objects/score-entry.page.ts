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

  /** A participant's numeric score input, by their username (its accessible
   * label is `"<username> score"`, see `score-pad-side.tsx`). */
  scoreInput(username: string): Locator {
    return this.page.getByLabel(`${username} score`)
  }

  /** The primary submit button on the edit screen ("Save changes →"). */
  get saveButton(): Locator {
    return this.page.getByRole('button', { name: 'Save changes →' })
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

  /** "Keep saved score" — discards the rejected entry, clearing the notice. */
  get keepSavedButton(): Locator {
    return this.page.getByRole('button', { name: 'Keep saved score' })
  }
}
