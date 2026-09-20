"""Transport-neutral combined paid-event checkout operations."""

import uuid
from datetime import datetime
from decimal import Decimal
from math import ceil
from typing import cast

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.models import (
    EventFormat,
    EventLifecycleState,
    Player,
    Tournament,
    TournamentCheckout,
    TournamentCheckoutLine,
    TournamentCheckoutStatus,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    User,
)
from app.rate_limiting import RateLimitUnavailable, check_idempotent_expiring_budget
from app.schemas.tournament_checkout import (
    TournamentCheckoutCreate,
    TournamentCheckoutLineRead,
    TournamentCheckoutPaymentState,
    TournamentCheckoutRead,
    TournamentCheckoutState,
)
from app.tournament_checkout_errors import (
    CheckoutNotFoundError,
    CheckoutRateLimitedError,
    CheckoutRateLimitUnavailableError,
    CheckoutRefusal,
    CheckoutRefusedError,
)
from app.tournament_eligibility import Eligible, evaluate_rating_eligibility
from app.tournament_queries import (
    active_entry_counts_by_event,
    entrant_rating,
    valid_hold_counts_by_event,
    visible_to,
)
from app.tournament_registration import registration_open


async def _enforce_checkout_rate_limit(
    client_ip: str, *, payer_account_id: uuid.UUID, request_id: uuid.UUID
) -> None:
    limit = get_settings().tournament_checkout_ip_per_hour
    try:
        allowed = await check_idempotent_expiring_budget(
            f"tournament-checkout-ip:{client_ip}",
            idempotency_key=(
                f"tournament-checkout-request:{payer_account_id}:{request_id}"
            ),
            limit=limit,
            seconds=3600,
        )
    except RateLimitUnavailable as error:
        raise CheckoutRateLimitUnavailableError() from error
    if not allowed:
        raise CheckoutRateLimitedError()


def _price_cents(price: Decimal) -> int:
    """Convert the exact Numeric value to cents without passing through float."""
    return int(price * Decimal(100))


async def _database_now(db: AsyncSession) -> datetime:
    return cast(
        datetime, (await db.execute(select(func.clock_timestamp()))).scalar_one()
    )


def _effective_state(
    checkout: TournamentCheckout, tournament: Tournament, now: datetime
) -> TournamentCheckoutState:
    match checkout.status:
        case TournamentCheckoutStatus.cancelled:
            return TournamentCheckoutState.cancelled
        case TournamentCheckoutStatus.expired:
            return TournamentCheckoutState.expired
        case TournamentCheckoutStatus.invalidated:
            return TournamentCheckoutState.invalidated
        case TournamentCheckoutStatus.active:
            if checkout.registration_generation != tournament.registration_generation:
                return TournamentCheckoutState.invalidated
            if checkout.merchant_account_id != tournament.owner_account_id:
                return TournamentCheckoutState.invalidated
            if checkout.expires_at <= now:
                return TournamentCheckoutState.expired
            return TournamentCheckoutState.active


def _read(
    checkout: TournamentCheckout, tournament: Tournament, now: datetime
) -> TournamentCheckoutRead:
    return TournamentCheckoutRead(
        id=checkout.id,
        request_id=checkout.request_id,
        tournament_id=checkout.tournament_id,
        registration_generation=checkout.registration_generation,
        status=_effective_state(checkout, tournament, now),
        payment_state=TournamentCheckoutPaymentState.unavailable,
        currency=checkout.currency,
        total_cents=checkout.total_cents,
        created_at=checkout.created_at,
        expires_at=checkout.expires_at,
        remaining_seconds=max(0, ceil((checkout.expires_at - now).total_seconds())),
        lines=[
            TournamentCheckoutLineRead(
                event_id=line.event_id,
                event_name=line.event_name,
                price_cents=line.price_cents,
            )
            for line in checkout.lines
        ],
    )


