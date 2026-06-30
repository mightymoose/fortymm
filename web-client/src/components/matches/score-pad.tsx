import { ScorePadSide } from "./score-pad/score-pad-side";

export interface ScorePadSideModel {
  /** The participant's display name (bare username, no leading `@`). */
  name: string;
  /** Monogram initials, or `null` for a player-less side (ghost avatar). */
  initials: string | null;
  /** The current input value (raw text, taken verbatim). */
  value: string;
  /** Red-flag this field. */
  invalid: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export interface ScorePadProps {
  /** The viewer's side (rendered left). */
  me: ScorePadSideModel;
  /** The opponent side (rendered right). */
  opp: ScorePadSideModel;
  /** The games-won tally shown under the VS divider (e.g. `"1 – 0"`), or null
   * to hide it (single-game matches, where it's always 0–0 and just noise). */
  gamesTally: string | null;
  /** A hard error to surface beneath the inputs (illegal/malformed score, or a
   * server rejection), or null. */
  scoreError: string | null;
  /** Show the lower-severity "enter both scores" hint (exactly one side filled
   * and no harder error to surface). */
  showBothRequired: boolean;
  /** Disable the inputs and actions while a submit is in flight. */
  inputsLocked: boolean;
  // ----- action-row props -----
  /** The supporting copy under the action row. */
  subtitle: string;
  /** The primary submit button label. */
  submitLabel: string;
  /** Whether the primary submit is enabled. */
  canSubmit: boolean;
  onSubmit: () => void;
  /** Optional secondary "Clear" action (the scratchpad edit surface). */
  onClear?: () => void;
  clearDisabled?: boolean;
}

/**
 * The shared two-side score-input form: the `me`/`opp` numeric fields, the VS /
 * games divider, the inline error lines, and the submit/clear action row.
 * Presentational and submit-target-agnostic — the parent owns the input state
 * and validation (`validateGameScore`) and supplies the submit callback, so the
 * scratchpad per-game save and the propose-a-result correction flow can share
 * one input UI with different targets and copy.
 */
export const ScorePad = ({
  me,
  opp,
  gamesTally,
  scoreError,
  showBothRequired,
  inputsLocked,
  subtitle,
  submitLabel,
  canSubmit,
  onSubmit,
  onClear,
  clearDisabled,
}: ScorePadProps) => {
  return (
    <>
      <div className="single-entry">
        <ScorePadSide
          side="me"
          name={me.name}
          initials={me.initials}
          value={me.value}
          inputRef={me.inputRef}
          autoFocus={me.autoFocus}
          disabled={inputsLocked}
          invalid={me.invalid}
          onChange={me.onChange}
          onKeyDown={me.onKeyDown}
        />

        <div className="se-mid">
          <div className="se-vs">VS</div>
          {/* Single-game matches: the games tally is always 0–0 until the one
              game finalizes, so it's noise — drop it (#bridge-cse). */}
          {gamesTally !== null && <div className="se-games">{gamesTally}</div>}
        </div>

        <ScorePadSide
          side="opp"
          name={opp.name}
          initials={opp.initials}
          value={opp.value}
          inputRef={opp.inputRef}
          disabled={inputsLocked}
          invalid={opp.invalid}
          onChange={opp.onChange}
          onKeyDown={opp.onKeyDown}
        />
      </div>

      {scoreError !== null && (
        <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
          {scoreError}
        </p>
      )}
      {showBothRequired && (
        <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
          Enter both scores to save this game.
        </p>
      )}

      <div className="single-actions">
        <div className="result-line subtle">{subtitle}</div>
        <div className="action-btns">
          {onClear && (
            <button
              type="button"
              className="btn ghost"
              onClick={onClear}
              disabled={inputsLocked || clearDisabled}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={!canSubmit || inputsLocked}
            // Don't let tapping Save blur the active input: on mobile that
            // dismisses the soft keyboard before the synchronous navigation
            // can hand focus to the next game's input, closing the keyboard
            // between games (#567). Preventing the mousedown default keeps
            // focus on the input through the tap; the click still fires.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onSubmit}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </>
  );
};
