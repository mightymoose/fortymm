"""Transport-neutral Stripe card-payment operations for a tournament checkout.

Three entry points — :func:`prepare_or_resume_payment` (create-or-resume,
the ONLY place the Stripe client secret is returned), :func:`read_payment_status`
(a status read) and the webhook route (``app.tournament_payment_routes``) —
ALL funnel through :func:`reconcile_payment`, the one function that validates a
PaymentIntent against the payment row, quarantines on any mismatch, and admits
each still-pending line exactly once (#1816). See ``api/CLAUDE.md``'s
service-layer conventions and the ticket's planning note for the full design.
"""

import uuid
from typing import Any

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.models import (
    Tournament,
    TournamentCheckout,
    TournamentCheckoutStatus,
    TournamentPayment,
    TournamentPaymentLine,
    TournamentPaymentLineOutcome,
    TournamentPaymentProviderCreateState,
    TournamentPaymentRefundObligation,
    TournamentPaymentRefundReason,
    TournamentPaymentStatus,
    User,
)
from app.payments.provider import (
    PaymentProvider,
    ProviderCreateUncertain,
    ProviderIntentCreated,
    ProviderPaymentIntent,
    ProviderRefused,
    ProviderRetrievalFailed,
    ProviderUnavailable,
)
from app.player_accounts import PlayerAccessDenied
from app.schemas.tournament_checkout import TournamentCheckoutState
from app.schemas.tournament_payment import (
    TournamentPaymentPrepared,
    TournamentPaymentRead,
)
from app.tournament_authority import lock_tournament
from app.tournament_checkouts import checkout_effective_state, database_now
from app.tournament_entries import admit_to_event
from app.tournament_errors import (
    EntryRefusal,
    EntryRefusedError,
    EventNotFoundError,
    NonSinglesEntryError,
    TournamentNotFoundError,
)
from app.tournament_payment_errors import (
    PaymentNotFoundError,
    PaymentNotReadyError,
    PaymentProviderUnavailableError,
)
from app.tournament_payment_state import (
    TERMINAL_PAYMENT_STATUSES,
    payment_display_state,
)

#: An allowlist of safe, player-facing decline codes — never Stripe's raw
#: ``decline_code``/``message`` (#1816's player-facing-errors constraint).
_SAFE_ERROR_CODES = frozenset(
    {
        "card_declined",
        "expired_card",
        "incorrect_cvc",
        "incorrect_number",
        "insufficient_funds",
        "processing_error",
    }
)


def _safe_error_code(raw_code: str | None) -> str | None:
    if raw_code is None:
        return None
    return raw_code if raw_code in _SAFE_ERROR_CODES else "card_error"


def _key_is_live(secret_key: str) -> bool:
    return secret_key.startswith("sk_live_")


#: The six event types #1816 acts on. Every other type is still persisted and
#: acknowledged (evidence trail), then ignored — never rejected.
HANDLED_PROVIDER_EVENT_TYPES = frozenset(
    {
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
        "payment_intent.processing",
        "payment_intent.requires_action",
        "payment_intent.canceled",
        "charge.refunded",
    }
)


class IncomingProviderEvent(BaseModel):
    """The handful of webhook fields reconcile needs to route and pre-check —
    parsed once at the webhook boundary (``app.tournament_payment_routes``)
    from ``stripe.Event.to_dict()``. Deliberately NOT the full PaymentIntent:
    reconcile always re-retrieves that itself, so quarantine's captured amount
    (and every other validated field) comes from Fortymm's own retrieval, never
    from the webhook payload (#1816 constraint)."""

    id: str
    type: str
    livemode: bool
    account: str | None = None
    #: The PaymentIntent id this event is about — ``data.object.id`` for a
    #: ``payment_intent.*`` event, or ``data.object.payment_intent`` for a
    #: ``charge.refunded`` event (whose ``data.object.id`` is a CHARGE id).
    payment_intent_id: str | None = None


