"""Migration-level guards for the durable tournament payment schema."""

import uuid

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.models import TournamentPayment, TournamentPaymentAllocation
from tests._migration_database import empty_database, run_alembic


async def test_payment_migration_installs_aggregate_and_allocation_invariants(
    engine: AsyncEngine,
) -> None:
    async with engine.connect() as connection:
        tables = await connection.run_sync(
            lambda sync: set(inspect(sync).get_table_names())
        )
        payment_uniques = await connection.run_sync(
            lambda sync: {
                item["name"]
                for item in inspect(sync).get_unique_constraints("tournament_payments")
            }
        )
        payment_columns = await connection.run_sync(
            lambda sync: {
                item["name"]
                for item in inspect(sync).get_columns("tournament_payments")
            }
        )
        allocation_foreign_keys = await connection.run_sync(
            lambda sync: {
                item["name"]
                for item in inspect(sync).get_foreign_keys(
                    "tournament_payment_allocations"
                )
            }
        )

    assert "tournament_payments" in tables
    assert "tournament_payment_allocations" in tables
    assert "uq_tournament_payments_checkout" in payment_uniques
    assert "uq_tournament_payments_identity" in payment_uniques
    assert "receipt_sync_pending" in payment_columns
    assert (
        "fk_tournament_payment_allocations_payment_checkout" in allocation_foreign_keys
    )
    assert "fk_tournament_payment_allocations_line_checkout" in allocation_foreign_keys


async def test_payment_migration_indexes_only_unprocessed_events_in_replay_order(
    engine: AsyncEngine,
) -> None:
    """The minute replay sweep must not scan and sort all historical evidence."""
    async with engine.connect() as connection:
        index_definition = await connection.scalar(
            text(
                "SELECT indexdef FROM pg_indexes "
                "WHERE schemaname = current_schema() "
                "AND tablename = 'tournament_provider_events' "
                "AND lower(indexdef) LIKE '%(received_at)%' "
                "AND lower(indexdef) LIKE '%where (processed_at is null)%'"
            )
        )

    assert index_definition is not None
    normalized = " ".join(index_definition.lower().split())
    assert "(received_at)" in normalized
    assert "where (processed_at is null)" in normalized


PENDING_PAYMENT_INDEX = "ix_tournament_payments_reconciliation_pending_created_at_id"
PENDING_REFUND_INDEX = "ix_tournament_payment_allocations_refund_pending_payment_id"
BROAD_STATE_INDEX = "ix_tournament_payments_reconciliation_state_created_at_id"


def test_payment_model_rejects_unbounded_state_reconciliation_index() -> None:
    names = {index.name for index in TournamentPayment.__table__.indexes}

    assert BROAD_STATE_INDEX not in names


def test_payment_models_declare_bounded_reconciliation_obligation_indexes() -> None:
    indexes = {
        index.name: index
        for table in (
            TournamentPayment.__table__,
            TournamentPaymentAllocation.__table__,
        )
        for index in table.indexes
    }

    payment_index = indexes[PENDING_PAYMENT_INDEX]
    assert tuple(column.name for column in payment_index.columns) == (
        "created_at",
        "id",
    )
    payment_predicate = str(
        payment_index.dialect_options["postgresql"]["where"]
    ).lower()
    for marker in (
        "preparing",
        "ready",
        "action_required",
        "checking",
        "expired",
        "create_in_flight",
        "receipt_sync_pending",
        "settlement_notified_at",
        "create_rejected",
        "provider_mismatch_at",
    ):
        assert marker in payment_predicate

    refund_index = indexes[PENDING_REFUND_INDEX]
    assert tuple(column.name for column in refund_index.columns) == ("payment_id",)
    assert (
        "refund_pending"
        in str(refund_index.dialect_options["postgresql"]["where"]).lower()
    )


