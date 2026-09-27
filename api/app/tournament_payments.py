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
from typing import assert_never

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app import required_repairs
from app.config import Settings, get_settings
from app.db import database_now
from app.models import (
    Tournament,
    TournamentCheckout,
    TournamentCheckoutStatus,
    TournamentPayment,
    TournamentPaymentErrorCode,
    TournamentPaymentLine,
    TournamentPaymentLineOutcome,
    TournamentPaymentProviderEvent,
    TournamentPaymentRefundObligation,
    TournamentPaymentRefundReason,
    TournamentPaymentStatus,
    User,
)
from app.payments.provider import (
    STRIPE_MAX_AMOUNT_CENTS,
    PaymentProvider,
    ProviderCreateUncertain,
    ProviderIntentCreated,
    ProviderIntentStatus,
    ProviderPaymentIntent,
    ProviderRefused,
    ProviderRetrievalFailed,
    ProviderUnavailable,
    ProviderWebhookEvent,
)
from app.player_accounts import PlayerAccessDenied
from app.schemas.tournament_checkout import TournamentCheckoutState
from app.schemas.tournament_payment import (
    TournamentPaymentPrepared,
    TournamentPaymentRead,
)
from app.tournament_authority import lock_tournament
from app.tournament_checkouts import checkout_effective_state
from app.tournament_entries import SettledPayment, admit_to_event
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


def _safe_error_code(
    intent: ProviderPaymentIntent,
) -> TournamentPaymentErrorCode | None:
    """Map Stripe's last payment error onto the safe, player-facing set. Never
    pass Stripe's raw ``decline_code`` or message through (#1816).

    Stripe often reports a decline as the generic ``code: card_declined`` and
    puts the actionable reason, such as ``insufficient_funds``, in
    ``decline_code``. So a ``decline_code`` in the safe set wins, then
    ``code``, and any other error maps to ``card_error``."""
    raw_codes = (intent.last_payment_decline_code, intent.last_payment_error_code)
    if all(raw_code is None for raw_code in raw_codes):
        return None
    for raw_code in raw_codes:
        if raw_code is None:
            continue
        try:
            return TournamentPaymentErrorCode(raw_code)
        except ValueError:
            continue
    return TournamentPaymentErrorCode.card_error


async def record_and_reconcile_provider_event(
    db: AsyncSession,
    *,
    event: ProviderWebhookEvent,
    provider: PaymentProvider,
    settings: Settings,
) -> None:
    """Persist a verified webhook event uniquely, then reconcile its payment.

    A replayed event hits the unique key and changes nothing. If Stripe cannot
    be reached, the event row is removed again and
    :class:`PaymentProviderUnavailableError` propagates, so the caller does
    not acknowledge it and Stripe's retry reprocesses it.
    """
    payment_id = await find_payment_id_for_provider_event(db, event)
    result = await db.execute(
        pg_insert(TournamentPaymentProviderEvent)
        .values(
            provider_event_id=event.id,
            event_type=event.type,
            payment_id=payment_id,
            payload=event.evidence(),
        )
        .on_conflict_do_nothing(index_elements=["provider_event_id"])
        .returning(TournamentPaymentProviderEvent.id)
    )
    newly_inserted = result.first() is not None
    await db.commit()
    if payment_id is None or not event.is_handled:
        return
    # A replay reconciles again. If the process died, or reconcile raised,
    # after the event row committed, Stripe's retry is the only thing left to
    # finish the payment. Reconcile is idempotent: a terminal payment returns
    # at once, and each line admits or refunds exactly once.
    try:
        await reconcile_payment(
            db,
            payment_id=payment_id,
            provider=provider,
            settings=settings,
            source_event=event,
        )
    except PaymentProviderUnavailableError:
        await db.rollback()
        if newly_inserted:
            await db.execute(
                delete(TournamentPaymentProviderEvent).where(
                    TournamentPaymentProviderEvent.provider_event_id == event.id
                )
            )
            await db.commit()
        raise


async def find_payment_id_for_provider_event(
    db: AsyncSession, event: ProviderWebhookEvent
) -> uuid.UUID | None:
    """Resolve which payment row an incoming event is about, by the
    PaymentIntent id Fortymm itself stored — never by trusting the webhook's
    own metadata for routing (reconcile re-validates metadata separately,
    against the RETRIEVED intent)."""
    payment_intent_id = event.payment_intent_id
    if payment_intent_id is None:
        return None
    payment_id: uuid.UUID | None = await db.scalar(
        select(TournamentPayment.id).where(
            TournamentPayment.provider_payment_intent_id == payment_intent_id
        )
    )
    return payment_id