def parse_incoming_provider_event(raw: dict[str, Any]) -> IncomingProviderEvent:
    data = raw.get("data")
    data_object = data.get("object") if isinstance(data, dict) else None
    event_type = raw["type"]
    key = "payment_intent" if event_type == "charge.refunded" else "id"
    payment_intent_id = data_object.get(key) if isinstance(data_object, dict) else None
    return IncomingProviderEvent(
        id=raw["id"],
        type=event_type,
        livemode=raw["livemode"],
        account=raw.get("account"),
        payment_intent_id=(
            payment_intent_id if isinstance(payment_intent_id, str) else None
        ),
    )


async def find_payment_id_for_provider_event(
    db: AsyncSession, event: IncomingProviderEvent
) -> uuid.UUID | None:
    """Resolve which payment row an incoming event is about, by the
    PaymentIntent id Fortymm itself stored — never by trusting the webhook's
    own metadata for routing (reconcile re-validates metadata separately,
    against the RETRIEVED intent)."""
    if event.payment_intent_id is None:
        return None
    payment_id: uuid.UUID | None = await db.scalar(
        select(TournamentPayment.id).where(
            TournamentPayment.provider_payment_intent_id == event.payment_intent_id
        )
    )
    return payment_id


def _map_provider_status(
    provider_status: str, *, current: TournamentPaymentStatus
) -> TournamentPaymentStatus:
    """Stripe's raw PaymentIntent status, mapped to Fortymm's own — used for
    every status EXCEPT ``succeeded`` (which only ``_admit`` sets, after this
    module's own validation, never a bare copy of Stripe's word)."""
    if provider_status == "canceled":
        return TournamentPaymentStatus.canceled
    if current is TournamentPaymentStatus.cancel_requested:
        # The director's cancel is authoritative; a non-terminal Stripe status
        # must not un-flag it (only an actual ``canceled`` or a ``succeeded``,
        # which ``_admit`` handles, may move it on).
        return current
    match provider_status:
        case "requires_payment_method" | "requires_confirmation":
            return TournamentPaymentStatus.ready
        case "requires_action":
            return TournamentPaymentStatus.action_required
        case "processing" | "requires_capture":
            return TournamentPaymentStatus.checking
        case _:
            return current


async def _load_checkout_for_payer(
    db: AsyncSession, *, tournament_id: uuid.UUID, checkout_id: uuid.UUID, actor: User
) -> TournamentCheckout:
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
        )
        .options(selectinload(TournamentCheckout.lines))
    )
    if checkout is None or checkout.payer_account_id != actor.id:
        raise PaymentNotFoundError()
    return checkout


def _can_view_payment(payment: TournamentPayment, actor: User) -> bool:
    merchant_account_id = get_settings().tournament_payment_merchant_account_id
    return payment.payer_account_id == actor.id or (
        merchant_account_id is not None and merchant_account_id == actor.id
    )


def _to_read_schema(payment: TournamentPayment) -> TournamentPaymentRead:
    return TournamentPaymentRead(
        id=payment.id,
        checkout_id=payment.checkout_id,
        reference=payment.reference,
        status=payment_display_state(payment.status),
        last_error=payment.last_error_code,
        amount_cents=payment.amount_cents,
        currency=payment.currency,
        created_at=payment.created_at,
    )


#: The states in which the payer can still act on the PaymentIntent in the
#: browser. Only these get the client secret on a resume.
_PAYER_ACTIONABLE_STATUSES = frozenset(
    {TournamentPaymentStatus.ready, TournamentPaymentStatus.action_required}
)


async def _lock_payment(
    db: AsyncSession, payment_id: uuid.UUID
) -> TournamentPayment | None:
    payment: TournamentPayment | None = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
        .options(selectinload(TournamentPayment.lines))
    )
    return payment