async def _expire_stale_checkouts(
    db: AsyncSession, tournament: Tournament, entrant_player_id: uuid.UUID
) -> None:
    checkouts = list(
        await db.scalars(
            select(TournamentCheckout)
            .where(
                TournamentCheckout.tournament_id == tournament.id,
                TournamentCheckout.entrant_player_id == entrant_player_id,
                TournamentCheckout.status == TournamentCheckoutStatus.active,
            )
            .options(selectinload(TournamentCheckout.lines))
        )
    )
    now = await _database_now(db)
    for checkout in checkouts:
        if (
            checkout.registration_generation != tournament.registration_generation
            or checkout.merchant_account_id != tournament.owner_account_id
        ):
            checkout.status = TournamentCheckoutStatus.invalidated
        elif checkout.expires_at <= now:
            checkout.status = TournamentCheckoutStatus.expired
    if checkouts:
        await db.flush()


async def invalidate_checkouts_for_event(db: AsyncSession, event_id: uuid.UUID) -> None:
    """Release every combined quote containing a terminal or deleted event.

    A quote is all-or-nothing: retaining holds for its other lines would reserve
    capacity behind a checkout that can no longer be completed as quoted. The
    caller already owns the tournament lock and transaction used for the event
    lifecycle change.
    """
    checkout_ids = select(TournamentCheckoutLine.checkout_id).where(
        TournamentCheckoutLine.event_id == event_id
    )
    await db.execute(
        update(TournamentCheckout)
        .where(
            TournamentCheckout.id.in_(checkout_ids),
            TournamentCheckout.status == TournamentCheckoutStatus.active,
        )
        .values(status=TournamentCheckoutStatus.invalidated)
    )


async def _load_tournament_locked(
    db: AsyncSession, tournament_id: uuid.UUID, viewer_account_id: uuid.UUID
) -> Tournament:
    tournament = await db.scalar(
        select(Tournament)
        .where(Tournament.id == tournament_id, visible_to(viewer_account_id))
        .with_for_update()
    )
    if tournament is None:
        raise CheckoutNotFoundError()
    return tournament