async def test_bounded_reconciliation_indexes_are_added_by_a_forward_migration(
    postgres_server_url: str,
) -> None:
    async with empty_database(postgres_server_url) as migrated:
        run_alembic(migrated.url, "upgrade", "20260921_0002")
        async with migrated.connect() as connection:
            indexes_before = await connection.run_sync(
                lambda sync: {
                    item["name"]
                    for item in inspect(sync).get_indexes("tournament_payments")
                }
            )
        assert PENDING_PAYMENT_INDEX not in indexes_before
        assert BROAD_STATE_INDEX not in indexes_before

        run_alembic(migrated.url, "upgrade", "head")
        async with migrated.connect() as connection:
            payment_indexes_after = await connection.run_sync(
                lambda sync: {
                    item["name"]: item
                    for item in inspect(sync).get_indexes("tournament_payments")
                }
            )
            allocation_indexes_after = await connection.run_sync(
                lambda sync: {
                    item["name"]: item
                    for item in inspect(sync).get_indexes(
                        "tournament_payment_allocations"
                    )
                }
            )

        assert BROAD_STATE_INDEX not in payment_indexes_after
        assert tuple(payment_indexes_after[PENDING_PAYMENT_INDEX]["column_names"]) == (
            "created_at",
            "id",
        )
        assert payment_indexes_after[PENDING_PAYMENT_INDEX]["dialect_options"][
            "postgresql_where"
        ]
        assert tuple(
            allocation_indexes_after[PENDING_REFUND_INDEX]["column_names"]
        ) == ("payment_id",)
        assert allocation_indexes_after[PENDING_REFUND_INDEX]["dialect_options"][
            "postgresql_where"
        ]

        run_alembic(migrated.url, "downgrade", "20260921_0002")
        async with migrated.connect() as connection:
            payment_indexes_after_downgrade = await connection.run_sync(
                lambda sync: {
                    item["name"]
                    for item in inspect(sync).get_indexes("tournament_payments")
                }
            )
            allocation_indexes_after_downgrade = await connection.run_sync(
                lambda sync: {
                    item["name"]
                    for item in inspect(sync).get_indexes(
                        "tournament_payment_allocations"
                    )
                }
            )

        assert PENDING_PAYMENT_INDEX not in payment_indexes_after_downgrade
        assert PENDING_REFUND_INDEX not in allocation_indexes_after_downgrade


async def _explain(engine: AsyncEngine, query: str) -> str:
    async with engine.connect() as connection:
        await connection.execute(text("SET enable_seqscan = off"))
        rows = await connection.execute(text(f"EXPLAIN (COSTS OFF) {query}"))
    return "\n".join(str(row[0]) for row in rows).lower()


@pytest.mark.parametrize(
    "predicate",
    [
        "state = 'preparing'",
        "state = 'expired' AND provider_payment_id IS NOT NULL",
        "provider_payment_id IS NULL AND provider_status = 'create_in_flight'",
        "state = 'succeeded' AND receipt_sync_pending IS TRUE",
        "state = 'succeeded' AND settlement_notified_at IS NULL",
        "state = 'failed' AND receipt_sync_pending IS TRUE",
        "state = 'failed' AND provider_status = 'create_rejected' "
        "AND attention_notified_state IS DISTINCT FROM 'create_rejected'",
        "state = 'failed' AND provider_mismatch_at IS NOT NULL "
        "AND attention_notified_state IS DISTINCT FROM 'provider_mismatch'",
        "state = 'canceled' AND provider_payment_id IS NOT NULL "
        "AND receipt_sync_pending IS TRUE",
    ],
)
async def test_each_local_reconciliation_marker_uses_the_bounded_ordered_index(
    engine: AsyncEngine,
    predicate: str,
) -> None:
    plan = await _explain(
        engine,
        f"SELECT id FROM tournament_payments WHERE {predicate} ORDER BY created_at, id",
    )

    assert PENDING_PAYMENT_INDEX in plan


@pytest.mark.parametrize(
    "resolved_predicate",
    [
        "state = 'succeeded' AND receipt_sync_pending IS FALSE "
        "AND settlement_notified_at IS NOT NULL",
        "state = 'failed' AND receipt_sync_pending IS FALSE "
        "AND provider_status = 'resolved' AND provider_mismatch_at IS NULL",
        "state = 'canceled' AND provider_payment_id IS NOT NULL "
        "AND receipt_sync_pending IS FALSE",
    ],
)
async def test_resolved_terminal_history_is_excluded_from_reconciliation_indexes(
    engine: AsyncEngine,
    resolved_predicate: str,
) -> None:
    plan = await _explain(
        engine,
        f"SELECT id FROM tournament_payments WHERE {resolved_predicate} "
        "ORDER BY created_at, id",
    )

    assert "reconciliation" not in plan