def _map_provider_status(
    provider_status: ProviderIntentStatus, *, current: TournamentPaymentStatus
) -> TournamentPaymentStatus:
    """Stripe's PaymentIntent status, mapped to Fortymm's own. ``succeeded``
    keeps the current status: only ``_admit`` sets ``succeeded``, after this
    module's own validation, never as a bare copy of Stripe's word."""
    if (
        current is TournamentPaymentStatus.cancel_requested
        and provider_status is not ProviderIntentStatus.CANCELED
    ):
        # The director's cancel is authoritative. A non-terminal Stripe status
        # must not un-flag it. Only an actual ``canceled``, or a ``succeeded``
        # that ``_admit`` handles, moves it on.
        return current
    match provider_status:
        case (
            ProviderIntentStatus.REQUIRES_PAYMENT_METHOD
            | ProviderIntentStatus.REQUIRES_CONFIRMATION
        ):
            return TournamentPaymentStatus.ready
        case ProviderIntentStatus.REQUIRES_ACTION:
            return TournamentPaymentStatus.action_required
        case ProviderIntentStatus.PROCESSING | ProviderIntentStatus.REQUIRES_CAPTURE:
            return TournamentPaymentStatus.checking
        case ProviderIntentStatus.CANCELED:
            return TournamentPaymentStatus.cancelled
        case ProviderIntentStatus.SUCCEEDED:
            return current
        case _:
            assert_never(provider_status)


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
    """The payer, or the merchant account that held financial authority when
    the payment was created. Bound to the payment's own snapshot, so a later
    change of ``TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID`` neither grants the new
    account old payments nor removes them from the account that owns them."""
    return actor.id in (payment.payer_account_id, payment.payee_fortymm_account_id)


def _to_read_schema(payment: TournamentPayment) -> TournamentPaymentRead:
    return TournamentPaymentRead(
        id=payment.id,
        checkout_id=payment.checkout_id,
        reference=payment.reference,
        payment_state=payment_display_state(payment.status),
        last_error_code=payment.last_error_code,
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


def _intent_matches_payment(
    intent: ProviderPaymentIntent, payment: TournamentPayment, *, key_is_live: bool
) -> bool:
    """The identity checks every PaymentIntent must pass before Fortymm uses
    it: the id Fortymm stored, the key's mode, the amount and currency on the
    row, and the metadata ``payment_id`` Fortymm set."""
    return (
        intent.id == payment.provider_payment_intent_id
        and intent.livemode == key_is_live
        and intent.amount == payment.amount_cents
        and intent.currency.upper() == payment.currency
        and intent.metadata_payment_id == str(payment.id)
    )


async def _drive_provider_create(
    db: AsyncSession,
    payment_id: uuid.UUID,
    provider: PaymentProvider,
    settings: Settings,
) -> tuple[TournamentPayment, str | None]:
    """Create the PaymentIntent under the payment's durable idempotency key.

    No lock and no transaction is held across the Stripe call (#1816: no
    Stripe call inside a transaction that holds capacity locks). A director
    entry updates this row while it holds the tournament lock, so holding the
    row lock across the call would stall that entry behind Stripe. Two racing
    prepares both call Stripe with the SAME key, so Stripe returns one
    PaymentIntent to both. The row lock is taken only to record the result.
    """
    payment = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .execution_options(populate_existing=True)
    )
    if payment is None:
        raise PaymentNotFoundError()
    if payment.provider_payment_intent_id is not None:
        await db.commit()
        return payment, None
    payee_account = payment.payee_stripe_account
    amount_cents = payment.amount_cents
    currency = payment.currency.lower()
    idempotency_key = payment.idempotency_key
    event_count = await db.scalar(
        select(func.count())
        .select_from(TournamentPaymentLine)
        .where(TournamentPaymentLine.payment_id == payment_id)
    )
    await db.commit()

    outcome = await provider.create_payment_intent(
        payee_account=payee_account,
        amount_cents=amount_cents,
        currency=currency,
        idempotency_key=idempotency_key,
        metadata={"payment_id": str(payment_id)},
        statement_descriptor_suffix=f"FORTYMM{event_count}",
    )

    locked = await _lock_payment(db, payment_id)
    if locked is None:
        raise PaymentNotFoundError()
    client_secret: str | None = None
    match outcome:
        case ProviderIntentCreated(intent=intent):
            if locked.provider_payment_intent_id is None:
                locked.provider_payment_intent_id = intent.id
                if not _intent_matches_payment(
                    intent, locked, key_is_live=settings.stripe_key_is_live
                ):
                    # Validate before use, exactly as reconcile does. The
                    # payer never gets the secret of a mismatched intent.
                    _quarantine(db, locked, amount_received=intent.amount_received)
                else:
                    locked.status = _map_provider_status(
                        intent.status, current=locked.status
                    )
                if locked.status is TournamentPaymentStatus.cancel_requested:
                    # A director entry superseded this payment while the create
                    # was in flight. Its cancel job found no PaymentIntent id
                    # to cancel, so stage a fresh one now that the id exists.
                    await required_repairs.request_payment_cancel(db, locked.id)
            if (
                locked.provider_payment_intent_id == intent.id
                and locked.status in _PAYER_ACTIONABLE_STATUSES
            ):
                client_secret = intent.client_secret
        case ProviderCreateUncertain():
            # Keep the current status. A later status read or resume replays
            # the create under the same key.
            pass
    await db.commit()
    return locked, client_secret


