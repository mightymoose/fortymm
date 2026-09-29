"""The payment-status display mapping — a leaf module with no service-layer
imports, so both ``app.tournament_checkouts`` (the checkout read embeds a
payment's state) and ``app.tournament_payments`` (the payment read/reconcile)
can depend on it without a cycle."""

from typing import assert_never

from app.models import TournamentPaymentLineOutcome, TournamentPaymentStatus
from app.schemas.tournament_checkout import TournamentCheckoutPaymentState
from app.schemas.tournament_payment import PaymentLineOutcome

#: A payment in one of these states will never change again — reconcile is a
#: no-op once reached (the exactly-once guarantee for the payment as a whole;
#: exactly-once PER LINE is separately enforced by each line's own ``outcome``).
TERMINAL_PAYMENT_STATUSES = frozenset(
    {
        TournamentPaymentStatus.succeeded,
        TournamentPaymentStatus.failed,
        TournamentPaymentStatus.cancelled,
        TournamentPaymentStatus.quarantined,
    }
)


def payment_display_state(
    status: TournamentPaymentStatus,
) -> TournamentCheckoutPaymentState:
    """The exhaustive, one-place mapping from Fortymm's internal payment
    lifecycle down to the 9 API-facing states (#1816, #1809).
    ``cancel_requested`` is internal-only — the director's action is
    irreversible from the player's point of view, so it folds onto
    ``cancelled`` rather than adding a tenth public state. ``quarantined``
    reports the dedicated public ``needs_review`` state (#1809): a
    quarantined payment is shown to the player in a neutral tone with the
    support reference, never lumped in with an ordinary decline/failure.
    """
    match status:
        case TournamentPaymentStatus.preparing:
            return TournamentCheckoutPaymentState.preparing
        case TournamentPaymentStatus.ready:
            return TournamentCheckoutPaymentState.ready
        case TournamentPaymentStatus.checking:
            return TournamentCheckoutPaymentState.checking
        case TournamentPaymentStatus.action_required:
            return TournamentCheckoutPaymentState.action_required
        case TournamentPaymentStatus.succeeded:
            return TournamentCheckoutPaymentState.succeeded
        case TournamentPaymentStatus.failed:
            return TournamentCheckoutPaymentState.failed
        case TournamentPaymentStatus.expired:
            return TournamentCheckoutPaymentState.expired
        case (
            TournamentPaymentStatus.cancelled | TournamentPaymentStatus.cancel_requested
        ):
            return TournamentCheckoutPaymentState.cancelled
        case TournamentPaymentStatus.quarantined:
            return TournamentCheckoutPaymentState.needs_review
        case _:
            assert_never(status)


def payment_line_outcome_state(
    outcome: TournamentPaymentLineOutcome,
) -> PaymentLineOutcome:
    """The exhaustive, one-place mapping from a payment line's internal
    outcome to the public per-event result (#1809). Never exposes a refund
    REASON code — only that the line is (or is not yet, or will never be)
    admitted."""
    match outcome:
        case TournamentPaymentLineOutcome.pending:
            return PaymentLineOutcome.pending
        case TournamentPaymentLineOutcome.admitted:
            return PaymentLineOutcome.admitted
        case TournamentPaymentLineOutcome.refund_due:
            return PaymentLineOutcome.refund_pending
        case _:
            assert_never(outcome)