async def _drive_provider_create(
    db: AsyncSession, payment_id: uuid.UUID, provider: PaymentProvider
) -> tuple[TournamentPayment, str | None]:
    """Create the PaymentIntent under the payment's durable idempotency key.

    A repeat after an uncertain outcome replays the SAME key, so Stripe returns
    the PaymentIntent it already made rather than a second one. The payment
    row lock is held across the call so two prepares cannot race each other.
    No capacity lock is held here.
    """
    payment = await _lock_payment(db, payment_id)
    assert payment is not None
    if payment.provider_create_state is TournamentPaymentProviderCreateState.created:
        await db.commit()
        return payment, None
    client_secret: str | None = None
    outcome = await provider.create_payment_intent(
        payee_account=payment.payee_stripe_account,
        amount_cents=payment.amount_cents,
        currency=payment.currency.lower(),
        idempotency_key=payment.idempotency_key,
        metadata={"payment_id": str(payment.id)},
        statement_descriptor_suffix=f"FORTYMM{len(payment.lines)}",
    )
    match outcome:
        case ProviderIntentCreated(intent=intent):
            payment.provider_create_state = TournamentPaymentProviderCreateState.created
            payment.provider_payment_intent_id = intent.id
            payment.status = _map_provider_status(intent.status, current=payment.status)
            client_secret = intent.client_secret
        case ProviderCreateUncertain():
            payment.status = TournamentPaymentStatus.preparing
    await db.commit()
    return payment, client_secret


async def _create_payment_row(
    db: AsyncSession, checkout: TournamentCheckout, actor: User
) -> uuid.UUID:
    """Commit the provider-create obligation before any Stripe call (#1816).

    Two concurrent first prepares for one checkout both reach the insert. The
    unique checkout constraint lets exactly one win, and the loser reuses the
    winner's row instead of answering with a 500.
    """
    merchant_account_id = get_settings().tournament_payment_merchant_account_id
    if merchant_account_id is None:
        raise PaymentNotReadyError()
    payment = TournamentPayment(
        checkout_id=checkout.id,
        payer_account_id=actor.id,
        tournament_id=checkout.tournament_id,
        payee_stripe_account=None,
        payee_fortymm_account_id=merchant_account_id,
        idempotency_key=f"tournament-payment:{checkout.id}",
        amount_cents=checkout.total_cents,
        currency=checkout.currency,
        provider_create_state=TournamentPaymentProviderCreateState.committed,
        lines=[
            TournamentPaymentLine(event_id=line.event_id, price_cents=line.price_cents)
            for line in checkout.lines
        ],
    )
    db.add(payment)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing: uuid.UUID | None = await db.scalar(
            select(TournamentPayment.id).where(
                TournamentPayment.checkout_id == checkout.id
            )
        )
        if existing is None:
            raise
        return existing
    return payment.id


async def _reconcile_or_keep(
    db: AsyncSession, payment: TournamentPayment, provider: PaymentProvider
) -> TournamentPayment:
    """Reconcile for a read. If Stripe cannot be reached, keep the last known
    state instead of failing the read."""
    try:
        reconciled = await reconcile_payment(
            db, payment_id=payment.id, provider=provider
        )
    except PaymentProviderUnavailableError:
        return payment
    return reconciled if reconciled is not None else payment


