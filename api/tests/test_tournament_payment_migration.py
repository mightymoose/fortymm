"""Migration-level guards for the durable tournament payment schema."""

import uuid

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncEngine

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
    assert (
        "fk_tournament_payment_allocations_payment_checkout" in allocation_foreign_keys
    )
    assert "fk_tournament_payment_allocations_line_checkout" in allocation_foreign_keys


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
