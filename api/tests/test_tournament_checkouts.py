"""Behavioral tests for combined tournament checkout reservations."""

import asyncio
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.account_merge import merge_user
from app.event_lifecycle import cancel_event
from app.leagues import get_default_league
from app.models import (
    DrawType,
    EventFormat,
    Player,
    Tournament,
    TournamentCheckout,
    TournamentCheckoutLine,
    TournamentCheckoutStatus,
    TournamentEntry,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentStatus,
    User,
)
from app.schemas.tournament_checkout import TournamentCheckoutCreate
from app.tournament_checkout_errors import CheckoutRefusal, CheckoutRefusedError
from app.tournament_checkouts import start_checkout
from tests._helpers import make_client, make_user, start_session


async def _paid_tournament(
    db: AsyncSession,
    *,
    owner: User,
    fees: tuple[Decimal, ...] = (Decimal("20.00"), Decimal("35.00")),
    capacities: tuple[int | None, ...] | None = None,
) -> tuple[Tournament, list[TournamentEvent]]:
    league = await get_default_league(db)
    assert league is not None
    tournament = Tournament(
        name="Checkout Open",
        status=TournamentStatus.published,
        registration_open=True,
        registration_generation=1,
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.flush()
    limits = capacities or tuple(None for _ in fees)
    events = [
        TournamentEvent(
            tournament_id=tournament.id,
            name=f"Event {index}",
            format=EventFormat.singles,
            draw_settings=TournamentEventDrawSettings.for_draw_type(
                DrawType.single_elim
            ),
            max_players=limit,
            entry_fee=fee,
            timezone="America/Chicago",
            slot={"date": "2030-04-20", "start": "09:00", "end": "17:00"},
            match_settings={"rated": True, "length_games": 5},
            predicates=[],
        )
        for index, (fee, limit) in enumerate(zip(fees, limits, strict=True), start=1)
    ]
    db.add_all(events)
    await db.commit()
    return tournament, events


async def test_starting_combined_checkout_snapshots_quote_and_resumes_deadline(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer = await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, events = await _paid_tournament(db_session, owner=owner)
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    request_id = uuid.uuid4()
    payload = {
        "request_id": str(request_id),
        "event_ids": [str(event.id) for event in reversed(events)],
    }

    created = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts", json=payload
    )
    assert created.status_code == 201
    quote = created.json()
    assert quote["status"] == "active"
    assert quote["payment_state"] == "unavailable"
    assert quote["currency"] == "USD"
    assert quote["total_cents"] == 5500
    assert quote["registration_generation"] == 1
    assert 0 < quote["remaining_seconds"] <= 600
    assert [line["event_id"] for line in quote["lines"]] == sorted(
        str(event.id) for event in events
    )
    assert [line["price_cents"] for line in quote["lines"]] == [
        next(
            int(event.entry_fee * 100)
            for event in events
            if str(event.id) == line["event_id"]
        )
        for line in quote["lines"]
    ]

    resumed = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts", json=payload
    )
    assert resumed.status_code == 201
    assert resumed.json()["id"] == quote["id"]
    assert resumed.json()["expires_at"] == quote["expires_at"]

    original_lines = quote["lines"]
    events[0].name = "Renamed after quote"
    events[0].entry_fee = Decimal("99.00")
    await db_session.commit()
    reread = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{quote['id']}"
    )
    assert reread.status_code == 200
    assert reread.json()["lines"] == original_lines
    assert reread.json()["total_cents"] == 5500
    assert reread.json()["expires_at"] == quote["expires_at"]

    checkout = await db_session.scalar(select(TournamentCheckout))
    assert checkout is not None
    assert checkout.payer_account_id == payer.id
    assert checkout.entrant_player_id == payer.player_id
    assert checkout.request_id == request_id
    assert checkout.total_cents == 5500
    lines = list(
        await db_session.scalars(
            select(TournamentCheckoutLine).order_by(TournamentCheckoutLine.event_id)
        )
    )
    assert [(line.event_name, line.price_cents) for line in lines] == [
        (
            next(
                snapshot["event_name"]
                for snapshot in original_lines
                if snapshot["event_id"] == str(line.event_id)
            ),
            next(
                snapshot["price_cents"]
                for snapshot in original_lines
                if snapshot["event_id"] == str(line.event_id)
            ),
        )
        for line in lines
    ]