async def prepare_or_resume_payment(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    provider: PaymentProvider,
) -> TournamentPaymentPrepared:
    """Create the checkout's PaymentIntent, or resume it if one already
    exists. The ONLY operation that returns the Stripe client secret, and only
    while the payer can still act on the PaymentIntent."""
    checkout = await _load_checkout_for_payer(
        db, tournament_id=tournament_id, checkout_id=checkout_id, actor=actor
    )
    if checkout.status is not TournamentCheckoutStatus.active:
        raise PaymentNotReadyError()

    payment_id: uuid.UUID | None = await db.scalar(
        select(TournamentPayment.id).where(TournamentPayment.checkout_id == checkout.id)
    )
    if payment_id is None:
        # A NEW charge needs a live quote. An expired or superseded hold can
        # still finish a payment that already exists (a late success), but it
        # never starts one.
        tournament = await db.get(Tournament, tournament_id)
        if (
            tournament is None
            or checkout_effective_state(checkout, tournament, await database_now(db))
            is not TournamentCheckoutState.active
        ):
            raise PaymentNotReadyError()
        payment_id = await _create_payment_row(db, checkout, actor)

    payment, client_secret = await _drive_provider_create(db, payment_id, provider)
    if payment.payer_account_id != actor.id:
        raise PaymentNotFoundError()
    if client_secret is None and payment.provider_payment_intent_id is not None:
        # Resume: bring the state up to date, then hand back the secret only
        # while the payer can still act on the PaymentIntent.
        payment = await _reconcile_or_keep(db, payment, provider)
        intent_id = payment.provider_payment_intent_id
        if intent_id is not None and payment.status in _PAYER_ACTIONABLE_STATUSES:
            try:
                intent = await provider.retrieve_payment_intent(
                    payee_account=payment.payee_stripe_account,
                    payment_intent_id=intent_id,
                )
                client_secret = intent.client_secret
            except ProviderRetrievalFailed:
                client_secret = None

    return TournamentPaymentPrepared(
        **_to_read_schema(payment).model_dump(), client_secret=client_secret
    )


async def read_payment_status(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    provider: PaymentProvider,
) -> TournamentPaymentRead:
    """Read a payment's status after reconciling it against Stripe.

    A payment still ``preparing`` after an uncertain create replays the create
    under the same idempotency key, so it does not stay stuck while nobody
    runs a background job (#1816). If Stripe cannot be reached, the read
    answers with the last known state and changes nothing.
    """
    checkout = await db.scalar(
        select(TournamentCheckout).where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
        )
    )
    if checkout is None:
        raise PaymentNotFoundError()
    payment = await db.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout.id)
    )
    if payment is None or not _can_view_payment(payment, actor):
        raise PaymentNotFoundError()

    if payment.status not in TERMINAL_PAYMENT_STATUSES:
        if (
            payment.provider_create_state
            is not TournamentPaymentProviderCreateState.created
        ):
            payment, _ = await _drive_provider_create(db, payment.id, provider)
        if payment.provider_payment_intent_id is not None:
            payment = await _reconcile_or_keep(db, payment, provider)
    return _to_read_schema(payment)


#: The refusals that mean "this line cannot admit", so the paid line becomes a
#: refund obligation instead of an error that would leave the payment stuck.
_LINE_REFUSALS = (
    EntryRefusedError,
    EventNotFoundError,
    NonSinglesEntryError,
    PlayerAccessDenied,
    TournamentNotFoundError,
)


def _record_line_refund(
    db: AsyncSession,
    payment: TournamentPayment,
    line: TournamentPaymentLine,
    reason: TournamentPaymentRefundReason,
) -> None:
    line.outcome = TournamentPaymentLineOutcome.refund_due
    db.add(
        TournamentPaymentRefundObligation(
            payment_id=payment.id,
            event_id=line.event_id,
            amount_cents=line.price_cents,
            reason=reason,
        )
    )


