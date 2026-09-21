"""Migration-level guards for the durable tournament payment schema."""

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncEngine


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