async def test_combined_checkout_acquires_every_hold_or_none_and_names_full_event(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer = await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, events = await _paid_tournament(
        db_session, owner=owner, capacities=(2, 1)
    )
    existing = await make_user(db_session, f"entered-{uuid.uuid4().hex[:8]}")
    db_session.add(TournamentEntry(event_id=events[1].id, user_id=existing.player_id))
    await db_session.commit()
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))

    response = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [str(event.id) for event in events],
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "event_full",
        "message": "This event has no places available.",
        "event_id": str(events[1].id),
    }
    assert await db_session.scalar(select(TournamentCheckout)) is None
    assert payer.player_id != existing.player_id


async def test_checkout_refuses_an_event_the_player_already_entered(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer = await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("10.00"),)
    )
    db_session.add(TournamentEntry(event_id=event.id, user_id=payer.player_id))
    await db_session.commit()
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))

    response = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "already_entered",
        "message": "You are already entered in this event.",
        "event_id": str(event.id),
    }
    assert await db_session.scalar(select(TournamentCheckout)) is None


async def test_two_players_racing_for_last_checkout_hold_yield_one_checkout(
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    """Stage both contenders behind the parent lock, then release them together."""
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session,
        owner=owner,
        fees=(Decimal("10.00"),),
        capacities=(1,),
    )
    contenders = [
        await make_user(db_session, f"buyer-{uuid.uuid4().hex[:8]}") for _ in range(2)
    ]
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def reserve(account_id: uuid.UUID) -> str:
        async with make_session() as session:
            actor = await session.scalar(select(User).where(User.id == account_id))
            assert actor is not None
            try:
                await start_checkout(
                    session,
                    tournament_id=tournament.id,
                    actor=actor,
                    request=TournamentCheckoutCreate(
                        request_id=uuid.uuid4(), event_ids=[event.id]
                    ),
                    client_ip=f"203.0.113.{len(str(account_id))}",
                )
                return "reserved"
            except CheckoutRefusedError as error:
                assert error.refusal is CheckoutRefusal.event_full
                await session.rollback()
                return error.refusal.value

    async with make_session() as gatekeeper:
        await gatekeeper.execute(
            select(Tournament).where(Tournament.id == tournament.id).with_for_update()
        )
        racing = [
            asyncio.create_task(reserve(contender.id)) for contender in contenders
        ]
        await asyncio.sleep(0.25)
        ran_ahead = [task for task in racing if task.done()]
        if ran_ahead:
            for task in racing:
                task.cancel()
            pytest.fail(
                "a checkout decided capacity before acquiring the tournament lock"
            )
        await gatekeeper.rollback()
        outcomes = await asyncio.gather(*racing)

    assert sorted(outcomes) == ["event_full", "reserved"]
    async with make_session() as verify:
        rows = list(await verify.scalars(select(TournamentCheckout)))
        assert len(rows) == 1


async def test_checkout_is_limited_to_the_configured_merchant_owner(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    await start_session(api_client, db_session)
    owner = await make_user(db_session, f"owner-{uuid.uuid4().hex[:8]}")
    stranger = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("10.00"),)
    )
    url = f"/v1/tournaments/{tournament.id}/checkouts"
    body = {"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]}

    monkeypatch.delenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", raising=False)
    detail = await api_client.get(f"/v1/tournaments/{tournament.id}")
    assert detail.status_code == 200
    assert detail.json()["checkout_available"] is False
    unavailable = await api_client.post(url, json=body)
    assert unavailable.status_code == 409
    assert unavailable.json()["detail"]["code"] == "merchant_unavailable"

    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(stranger.id))
    wrong_owner = await api_client.post(
        url,
        json={**body, "request_id": str(uuid.uuid4())},
    )
    assert wrong_owner.status_code == 409
    assert wrong_owner.json()["detail"]["code"] == "merchant_unavailable"
    assert await db_session.scalar(select(TournamentCheckout)) is None

    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    available = await api_client.get(f"/v1/tournaments/{tournament.id}")
    assert available.status_code == 200
    assert available.json()["checkout_available"] is True