async def _create_payment_row(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    settings: Settings,
) -> uuid.UUID:
    """Commit the provider-create obligation before any Stripe call (#1816).

    A NEW charge needs a live quote. The checkout is validated and the row is
    inserted under the lock order every checkout invalidation takes (payer
    Account, then Tournament, then the checkout row). So a cancellation, a
    director entry or another invalidation either commits first and this
    refuses, or commits after and sees the payment it must cancel. An expired
    or superseded hold can still finish a payment that already exists (a late
    success), but it never starts one.

    Two concurrent first prepares for one checkout serialize on those locks,
    and the second reuses the first one's row. The unique checkout constraint
    stays as the backstop.
    """
    if not settings.card_payments_configured:
        raise PaymentNotReadyError()
    await db.scalar(
        select(User)
        .where(User.id == actor.id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    try:
        tournament = await lock_tournament(db, tournament_id)
    except TournamentNotFoundError as error:
        raise PaymentNotReadyError() from error
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
        .options(selectinload(TournamentCheckout.lines))
    )
    if checkout is None or checkout.payer_account_id != actor.id:
        raise PaymentNotFoundError()
    existing_id: uuid.UUID | None = await db.scalar(
        select(TournamentPayment.id).where(TournamentPayment.checkout_id == checkout.id)
    )
    if existing_id is not None:
        await db.commit()
        return existing_id
    if (
        checkout_effective_state(checkout, tournament, await database_now(db))
        is not TournamentCheckoutState.active
        # The quote was authorized by the merchant it names. A later change of
        # ``TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID`` must not re-bind it.
        or checkout.merchant_account_id
        != settings.tournament_payment_merchant_account_id
        # Stripe refuses an amount above its limit. Refuse here, before the
        # create obligation commits, rather than persist an impossible create.
        or checkout.total_cents > STRIPE_MAX_AMOUNT_CENTS
    ):
        raise PaymentNotReadyError()
    payment = TournamentPayment(
        checkout_id=checkout.id,
        payer_account_id=actor.id,
        tournament_id=checkout.tournament_id,
        payee_stripe_account=settings.payee_stripe_account,
        payee_fortymm_account_id=checkout.merchant_account_id,
        idempotency_key=f"tournament-payment:{checkout.id}",
        amount_cents=checkout.total_cents,
        currency=checkout.currency,
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
    db: AsyncSession,
    payment: TournamentPayment,
    provider: PaymentProvider,
    settings: Settings,
) -> tuple[TournamentPayment, ProviderPaymentIntent | None]:
    """Reconcile for a read. If Stripe cannot be reached, keep the last known
    state instead of failing the read. Also returns the PaymentIntent that
    reconcile retrieved and validated, or ``None``."""
    try:
        reconciled, intent = await _reconcile(
            db, payment_id=payment.id, provider=provider, settings=settings
        )
    except PaymentProviderUnavailableError:
        return payment, None
    return (reconciled if reconciled is not None else payment), intent


async def prepare_or_resume_payment(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    provider: PaymentProvider,
    settings: Settings,
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
        payment_id = await _create_payment_row(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout.id,
            actor=actor,
            settings=settings,
        )

    payment, client_secret = await _drive_provider_create(
        db, payment_id, provider, settings
    )
    if payment.payer_account_id != actor.id:
        raise PaymentNotFoundError()
    if client_secret is None and payment.provider_payment_intent_id is not None:
        # Resume: bring the state up to date, then hand back the secret only
        # while the payer can still act on the PaymentIntent. An actionable
        # status means reconcile validated this intent against the row.
        payment, intent = await _reconcile_or_keep(db, payment, provider, settings)
        if intent is not None and payment.status in _PAYER_ACTIONABLE_STATUSES:
            client_secret = intent.client_secret

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
    settings: Settings,
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
        if payment.provider_payment_intent_id is None:
            payment, _ = await _drive_provider_create(
                db, payment.id, provider, settings
            )
        if payment.provider_payment_intent_id is not None:
            payment, _ = await _reconcile_or_keep(db, payment, provider, settings)
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

    A success clears any decline an earlier attempt recorded.
    """
    payment.last_error_code = None
    payer = await db.get(User, payment.payer_account_id)
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(TournamentCheckout.id == payment.checkout_id)
        .with_for_update()
    )
    tournament = await db.get(Tournament, payment.tournament_id)
    superseded = (
        checkout is None
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
    pending = [
        line
        for line in payment.lines
        if line.outcome is TournamentPaymentLineOutcome.pending
    ]
    if payer is None or superseded:
        for line in pending:
            _record_line_refund(
                db, payment, line, TournamentPaymentRefundReason.checkout_superseded
            )
        payment.status = TournamentPaymentStatus.succeeded
        return
    for line in pending:
        try:
            entrant = await admit_to_event(
                db,
                tournament_id=payment.tournament_id,
                event_id=line.event_id,
                actor=payer,
                user_id=None,
                client_ip=None,
                settled_payment=SettledPayment(event_id=line.event_id),
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
    settings: Settings,
    source_event: ProviderWebhookEvent | None = None,
) -> TournamentPayment | None:
    """The one function webhooks, the status read, and prepare/resume ALL
    call. See :func:`_reconcile`, which also returns the validated intent."""
    payment, _ = await _reconcile(
        db,
        payment_id=payment_id,
        provider=provider,
        settings=settings,
        source_event=source_event,
    )
    return payment


async def _reconcile(
    db: AsyncSession,
    *,
    payment_id: uuid.UUID,
    provider: PaymentProvider,
    settings: Settings,
    source_event: ProviderWebhookEvent | None = None,
) -> tuple[TournamentPayment | None, ProviderPaymentIntent | None]:
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

    Returns the payment and the retrieved PaymentIntent. The intent is
    ``None`` unless it passed validation against the payment row.

    Raises :class:`PaymentProviderUnavailableError` when Stripe cannot be
    reached and nothing else is wrong. The payment is then left unchanged.
    """
    snapshot = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .execution_options(populate_existing=True)
    )
    if snapshot is None:
        return None, None
    if (
        snapshot.status in TERMINAL_PAYMENT_STATUSES
        or snapshot.provider_payment_intent_id is None
    ):
        return snapshot, None
    payee_account = snapshot.payee_stripe_account
    payment_intent_id = snapshot.provider_payment_intent_id
    payer_account_id = snapshot.payer_account_id
    tournament_id = snapshot.tournament_id
    await db.commit()

    key_is_live = settings.stripe_key_is_live
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
        return None, None
    if payment.status in TERMINAL_PAYMENT_STATUSES:
        await db.commit()
        return payment, None

    if intent is None:
        # The quarantine retrieval failed, or the PaymentIntent is not on the
        # payee account: no verified captured amount, so no obligation.
        _quarantine(db, payment, amount_received=None)
        await db.commit()
        return payment, None

    if not _intent_matches_payment(intent, payment, key_is_live=key_is_live) or (
        not event_ok
    ):
        _quarantine(db, payment, amount_received=intent.amount_received)
        await db.commit()
        return payment, None

    if source_event is not None and source_event.type == "charge.refunded":
        # Evidence-only (#1816): adds to the trail, changes no obligation.
        await db.commit()
        return payment, intent

    if intent.status is ProviderIntentStatus.SUCCEEDED:
        await _admit(db, payment)
    else:
        payment.status = _map_provider_status(intent.status, current=payment.status)
        # Only ``ready`` carries a decline the payer can act on. Every other
        # state reports no current error, so a stale decline is cleared.
        payment.last_error_code = (
            _safe_error_code(intent)
            if payment.status is TournamentPaymentStatus.ready
            else None
        )
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
    return payment, intent


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
    from app.payments.dependencies import provider_for_settings

    async with sessionmaker() as db:
        payment = await db.scalar(
            select(TournamentPayment).where(TournamentPayment.id == payment_id)
        )
        if payment is None or payment.provider_payment_intent_id is None:
            return
        if payment.status in TERMINAL_PAYMENT_STATUSES:
            return
        provider = provider_for_settings(get_settings())
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