async def _admit(db: AsyncSession, payment: TournamentPayment) -> None:
    """Convert each still-pending line into a registration exactly once, or a
    refund obligation when it cannot admit (#1816). The caller holds the
    tournament lock and the payment row lock, and no Stripe call runs here.

    Expiry alone does not forfeit a paid line: ``admit_to_event`` rechecks the
    registration window, eligibility and capacity. A cancelled checkout (the
    player's cancellation, which is also how a selection is replaced) or a
    registration window that changed since the quote stays permanent, so a
    late success refunds every line instead of reversing that decision.
    """
    payer = await db.get(User, payment.payer_account_id)
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(TournamentCheckout.id == payment.checkout_id)
        .with_for_update()
    )
    tournament = await db.get(Tournament, payment.tournament_id)
    superseded = (
        payer is None
        or checkout is None
        or tournament is None
        or checkout.status is TournamentCheckoutStatus.cancelled
        or checkout.registration_generation != tournament.registration_generation
    )
    if checkout is not None and checkout.status in (
        TournamentCheckoutStatus.active,
        TournamentCheckoutStatus.expired,
    ):
        # Consume the hold. A completed checkout no longer counts toward
        # capacity, so the payer's own hold cannot block its own admission.
        checkout.status = TournamentCheckoutStatus.completed
    for line in payment.lines:
        if line.outcome is not TournamentPaymentLineOutcome.pending:
            continue
        if superseded or payer is None:
            _record_line_refund(
                db, payment, line, TournamentPaymentRefundReason.checkout_superseded
            )
            continue
        try:
            entrant = await admit_to_event(
                db,
                tournament_id=payment.tournament_id,
                event_id=line.event_id,
                actor=payer,
                user_id=None,
                client_ip=None,
                payment_authorized=True,
            )
        except _LINE_REFUSALS as refusal:
            already_entered = (
                isinstance(refusal, EntryRefusedError)
                and refusal.refusal is EntryRefusal.already_entered
            )
            _record_line_refund(
                db,
                payment,
                line,
                TournamentPaymentRefundReason.superseded_by_director_entry
                if already_entered
                else TournamentPaymentRefundReason.line_could_not_admit,
            )
        else:
            line.outcome = TournamentPaymentLineOutcome.admitted
            line.entry_id = entrant.id
    payment.status = TournamentPaymentStatus.succeeded


def _quarantine(
    db: AsyncSession, payment: TournamentPayment, *, amount_received: int | None
) -> None:
    """Admit nobody. ``amount_received`` comes from Fortymm's own retrieval,
    and ``None`` means no verified amount exists ("amount unverified")."""
    payment.status = TournamentPaymentStatus.quarantined
    payment.amount_unverified = amount_received is None
    if amount_received:
        db.add(
            TournamentPaymentRefundObligation(
                payment_id=payment.id,
                event_id=None,
                amount_cents=amount_received,
                reason=TournamentPaymentRefundReason.quarantine,
            )
        )


