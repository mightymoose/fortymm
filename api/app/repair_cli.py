"""Operator inspection and explicit retry of durable failures."""

import argparse
import asyncio
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app import required_repairs
from app.db import get_sessionmaker


async def execute(
    arguments: list[str] | None, factory: async_sessionmaker[AsyncSession]
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("list", help="List repairs awaiting operator retry")
    retry = subcommands.add_parser("retry", help="Make a failed repair eligible again")
    retry.add_argument("repair_id", type=uuid.UUID)
    options = parser.parse_args(arguments)
    async with factory() as db:
        if options.command == "list":
            for row in await required_repairs.failed(db):
                target = (
                    f"player={row.player_id}"
                    if row.player_id
                    else f"tournament={row.tournament_id}"
                )
                print(
                    f"{row.id} {target} generation={row.requested_generation} "
                    f"error={row.last_error}"
                )
            return 0
        if not await required_repairs.retry(
            db, options.repair_id, now=datetime.now(UTC)
        ):
            print(f"No failed repair with ID {options.repair_id}")
            return 1
        await db.commit()
    await required_repairs.recover(factory, now=datetime.now(UTC))
    print(f"Retry accepted for {options.repair_id}")
    return 0


def main() -> None:
    raise SystemExit(asyncio.run(execute(None, get_sessionmaker())))


if __name__ == "__main__":
    main()