async def test_retired_player_cannot_reserve_capacity(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer = await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("10.00"),), capacities=(1,)
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    player = await db_session.get(Player, payer.player_id)
    assert player is not None
    player.retired_at = datetime.now(UTC)
    await db_session.commit()

    response = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )

    assert response.status_code == 404
    assert await db_session.scalar(select(TournamentCheckout)) is None


async def test_combined_total_exceeding_int32_is_stored_exactly(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    fees = tuple(Decimal("999999.99") for _ in range(22))
    tournament, events = await _paid_tournament(db_session, owner=owner, fees=fees)
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))

    response = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [str(event.id) for event in events],
        },
    )

    assert response.status_code == 201
    assert response.json()["total_cents"] == 2_199_999_978


async def test_explicit_cancellation_releases_hold_for_another_player(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session,
        owner=owner,
        fees=(Decimal("12.00"),),
        capacities=(1,),
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    first = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    assert first.status_code == 201

    async with make_client() as other_client:
        await start_session(other_client, db_session)
        blocked = await other_client.post(
            f"/v1/tournaments/{tournament.id}/checkouts",
            json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
        )
        assert blocked.status_code == 409
        assert blocked.json()["detail"]["code"] == "event_full"

        cancelled = await api_client.delete(
            f"/v1/tournaments/{tournament.id}/checkouts/{first.json()['id']}"
        )
        assert cancelled.status_code == 200
        assert cancelled.json()["status"] == "cancelled"

        available = await other_client.post(
            f"/v1/tournaments/{tournament.id}/checkouts",
            json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
        )
        assert available.status_code == 201


async def test_paid_event_requires_checkout_while_zero_fee_event_enters_free(
    api_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    player = await start_session(api_client, db_session)
    owner = await make_user(db_session, f"owner-{uuid.uuid4().hex[:8]}")
    tournament, events = await _paid_tournament(
        db_session,
        owner=owner,
        fees=(Decimal("20.00"), Decimal("0.00")),
    )

    paid = await api_client.post(
        f"/v1/tournaments/{tournament.id}/events/{events[0].id}/entries"
    )
    assert paid.status_code == 409
    assert paid.json()["detail"]["code"] == "payment_required"

    free = await api_client.post(
        f"/v1/tournaments/{tournament.id}/events/{events[1].id}/entries"
    )
    assert free.status_code == 201
    assert free.json()["user_id"] == str(player.player_id)


async def test_checkout_refuses_a_positive_fee_below_fifty_cents(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("0.49"),)
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))

    response = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "price_too_low",
        "message": "Paid event fees must be at least $0.50 USD.",
        "event_id": str(event.id),
    }


