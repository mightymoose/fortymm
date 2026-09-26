"""The payment-status display mapping — a leaf module with no service-layer
imports, so both ``app.tournament_checkouts`` (the checkout read embeds a
payment's state) and ``app.tournament_payments`` (the payment read/reconcile)
can depend on it without a cycle."""

from typing import assert_never

from app.models import TournamentPaymentStatus
from app.schemas.tournament_checkout import TournamentCheckoutPaymentState

#: A payment in one of these states will never change again — reconcile is a
#: no-op once reached (the exactly-once guarantee for the payment as a whole;
#: exactly-once PER LINE is separately enforced by each line's own ``outcome``).
TERMINAL_PAYMENT_STATUSES = frozenset(
    {
        TournamentPaymentStatus.succeeded,
        TournamentPaymentStatus.canceled,
        TournamentPaymentStatus.quarantined,
    }
)


def payment_display_state(
    status: TournamentPaymentStatus,
) -> TournamentCheckoutPaymentState:
    """The exhaustive, one-place mapping from Fortymm's internal payment
    lifecycle down to the 8 API-facing states (#1816). ``cancel_requested``
    and ``quarantined`` are internal-only — the director's action and a
    quarantine are both irreversible from the player's point of view, so they
    fold onto ``canceled``/``failed`` rather than adding a ninth public state.
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
            TournamentPaymentStatus.canceled | TournamentPaymentStatus.cancel_requested
        ):
            return TournamentCheckoutPaymentState.canceled
        case TournamentPaymentStatus.quarantined:
            return TournamentCheckoutPaymentState.failed
        case _:
            assert_never(status)