async def reconcile_payment(
    db: AsyncSession,
    *,
    payment_id: uuid.UUID,
    provider: PaymentProvider,
    source_event: IncomingProviderEvent | None = None,
) -> TournamentPayment | None:
    """The one function webhooks, the status read, and prepare/resume ALL
    call. Validation, quarantine and admission live here exactly once, which
    is what makes exactly-once provable (#1816).

    1. Read the payment without a lock and retrieve the PaymentIntent with
       Fortymm's own key. No lock and no transaction is held across the call.
    2. Take the admission lock order: payer Account (shared), Tournament, then
       the payment row. A director entry takes Tournament before it touches
       the payment, so the two paths cannot deadlock, and a webhook racing a
       status read admits once.
    3. Recheck the terminal state under the lock, then validate, and either
       quarantine or apply the provider state.

    Raises :class:`PaymentProviderUnavailableError` when Stripe cannot be
    reached and nothing else is wrong. The payment is then left unchanged.
    """
    snapshot = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .execution_options(populate_existing=True)
    )
    if snapshot is None:
        return None
    if (
        snapshot.status in TERMINAL_PAYMENT_STATUSES
        or snapshot.provider_payment_intent_id is None
    ):
        return snapshot
    payee_account = snapshot.payee_stripe_account
    payment_intent_id = snapshot.provider_payment_intent_id
    payer_account_id = snapshot.payer_account_id
    tournament_id = snapshot.tournament_id
    await db.commit()

    key_is_live = _key_is_live(get_settings().stripe_secret_key)
    event_ok = source_event is None or (
        source_event.account == payee_account and source_event.livemode == key_is_live
    )
    intent: ProviderPaymentIntent | None = None
    try:
        intent = await provider.retrieve_payment_intent(
            payee_account=payee_account, payment_intent_id=payment_intent_id
        )
    except ProviderUnavailable as error:
        if event_ok:
            raise PaymentProviderUnavailableError() from error
    except ProviderRefused:
        pass

    # Full rows, so ``_admit``'s lookups are served from the identity map.
    await db.scalar(
        select(User)
        .where(User.id == payer_account_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    await lock_tournament(db, tournament_id)
    payment = await _lock_payment(db, payment_id)
    if payment is None:
        await db.commit()
        return None
    if payment.status in TERMINAL_PAYMENT_STATUSES:
        await db.commit()
        return payment

    if intent is None:
        # The quarantine retrieval failed, or the PaymentIntent is not on the
        # payee account: no verified captured amount, so no obligation.
        _quarantine(db, payment, amount_received=None)
        await db.commit()
        return payment

    identity_ok = (
        intent.id == payment.provider_payment_intent_id
        and intent.livemode == key_is_live
        and intent.amount == payment.amount_cents
        and intent.currency.upper() == payment.currency
        and intent.metadata_payment_id == str(payment.id)
    )
    if not identity_ok or not event_ok:
        _quarantine(db, payment, amount_received=intent.amount_received)
        await db.commit()
        return payment

    if source_event is not None and source_event.type == "charge.refunded":
        # Evidence-only (#1816): adds to the trail, changes no obligation.
        await db.commit()
        return payment

    if intent.status == "succeeded":
        await _admit(db, payment)
    else:
        payment.status = _map_provider_status(intent.status, current=payment.status)
        if intent.status in ("requires_payment_method", "requires_confirmation"):
            payment.last_error_code = _safe_error_code(intent.last_payment_error_code)
        checkout = await db.get(TournamentCheckout, payment.checkout_id)
        tournament = await db.get(Tournament, payment.tournament_id)
        if (
            checkout is not None
            and tournament is not None
            and payment.status
            in (
                TournamentPaymentStatus.ready,
                TournamentPaymentStatus.checking,
                TournamentPaymentStatus.action_required,
            )
            and checkout_effective_state(checkout, tournament, await database_now(db))
            is not TournamentCheckoutState.active
        ):
            payment.status = TournamentPaymentStatus.expired
    await db.commit()
    return payment


def run_cancel_payment_intent(payment_id: str) -> None:
    """RQ entry point (the ``payments`` queue): best-effort cancel of the
    PaymentIntent for a payment a director entry superseded (#1816). Thin
    wrapper over ``app.rq_async.run_async_db_job``, matching
    ``app.schedule_solves.run_schedule_solve``'s shape."""
    from app.rq_async import run_async_db_job

    run_async_db_job(
        f"payment-cancel-{payment_id}",
        lambda sessionmaker: _execute_cancel(sessionmaker, uuid.UUID(payment_id)),
    )


async def _execute_cancel(
    sessionmaker: async_sessionmaker[AsyncSession], payment_id: uuid.UUID
) -> None:
    from app.payments.dependencies import get_payment_provider

    async with sessionmaker() as db:
        payment = await db.scalar(
            select(TournamentPayment).where(TournamentPayment.id == payment_id)
        )
        if payment is None or payment.provider_payment_intent_id is None:
            return
        if payment.status in TERMINAL_PAYMENT_STATUSES:
            return
        provider = get_payment_provider()
        try:
            await provider.cancel_payment_intent(
                payee_account=payment.payee_stripe_account,
                payment_intent_id=payment.provider_payment_intent_id,
            )
        except ProviderRetrievalFailed:
            # Best-effort (module docstring on ``run_cancel_payment_intent``):
            # if Stripe cannot be reached, or the intent already settled
            # (succeeded/canceled), correctness does not depend on this call
            # succeeding — reconcile's own already-entered path covers it.
            return