async def test_tournament_availability_counts_holds_without_listing_them_as_entrants(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session,
        owner=owner,
        fees=(Decimal("15.00"),),
        capacities=(1,),
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    response = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    assert response.status_code == 201

    detail = await api_client.get(f"/v1/tournaments/{tournament.id}")
    assert detail.status_code == 200
    event_read = detail.json()["events"][0]
    assert event_read["entrants"] == []
    assert event_read["entered"] == 0
    assert event_read["held_places"] == 1
    assert event_read["available_places"] == 0
    assert event_read["entry_state"] == {"state": "event_full"}


async def test_close_then_reopen_never_revives_the_old_checkout(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    owner = await start_session(api_client, db_session)
    tournament, (event,) = await _paid_tournament(
        db_session,
        owner=owner,
        fees=(Decimal("18.00"),),
        capacities=(1,),
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    first = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    assert first.status_code == 201

    closed = await api_client.post(
        f"/v1/tournaments/{tournament.id}/registration/close"
    )
    assert closed.status_code == 200
    stale = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{first.json()['id']}"
    )
    assert stale.status_code == 200
    assert stale.json()["status"] == "invalidated"

    reopened = await api_client.post(
        f"/v1/tournaments/{tournament.id}/registration/reopen"
    )
    assert reopened.status_code == 200
    replacement = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    assert replacement.status_code == 201
    assert replacement.json()["id"] != first.json()["id"]
    assert (
        replacement.json()["registration_generation"]
        > first.json()["registration_generation"]
    )


async def test_expired_checkout_is_reported_from_database_time_and_replaced(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("10.00"),), capacities=(1,)
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    first = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    assert first.status_code == 201
    await db_session.execute(
        text(
            "UPDATE tournament_checkouts "
            "SET created_at = clock_timestamp() - interval '601 seconds', "
            "expires_at = clock_timestamp() - interval '1 second' "
            "WHERE id = :checkout_id"
        ),
        {"checkout_id": first.json()["id"]},
    )
    await db_session.commit()

    expired = await api_client.get(f"/v1/tournaments/{tournament.id}/checkouts/current")
    assert expired.status_code == 200
    assert expired.json()["status"] == "expired"

    replacement = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    assert replacement.status_code == 201
    assert replacement.json()["id"] != first.json()["id"]


async def test_request_identity_selection_conflicts_and_checkout_is_private(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, events = await _paid_tournament(db_session, owner=owner)
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    request_id = str(uuid.uuid4())
    created = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": request_id, "event_ids": [str(events[0].id)]},
    )
    assert created.status_code == 201

    changed = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": request_id, "event_ids": [str(events[1].id)]},
    )
    assert changed.status_code == 409
    assert changed.json()["detail"]["code"] == "request_payload_conflict"

    async with make_client() as stranger:
        await start_session(stranger, db_session)
        hidden = await stranger.get(
            f"/v1/tournaments/{tournament.id}/checkouts/{created.json()['id']}"
        )
        assert hidden.status_code == 404

    cancelled = await api_client.delete(
        f"/v1/tournaments/{tournament.id}/checkouts/{created.json()['id']}"
    )
    assert cancelled.status_code == 200
    unknown = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(uuid.uuid4())]},
    )
    assert unknown.status_code == 409
    assert unknown.json()["detail"]["code"] == "event_not_found"


async def test_request_identity_cannot_resume_checkout_under_another_tournament(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    first_tournament, (first_event,) = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("10.00"),)
    )
    second_tournament, (second_event,) = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("12.00"),)
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    request_id = str(uuid.uuid4())
    created = await api_client.post(
        f"/v1/tournaments/{first_tournament.id}/checkouts",
        json={"request_id": request_id, "event_ids": [str(first_event.id)]},
    )
    assert created.status_code == 201

    crossed = await api_client.post(
        f"/v1/tournaments/{second_tournament.id}/checkouts",
        json={"request_id": request_id, "event_ids": [str(second_event.id)]},
    )

    assert crossed.status_code == 409
    assert crossed.json()["detail"]["code"] == "request_payload_conflict"
    assert crossed.json()["detail"]["message"] == (
        "That request ID was already used for another tournament."
    )


async def test_cancelled_checkout_history_does_not_prevent_event_deletion(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    owner = await start_session(api_client, db_session)
    tournament, (event,) = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("10.00"),)
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    created = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    assert created.status_code == 201
    checkout_id = created.json()["id"]
    assert (
        await api_client.delete(
            f"/v1/tournaments/{tournament.id}/checkouts/{checkout_id}"
        )
    ).status_code == 200

    deleted = await api_client.delete(
        f"/v1/tournaments/{tournament.id}/events/{event.id}"
    )

    assert deleted.status_code == 204
    history = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{checkout_id}"
    )
    assert history.status_code == 200
    assert history.json()["lines"][0]["event_id"] == str(event.id)


