"""Seed the local dev database with demo RBAC data.

DEV/UAT ONLY. This script is never auto-run — not by alembic, not by the
container CMD, not by the API on startup. To seed, you must explicitly invoke
it inside a running api container, e.g.:

    docker compose -p fortymm-rbac exec api python scripts/seed_rbac.py

It is idempotent: it bails out if any permissions already exist, so re-running
won't duplicate data. Do NOT add this to production migrations or compose
commands.
"""

import asyncio

from sqlalchemy import select

from app.db import get_engine
from app.models import Permission, Role, RolePermission, User, UserRole
from sqlalchemy.ext.asyncio import async_sessionmaker


PERMISSIONS = [
    ("tournament.view", "See tournament list and details."),
    ("tournament.create", "Spin up a new tournament event."),
    ("tournament.edit", "Rename, reschedule, change format."),
    ("tournament.delete", "Permanently remove a tournament."),
    ("tournament.publish", "Publish a tournament to the spectator view."),
    ("draws.view", "View brackets and seeds."),
    ("draws.generate", "Run the SMT solver to build a draw."),
    ("draws.edit", "Re-seed or manually swap matchups."),
    ("draws.publish", "Lock the draw and notify players."),
    ("draws.lock", "Freeze a draw against further edits."),
    ("courts.view", "See live court status."),
    ("courts.assign", "Send the next match to a court."),
    ("courts.score", "Tap in points during live play."),
    ("courts.override", "Correct a posted score after the fact."),
    ("players.view", "Browse the player directory."),
    ("players.create", "Register a new player."),
    ("players.edit", "Update contact info, club, rating cap."),
    ("players.delete", "Soft-delete a player profile."),
    ("players.merge", "Combine two player records."),
    ("ratings.view", "See rating history and deltas."),
    ("ratings.recalculate", "Re-run the rating engine."),
    ("members.view", "See workspace members."),
    ("members.add", "Add a user to the workspace."),
    ("members.remove", "Remove a user from the workspace."),
    ("roles.manage", "Create, edit, and delete roles."),
    ("permissions.assign", "Attach permissions to roles."),
    ("system.view", "See system status."),
    ("system.configure", "Edit org-wide settings."),
    ("system.export", "Download backups and reports."),
]

ROLES = [
    ("Owner", "Full control of the workspace. Granted to founding admins.", "ALL"),
    (
        "Tournament Director",
        "Runs events end-to-end. Cannot edit org-wide settings.",
        [
            "tournament.view", "tournament.create", "tournament.edit", "tournament.publish",
            "draws.view", "draws.generate", "draws.edit", "draws.publish", "draws.lock",
            "courts.view", "courts.assign", "courts.score", "courts.override",
            "players.view", "players.create", "players.edit", "players.merge",
            "ratings.view", "ratings.recalculate",
            "members.view", "system.export",
        ],
    ),
    ("Scorekeeper", "Taps in points at courtside. Read-only everywhere else.",
     ["tournament.view", "draws.view", "courts.view", "courts.score", "players.view"]),
    ("Umpire", "Calls matches. Can override scores after the fact.",
     ["tournament.view", "draws.view", "courts.view", "courts.score", "courts.override", "players.view"]),
    ("Club Admin", "Manages the player roster. No live scoring.",
     ["tournament.view", "draws.view", "players.view", "players.create", "players.edit", "players.merge", "ratings.view", "members.view"]),
    ("Read-only", "Sees everything, changes nothing.", "ALL_VIEW"),
    ("Weekend Volunteer", "One-off scorer role for weekend tournaments.",
     ["tournament.view", "draws.view", "courts.view", "courts.score", "players.view"]),
]

USERS = [
    ("tim.nguyen", ["Owner"]),
    ("alex.johansen", ["Tournament Director"]),
    ("maya.okafor", ["Tournament Director", "Club Admin"]),
    ("riley.park", ["Scorekeeper"]),
    ("sam.patel", ["Scorekeeper", "Umpire"]),
    ("lin.chen", ["Umpire"]),
    ("robin.kim", ["Club Admin"]),
    ("dean.silva", ["Read-only"]),
    ("carlos.rossi", ["Read-only"]),
    ("jamie.tran", ["Weekend Volunteer", "Umpire"]),
    ("priya.desai", ["Scorekeeper"]),
    ("marcus.webb", ["Weekend Volunteer"]),
    ("eun.han", []),
]


async def seed() -> None:
    engine = get_engine()
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as db:
        existing = (await db.execute(select(Permission))).scalars().all()
        if existing:
            print(f"Already seeded ({len(existing)} permissions present); aborting.")
            return

        perms_by_name: dict[str, Permission] = {}
        for name, desc in PERMISSIONS:
            p = Permission(name=name, description=desc)
            db.add(p)
            perms_by_name[name] = p
        await db.flush()

        all_perm_ids = [p.id for p in perms_by_name.values()]
        view_perm_ids = [p.id for n, p in perms_by_name.items() if n.endswith(".view")]

        roles_by_name: dict[str, Role] = {}
        for name, desc, perms in ROLES:
            role = Role(name=name, description=desc)
            db.add(role)
            roles_by_name[name] = role
        await db.flush()

        for name, _desc, perms in ROLES:
            role = roles_by_name[name]
            if perms == "ALL":
                pids = all_perm_ids
            elif perms == "ALL_VIEW":
                pids = view_perm_ids
            else:
                pids = [perms_by_name[pn].id for pn in perms]
            for pid in pids:
                db.add(RolePermission(role_id=role.id, permission_id=pid))

        for username, role_names in USERS:
            user = User(username=username)
            db.add(user)
            await db.flush()
            for rn in role_names:
                db.add(UserRole(user_id=user.id, role_id=roles_by_name[rn].id))

        await db.commit()
        print(
            f"Seeded {len(PERMISSIONS)} permissions, {len(ROLES)} roles, {len(USERS)} users."
        )


if __name__ == "__main__":
    asyncio.run(seed())