async def start_checkout(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    actor: User,
    request: TournamentCheckoutCreate,
    client_ip: str,
) -> TournamentCheckoutRead:
    # A durable request replay does not consume admission budget. Check for its
    # existence without a row lock first; genuinely new requests charge the
    # fail-closed Redis budget before taking Account, Tournament, or Player locks.
    # The request is loaded and validated again under the account lock below.
    prior_request_exists = await db.scalar(
        select(TournamentCheckout.id).where(
            TournamentCheckout.payer_account_id == actor.id,
            TournamentCheckout.request_id == request.request_id,
        )
    )
    if prior_request_exists is None:
        await _enforce_checkout_rate_limit(
            client_ip,
            payer_account_id=actor.id,
            request_id=request.request_id,
        )

    merchant_account_id = get_settings().tournament_payment_merchant_account_id
    # Lock both Accounts in stable order before the Tournament. This serializes a
    # new checkout with payer merges and merchant lifecycle transitions without
    # holding any database lock across the Redis admission check above.
    account_ids = {actor.id}
    if merchant_account_id is not None:
        account_ids.add(merchant_account_id)
    locked_accounts = list(
        await db.scalars(
            select(User)
            .where(User.id.in_(account_ids))
            .order_by(User.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    locked_actor = next(
        (account for account in locked_accounts if account.id == actor.id), None
    )
    locked_merchant = next(
        (
            account
            for account in locked_accounts
            if merchant_account_id is not None and account.id == merchant_account_id
        ),
        None,
    )
    primary_player = locked_actor.primary_player if locked_actor is not None else None
    if (
        locked_actor is None
        or not locked_actor.is_active
        or locked_actor.merged_into_user_id is not None
        or primary_player is None
    ):
        raise CheckoutNotFoundError()

    tournament = await _load_tournament_locked(db, tournament_id, locked_actor.id)
    # Account → Tournament → Player is the shared registration lock order. Taking
    # Player before Tournament can deadlock against free entry by another account
    # that manages the same Player (entry already holds Tournament when it resolves
    # and locks the entrant). Reload after both preceding locks so retirement and
    # account-identity changes cannot race this checkout.
    player = await db.scalar(
        select(Player)
        .where(Player.id == primary_player.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if player is None or player.retired_at is not None:
        raise CheckoutNotFoundError()
    requested_ids = set(request.event_ids)
    prior_request = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.payer_account_id == locked_actor.id,
            TournamentCheckout.request_id == request.request_id,
        )
        .options(selectinload(TournamentCheckout.lines))
    )
    now = await _database_now(db)
    if prior_request is not None:
        if prior_request.tournament_id != tournament.id:
            raise CheckoutRefusedError(
                CheckoutRefusal.request_payload_conflict,
                "That request ID was already used for another tournament.",
            )
        if {line.event_id for line in prior_request.lines} != requested_ids:
            raise CheckoutRefusedError(
                CheckoutRefusal.request_payload_conflict,
                "That request ID was already used for a different selection.",
            )
        # A durable result wins over mutable admission gates.  A retry after a
        # lost response must replay even if registration closed in the meantime.
        effective = _effective_state(prior_request, tournament, now)
        if effective is not TournamentCheckoutState.active:
            prior_request.status = TournamentCheckoutStatus(effective.value)
            await db.commit()
        return _read(prior_request, tournament, now)

    if (
        merchant_account_id is None
        or tournament.owner_account_id != merchant_account_id
        or locked_merchant is None
        or not locked_merchant.is_active
    ):
        raise CheckoutRefusedError(
            CheckoutRefusal.merchant_unavailable,
            "Paid checkout is unavailable for this tournament.",
        )
    if not registration_open(tournament):
        raise CheckoutRefusedError(
            CheckoutRefusal.registration_closed,
            "Registration is closed for this tournament.",
        )

    await _expire_stale_checkouts(db, tournament, player.id)
    active = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.tournament_id == tournament.id,
            TournamentCheckout.entrant_player_id == player.id,
            TournamentCheckout.status == TournamentCheckoutStatus.active,
        )
        .options(selectinload(TournamentCheckout.lines))
    )
    if active is not None:
        raise CheckoutRefusedError(
            CheckoutRefusal.active_checkout_conflict,
            "Cancel the active checkout before changing the event selection.",
        )

    events = list(
        await db.scalars(
            select(TournamentEvent)
            .where(
                TournamentEvent.tournament_id == tournament.id,
                TournamentEvent.id.in_(requested_ids),
            )
            .order_by(TournamentEvent.id)
        )
    )
    found_ids = {event.id for event in events}
    missing = sorted(requested_ids - found_ids)
    if missing:
        raise CheckoutRefusedError(
            CheckoutRefusal.event_not_found,
            "The selected event does not exist in this tournament.",
            event_id=missing[0],
        )

    entered_event_ids = set(
        await db.scalars(
            select(TournamentEntry.event_id).where(
                TournamentEntry.event_id.in_(requested_ids),
                TournamentEntry.user_id == player.id,
                TournamentEntry.status == TournamentEntryStatus.entered,
            )
        )
    )
    rating = await entrant_rating(db, tournament.league_id, player.id)
    capped_event_ids = [event.id for event in events if event.max_players is not None]
    entered_counts = await active_entry_counts_by_event(db, capped_event_ids)
    hold_counts = await valid_hold_counts_by_event(db, capped_event_ids)
    prices: list[int] = []
    for event in events:
        if event.lifecycle_state is EventLifecycleState.cancelled:
            raise CheckoutRefusedError(
                CheckoutRefusal.event_unavailable,
                "This event has been cancelled.",
                event_id=event.id,
            )
        if event.format is not EventFormat.singles:
            raise CheckoutRefusedError(
                CheckoutRefusal.event_unavailable,
                "Only singles events support checkout.",
                event_id=event.id,
            )
        cents = _price_cents(Decimal(event.entry_fee))
        if cents == 0:
            raise CheckoutRefusedError(
                CheckoutRefusal.event_free,
                "This event uses the separate free-entry action.",
                event_id=event.id,
            )
        if cents < 50:
            raise CheckoutRefusedError(
                CheckoutRefusal.price_too_low,
                "Paid event fees must be at least $0.50 USD.",
                event_id=event.id,
            )
        if event.id in entered_event_ids:
            raise CheckoutRefusedError(
                CheckoutRefusal.already_entered,
                "You are already entered in this event.",
                event_id=event.id,
            )
        if not isinstance(
            evaluate_rating_eligibility(rating=rating, predicates=event.predicates),
            Eligible,
        ):
            raise CheckoutRefusedError(
                CheckoutRefusal.event_ineligible,
                "You are not eligible for this event.",
                event_id=event.id,
            )
        if event.max_players is not None:
            entered = entered_counts[event.id]
            held = hold_counts[event.id]
            if entered + held >= event.max_players:
                raise CheckoutRefusedError(
                    CheckoutRefusal.event_full,
                    "This event has no places available.",
                    event_id=event.id,
                )
        prices.append(cents)

    checkout = TournamentCheckout(
        request_id=request.request_id,
        payer_account_id=locked_actor.id,
        entrant_player_id=player.id,
        tournament_id=tournament.id,
        merchant_account_id=merchant_account_id,
        registration_generation=tournament.registration_generation,
        currency="USD",
        total_cents=sum(prices),
        lines=[
            TournamentCheckoutLine(
                event_id=event.id,
                event_name=event.name,
                price_cents=price,
            )
            for event, price in zip(events, prices, strict=True)
        ],
    )
    db.add(checkout)
    await db.commit()
    await db.refresh(checkout)
    now = await _database_now(db)
    return _read(checkout, tournament, now)


async def read_checkout(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
) -> TournamentCheckoutRead:
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
        )
        .options(selectinload(TournamentCheckout.lines))
    )
    player = actor.primary_player
    if checkout is None or (
        checkout.payer_account_id != actor.id
        and (player is None or checkout.entrant_player_id != player.id)
    ):
        raise CheckoutNotFoundError()
    tournament = await db.get(Tournament, tournament_id)
    if tournament is None:
        raise CheckoutNotFoundError()
    return _read(checkout, tournament, await _database_now(db))