async def test_refund_pending_allocations_have_a_bounded_payment_lookup_index(
    engine: AsyncEngine,
) -> None:
    plan = await _explain(
        engine,
        "SELECT payment_id FROM tournament_payment_allocations "
        "WHERE outcome = 'refund_pending' ORDER BY payment_id",
    )

    assert PENDING_REFUND_INDEX in plan


@pytest.mark.parametrize(
    "terminal_predicate",
    [
        "payment.state = 'failed' AND payment.provider_mismatch_at IS NOT NULL",
        "payment.state = 'canceled' "
        "AND payment.provider_payment_id IS NOT NULL "
        "AND payment.provider_status = 'canceled' "
        "AND payer.merged_at IS NULL "
        "AND payer.deactivated_at IS NULL "
        "AND payer.erased_at IS NULL",
    ],
)
async def test_active_checkout_repair_candidates_use_the_existing_partial_index(
    engine: AsyncEngine,
    terminal_predicate: str,
) -> None:
    plan = await _explain(
        engine,
        "SELECT payment.id FROM tournament_checkouts AS checkout "
        "JOIN tournament_payments AS payment ON payment.checkout_id = checkout.id "
        "JOIN accounts AS payer ON payer.id = checkout.payer_account_id "
        f"WHERE checkout.status = 'active' AND {terminal_predicate} "
        "ORDER BY checkout.entrant_player_id, checkout.tournament_id",
    )

    assert "uq_tournament_checkouts_active_player_tournament" in plan


async def test_receipt_migration_downgrade_removes_payment_notification_dependents(
    postgres_server_url: str,
) -> None:
    async with empty_database(postgres_server_url) as migrated:
        run_alembic(migrated.url, "upgrade", "20260921_0001")
        account_id = uuid.uuid4()
        async with migrated.begin() as connection:
            await connection.execute(
                text("INSERT INTO accounts (id) VALUES (:account_id)"),
                {"account_id": account_id},
            )
            await connection.execute(
                text(
                    "INSERT INTO notifications "
                    "(id, user_id, category, title, body) VALUES "
                    "(:payment_id, :account_id, 'payments', "
                    "'Payment needs review', 'Open checkout'), "
                    "(:tournament_id, :account_id, 'tournament', "
                    "'Entry confirmed', 'Open tournament')"
                ),
                {
                    "payment_id": uuid.uuid4(),
                    "tournament_id": uuid.uuid4(),
                    "account_id": account_id,
                },
            )
            await connection.execute(
                text(
                    "INSERT INTO notification_preferences "
                    "(id, user_id, category, channel, enabled) VALUES "
                    "(:payment_id, :account_id, 'payments', 'email', false), "
                    "(:tournament_id, :account_id, 'tournament', 'email', false)"
                ),
                {
                    "payment_id": uuid.uuid4(),
                    "tournament_id": uuid.uuid4(),
                    "account_id": account_id,
                },
            )

        run_alembic(migrated.url, "downgrade", "20260921_0000")

        async with migrated.connect() as connection:
            notification_categories = list(
                await connection.scalars(
                    text(
                        "SELECT category FROM notifications "
                        "WHERE user_id = :account_id ORDER BY category"
                    ),
                    {"account_id": account_id},
                )
            )
            preference_categories = list(
                await connection.scalars(
                    text(
                        "SELECT category FROM notification_preferences "
                        "WHERE user_id = :account_id ORDER BY category"
                    ),
                    {"account_id": account_id},
                )
            )
            payment_type_count = await connection.scalar(
                text("SELECT count(*) FROM notification_types WHERE key = 'payments'")
            )

        assert notification_categories == ["tournament"]
        assert preference_categories == ["tournament"]
        assert payment_type_count == 0
