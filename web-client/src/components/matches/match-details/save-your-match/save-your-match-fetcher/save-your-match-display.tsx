import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { deriveEmailStatus, useSession } from "@/api/session";
import { fmtDate } from "@/lib/dates";
import { cn } from "@/lib/utils";

import { type SaveYourMatchView } from "./save-your-match-query";

// Per-match key. Dismissing on one finalized match doesn't quiet the prompt
// on the next — a guest with multiple matches still gets the nudge once per
// result they care about.
const DISMISS_KEY_PREFIX = "fm.savePromptDismissed.";
const SETTINGS_EMAIL_HASH = "sec-email";

function readDismissed(matchId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DISMISS_KEY_PREFIX + matchId) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(matchId: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.localStorage.setItem(DISMISS_KEY_PREFIX + matchId, "1");
    } else {
      window.localStorage.removeItem(DISMISS_KEY_PREFIX + matchId);
    }
  } catch {
    /* private mode / quota — fail open; better to re-nudge than crash */
  }
}

/** Match score anchor: viewer avatar, game-score blips, opponent avatar, and
 * the match date — the win/loss tones key off the viewer's side. */
function MatchAnchor({ view }: { view: SaveYourMatchView }) {
  // Tri-state, not a forced binary: `leftWon` is null mid-match (incl. a Live
  // 0–0), so we must only paint a winner once a result is actually decided.
  // The old `!iWon` fallthrough unconditionally greened the opponent's side
  // (and avatar) on any undecided match (#386).
  const leftWon = view.leftWon === true;
  const rightWon = view.leftWon === false;
  return (
    <div className="md-save__anchor" aria-label="Match summary">
      <div
        className={cn(
          "md-avatar md-save__avatar",
          leftWon && "md-avatar--win",
          rightWon && "md-avatar--loss",
        )}
      >
        {view.leftInitials}
      </div>
      <div className="md-save__blips">
        <span className={cn("md-save__blip", leftWon && "md-save__blip--win")}>
          {view.leftGamesWon}
        </span>
        <span className="md-save__blip-dash">–</span>
        <span className={cn("md-save__blip", rightWon && "md-save__blip--win")}>
          {view.rightGamesWon}
        </span>
      </div>
      <div
        className={cn(
          "md-avatar md-save__avatar",
          rightWon && "md-avatar--win",
          leftWon && "md-avatar--loss",
        )}
      >
        {view.rightInitials}
      </div>
      <span className="md-save__date">
        {fmtDate(view.createdAt).toUpperCase()}
      </span>
    </div>
  );
}

/** The quiet "save later" receipt shown for the rest of the session after a
 * "Not now" dismissal. */
function DismissedReceipt() {
  // The receipt sticks around for the rest of the session after "Not now",
  // so the user has a recoverable affordance without a re-nudge. "Save it"
  // routes straight to the email flow — the label promises a commit, not an
  // undo, so we navigate rather than restore the prompt.
  return (
    <div
      className="md-save-receipt"
      role="status"
      aria-label="Match save receipt"
    >
      <span aria-hidden="true">—</span>
      <span>
        This match lives on your device only.{" "}
        <Link
          to="/settings"
          hash={SETTINGS_EMAIL_HASH}
          className="md-save-receipt__undo"
        >
          Save it
        </Link>{" "}
        to keep it.
      </span>
    </div>
  );
}

export interface SaveYourMatchDisplayProps {
  view: SaveYourMatchView;
  matchId: string;
}

/** The guest "save this match" nudge once the query has confirmed it applies.
 * Reads the session to gate on guest status (a verified user never sees it),
 * and owns the per-match dismissal: "Not now" swaps in a quiet receipt for the
 * rest of the session and is remembered across revisits via localStorage. */
export function SaveYourMatchDisplay({
  view,
  matchId,
}: SaveYourMatchDisplayProps) {
  const { data: session } = useSession();

  // 'cold' = dismissed on a prior visit (read from localStorage). We hide
  // entirely in that case — the brief is explicit: don't badger on revisit.
  // 'session' = dismissed in this session — we swap in a quiet receipt so the
  // user can still find their way back to the email flow without a re-nudge.
  const [dismissed, setDismissed] = useState<"cold" | "session" | false>(() =>
    readDismissed(matchId) ? "cold" : false,
  );

  const user = session?.data.user;
  if (!user) return null;
  // Reuse the canonical guest/pending/verified split from /settings so this
  // prompt and the topbar UserMenu agree on who counts as a guest (e.g. a
  // user with `pending_email` is no longer "guest", they're "pending").
  const isGuest =
    deriveEmailStatus({
      email: user.email ?? null,
      confirmedAt: user.confirmed_at ?? null,
      pendingEmail: user.pending_email ?? null,
    }) === "guest";
  if (!isGuest) return null;

  if (dismissed === "cold") return null;
  if (dismissed === "session") return <DismissedReceipt />;

  const handleDismiss = () => {
    writeDismissed(matchId, true);
    setDismissed("session");
  };

  return (
    <section
      className={cn("md-save", view.canConfirm && "md-save--soft")}
      aria-label="Save this match"
    >
      <div className="md-save__hd">
        <div className="md-save__kicker">
          <span className="ball-dot" aria-hidden="true" /> Nice match
        </div>
        <MatchAnchor view={view} />
      </div>

      <div>
        <h3 className="md-save__headline">
          Let&rsquo;s make sure this one sticks around.
        </h3>
        <p className="md-save__body">
          Add an email and your rating and rivalry with {view.rightUsername} are
          saved across devices. Right now, clearing cookies erases this match.
        </p>
      </div>

      <div className="md-save__actions">
        <Link
          to="/settings"
          hash={SETTINGS_EMAIL_HASH}
          className="md-btn md-btn--primary"
        >
          Save this match
          <ChevronRight size={14} />
        </Link>
        <button
          type="button"
          className="md-btn md-btn--ghost"
          onClick={handleDismiss}
        >
          Not now
        </button>
        <span className="md-save__hint">TAKES 20s · EMAIL ONLY</span>
      </div>
    </section>
  );
}