async def test_cancelling_one_selected_event_invalidates_the_combined_checkout(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    owner = await start_session(api_client, db_session)
    tournament, events = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("10.00"), Decimal("12.00"))
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    created = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [str(event.id) for event in events],
        },
    )
    assert created.status_code == 201

    await cancel_event(
        db_session,
        tournament_id=tournament.id,
        event_id=events[0].id,
        actor=owner,
    )
    await db_session.commit()

    checkout = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{created.json()['id']}"
    )
    assert checkout.status_code == 200
    assert checkout.json()["status"] == "invalidated"
    detail = await api_client.get(f"/v1/tournaments/{tournament.id}")
    remaining = next(
        item for item in detail.json()["events"] if item["id"] == str(events[1].id)
    )
    assert remaining["held_places"] == 0


async def test_deleting_one_selected_event_invalidates_the_combined_checkout(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    owner = await start_session(api_client, db_session)
    tournament, events = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("10.00"), Decimal("12.00"))
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    created = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [str(event.id) for event in events],
        },
    )
    assert created.status_code == 201

    deleted = await api_client.delete(
        f"/v1/tournaments/{tournament.id}/events/{events[0].id}"
    )

    assert deleted.status_code == 204
    checkout = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{created.json()['id']}"
    )
    assert checkout.status_code == 200
    assert checkout.json()["status"] == "invalidated"
    assert len(checkout.json()["lines"]) == 2
    detail = await api_client.get(f"/v1/tournaments/{tournament.id}")
    assert detail.json()["events"][0]["held_places"] == 0


async def test_player_merge_invalidates_source_checkout_hold(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    source = await start_session(api_client, db_session)
    survivor = await make_user(db_session, f"survivor-{uuid.uuid4().hex[:8]}")
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("10.00"),), capacities=(1,)
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    created = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    assert created.status_code == 201

    await merge_user(
        db_session,
        from_user_id=source.id,
        to_user_id=survivor.id,
    )
    await db_session.commit()

    checkout = await db_session.get(TournamentCheckout, uuid.UUID(created.json()["id"]))
    assert checkout is not None
    assert checkout.status is TournamentCheckoutStatus.invalidated


async def test_checkout_creation_is_rate_limited_per_network(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    rate_limiter_fakeredis,
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("10.00"),), capacities=(3,)
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    monkeypatch.setenv("TOURNAMENT_CHECKOUT_IP_PER_HOUR", "1")
    await start_session(api_client, db_session)
    first = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    assert first.status_code == 201

    async with make_client() as other_client:
        await start_session(other_client, db_session)
        refused = await other_client.post(
            f"/v1/tournaments/{tournament.id}/checkouts",
            json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
        )

    assert refused.status_code == 429
    assert "retry shortly" in refused.json()["detail"]


async def test_database_enforces_one_active_checkout_and_processor_minimum(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session, owner=owner, fees=(Decimal("10.00"),)
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    created = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    assert created.status_code == 201

    with pytest.raises(IntegrityError, match="active_player_tournament"):
        await db_session.execute(
            text(
                "INSERT INTO tournament_checkouts "
                "(request_id, payer_account_id, entrant_player_id, tournament_id, "
                "merchant_account_id, registration_generation, currency, total_cents) "
                "SELECT gen_random_uuid(), payer_account_id, entrant_player_id, "
                "tournament_id, merchant_account_id, registration_generation, "
                "currency, total_cents FROM tournament_checkouts WHERE id = :id"
            ),
            {"id": created.json()["id"]},
        )
        await db_session.flush()
    await db_session.rollback()

    with pytest.raises(IntegrityError, match="minimum_price"):
        await db_session.execute(
            text(
                "INSERT INTO tournament_checkout_lines "
                "(checkout_id, event_id, event_name, price_cents) "
                "VALUES (:checkout_id, gen_random_uuid(), 'Too cheap', 49)"
            ),
            {"checkout_id": created.json()["id"]},
        )
        await db_session.flush()
    await db_session.rollback()