async def read_current_checkout(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    actor: User,
) -> TournamentCheckoutRead:
    player = actor.primary_player
    if player is None:
        raise CheckoutNotFoundError()
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.tournament_id == tournament_id,
            TournamentCheckout.entrant_player_id == player.id,
            TournamentCheckout.status == TournamentCheckoutStatus.active,
        )
        .options(selectinload(TournamentCheckout.lines))
    )
    if checkout is None:
        raise CheckoutNotFoundError()
    tournament = await db.get(Tournament, tournament_id)
    if tournament is None:
        raise CheckoutNotFoundError()
    return _read(checkout, tournament, await _database_now(db))


async def cancel_checkout(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
) -> TournamentCheckoutRead:
    await db.execute(
        select(User.id).where(User.id == actor.id).with_for_update(read=True)
    )
    tournament = await _load_tournament_locked(db, tournament_id, actor.id)
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament.id,
        )
        .options(selectinload(TournamentCheckout.lines))
    )
    player = actor.primary_player
    if checkout is None or (
        checkout.payer_account_id != actor.id
        and (player is None or checkout.entrant_player_id != player.id)
    ):
        raise CheckoutNotFoundError()
    now = await _database_now(db)
    effective = _effective_state(checkout, tournament, now)
    if effective is TournamentCheckoutState.active:
        checkout.status = TournamentCheckoutStatus.cancelled
        checkout.cancelled_at = now
        await db.commit()
    elif effective is TournamentCheckoutState.expired:
        checkout.status = TournamentCheckoutStatus.expired
        await db.commit()
    elif effective is TournamentCheckoutState.invalidated:
        checkout.status = TournamentCheckoutStatus.invalidated
        await db.commit()
    return _read(checkout, tournament, now)
