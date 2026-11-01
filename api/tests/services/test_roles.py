import uuid
from collections.abc import Callable
from ipaddress import ip_address

import pytest
from locks import wait_behind
from sqlalchemy import Engine, text, update
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import AccountId, Email, GuestAccount, VerifiedAccount
from fortymm_api.models import Account
from fortymm_api.permissions import Permission, RoleId
from fortymm_api.services.authorization import (
    MissingPermission,
    authorize,
    permissions_of,
)
from fortymm_api.services.roles import (
    ACCOUNT_PAGE_SIZE,
    AccountNotFound,
    BuiltInPermission,
    LastAdministrator,
    PermissionKeyTaken,
    PermissionNotFound,
    PermissionSummary,
    RoleDraft,
    RoleNameTaken,
    RoleNotFound,
    RoleSummary,
    UnknownPermission,
    create_permission,
    create_role,
    delete_permission,
    delete_role,
    get_account,
    list_accounts,
    list_permissions,
    list_roles,
    set_account_roles,
    update_permission,
    update_role,
)
from fortymm_api.services.sessions import start_session

ANN = ip_address("203.0.113.7")
EVERY_PERMISSION = frozenset(Permission)
VIEWER = RoleDraft("Viewer", "Looks around.", frozenset({Permission.ADMIN_VIEW}))


def in_transaction[T](database: Engine, work: Callable[[Session], T]) -> T:
    with sessionmaker(database).begin() as session:
        return work(session)


def administrator(database: Engine) -> RoleId:
    """The role the migration made."""
    with database.connect() as connection:
        role: RoleId = connection.scalar(
            text("SELECT id FROM roles WHERE name = 'Administrator'")
        )
        return role


def verified(database: Engine, email: str, *roles: RoleId) -> AccountId:
    """A verified account with a self player, holding the roles."""

    def setup(session: Session) -> AccountId:
        account = start_session(session, None, ANN).account.id
        session.execute(
            update(Account).where(Account.id == account).values(email=Email(email))
        )
        for role in roles:
            session.execute(
                text(
                    "INSERT INTO account_roles (account_id, role_id)"
                    " VALUES (:account, :role)"
                ),
                {"account": account, "role": role},
            )
        return account

    return in_transaction(database, setup)


def admin(database: Engine, email: str = "ann@example.com") -> AccountId:
    return verified(database, email, administrator(database))


def new_role(database: Engine, actor: AccountId, draft: RoleDraft = VIEWER) -> RoleId:
    return in_transaction(
        database, lambda session: create_role(session, actor, draft)
    ).id


def roles(database: Engine) -> list[RoleSummary]:
    return in_transaction(database, list_roles)


def role_ids(database: Engine, account: AccountId) -> list[RoleId]:
    with database.connect() as connection:
        return list(
            connection.scalars(
                text(
                    "SELECT role_id FROM account_roles WHERE account_id = :account"
                    " ORDER BY role_id"
                ),
                {"account": account},
            )
        )


def test_the_built_in_permissions_are_the_ones_the_code_checks(
    migrated_database: Engine,
) -> None:
    with migrated_database.connect() as connection:
        built_in = set(
            connection.scalars(text("SELECT key FROM permissions WHERE built_in"))
        )

    assert built_in == set(Permission)


def test_the_migration_makes_an_administrator_role_with_every_permission(
    migrated_database: Engine,
) -> None:
    assert roles(migrated_database) == [
        RoleSummary(
            administrator(migrated_database),
            "Administrator",
            "Manages roles, permissions and who holds them.",
            tuple(sorted(Permission)),
            account_count=0,
        )
    ]


def test_the_first_administrator_waits_for_their_email(
    migrated_database: Engine,
) -> None:
    with migrated_database.connect() as connection:
        grants = connection.execute(
            text("SELECT email, role_id FROM email_role_grants")
        ).all()

    assert grants == [("mightymoose@fortymm.com", administrator(migrated_database))]


def test_an_account_has_the_permissions_of_all_its_roles(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    viewer = new_role(migrated_database, ann)
    bob = verified(migrated_database, "bob@example.com", viewer)

    assert in_transaction(
        migrated_database, lambda session: permissions_of(session, bob)
    ) == {Permission.ADMIN_VIEW}
    assert (
        in_transaction(migrated_database, lambda session: permissions_of(session, ann))
        == EVERY_PERMISSION
    )


def test_authorize_refuses_an_account_without_the_permission(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    bob = verified(migrated_database, "bob@example.com")

    def check(account: GuestAccount | VerifiedAccount) -> None:
        in_transaction(
            migrated_database,
            lambda session: authorize(session, account, Permission.ADMIN_VIEW),
        )

    check(VerifiedAccount(ann, Email("ann@example.com")))
    with pytest.raises(MissingPermission):
        check(VerifiedAccount(bob, Email("bob@example.com")))
    # A guest never holds a role, whatever account_roles says.
    with pytest.raises(MissingPermission):
        check(GuestAccount(ann))


def test_creates_a_role(migrated_database: Engine) -> None:
    ann = admin(migrated_database)

    created = in_transaction(
        migrated_database, lambda session: create_role(session, ann, VIEWER)
    )

    assert created == RoleSummary(
        created.id, "Viewer", "Looks around.", (Permission.ADMIN_VIEW,), 0
    )
    assert [role.name for role in roles(migrated_database)] == [
        "Administrator",
        "Viewer",
    ]


def test_lists_roles_by_name_whatever_its_case_with_their_holders(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    for name in ("banker", "Auditor"):
        new_role(migrated_database, ann, RoleDraft(name, "", frozenset()))

    assert [(role.name, role.account_count) for role in roles(migrated_database)] == [
        ("Administrator", 1),
        ("Auditor", 0),
        ("banker", 0),
    ]


def test_two_roles_cannot_share_a_name_whatever_its_case(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    taken = RoleDraft("ADMINISTRATOR", "", frozenset())

    with pytest.raises(RoleNameTaken):
        in_transaction(
            migrated_database, lambda session: create_role(session, ann, taken)
        )
    viewer = new_role(migrated_database, ann)
    with pytest.raises(RoleNameTaken):
        in_transaction(
            migrated_database,
            lambda session: update_role(session, ann, viewer, taken),
        )


def test_a_role_can_change_the_case_of_its_own_name(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    role = administrator(migrated_database)
    draft = RoleDraft("ADMINISTRATOR", "Runs the place.", EVERY_PERMISSION)

    updated = in_transaction(
        migrated_database, lambda session: update_role(session, ann, role, draft)
    )

    assert (updated.name, updated.description, updated.account_count) == (
        "ADMINISTRATOR",
        "Runs the place.",
        1,
    )


def test_an_update_sets_the_exact_permissions(migrated_database: Engine) -> None:
    ann = admin(migrated_database)
    viewer = new_role(migrated_database, ann)
    draft = RoleDraft("Viewer", "", frozenset({Permission.ROLES_MANAGE}))

    updated = in_transaction(
        migrated_database, lambda session: update_role(session, ann, viewer, draft)
    )

    assert updated.permissions == (Permission.ROLES_MANAGE,)


def test_an_unknown_role_is_not_found(migrated_database: Engine) -> None:
    ann = admin(migrated_database)
    unknown = RoleId(uuid.UUID(int=0))

    with pytest.raises(RoleNotFound):
        in_transaction(
            migrated_database,
            lambda session: update_role(session, ann, unknown, VIEWER),
        )
    with pytest.raises(RoleNotFound):
        in_transaction(
            migrated_database, lambda session: delete_role(session, ann, unknown)
        )
    with pytest.raises(RoleNotFound):
        in_transaction(
            migrated_database,
            lambda session: set_account_roles(session, ann, ann, frozenset({unknown})),
        )


def test_deleting_a_role_takes_it_from_its_accounts(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    viewer = new_role(migrated_database, ann)
    bob = verified(migrated_database, "bob@example.com", viewer)

    in_transaction(migrated_database, lambda session: delete_role(session, ann, viewer))

    assert [role.name for role in roles(migrated_database)] == ["Administrator"]
    assert role_ids(migrated_database, bob) == []


def test_an_account_without_the_permission_cannot_write(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    viewer = new_role(migrated_database, ann)
    bob = verified(migrated_database, "bob@example.com", viewer)

    with pytest.raises(MissingPermission):
        in_transaction(
            migrated_database, lambda session: create_role(session, bob, VIEWER)
        )
    with pytest.raises(MissingPermission):
        in_transaction(
            migrated_database,
            lambda session: set_account_roles(session, bob, bob, frozenset()),
        )


def test_the_last_administrator_cannot_revoke_their_own_role(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)

    with pytest.raises(LastAdministrator):
        in_transaction(
            migrated_database,
            lambda session: set_account_roles(session, ann, ann, frozenset()),
        )
    assert role_ids(migrated_database, ann) == [administrator(migrated_database)]


def test_the_last_role_that_grants_roles_keeps_that_permission(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    role = administrator(migrated_database)
    draft = RoleDraft(
        "Administrator", "", frozenset({Permission.ADMIN_VIEW, Permission.ROLES_MANAGE})
    )

    with pytest.raises(LastAdministrator):
        in_transaction(
            migrated_database, lambda session: update_role(session, ann, role, draft)
        )


def test_the_last_role_that_grants_roles_cannot_be_deleted(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    role = administrator(migrated_database)

    with pytest.raises(LastAdministrator):
        in_transaction(
            migrated_database, lambda session: delete_role(session, ann, role)
        )


def test_an_administrator_can_leave_once_another_remains(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    admin(migrated_database, "bob@example.com")

    in_transaction(
        migrated_database,
        lambda session: set_account_roles(session, ann, ann, frozenset()),
    )

    assert role_ids(migrated_database, ann) == []


def test_sets_an_accounts_exact_roles(migrated_database: Engine) -> None:
    ann = admin(migrated_database)
    viewer = new_role(migrated_database, ann)
    bob = verified(migrated_database, "bob@example.com")
    both = frozenset({viewer, administrator(migrated_database)})

    updated = in_transaction(
        migrated_database,
        lambda session: set_account_roles(session, ann, bob, both),
    )

    assert updated.role_ids == tuple(sorted(both))
    with migrated_database.connect() as connection:
        granted_by = set(
            connection.scalars(
                text("SELECT granted_by FROM account_roles WHERE account_id = :bob"),
                {"bob": bob},
            )
        )
    assert granted_by == {ann}


def test_only_a_verified_account_holds_a_role(migrated_database: Engine) -> None:
    ann = admin(migrated_database)
    guest = in_transaction(
        migrated_database, lambda session: start_session(session, None, ANN)
    ).account.id
    role = frozenset({administrator(migrated_database)})

    with pytest.raises(AccountNotFound):
        in_transaction(
            migrated_database,
            lambda session: set_account_roles(session, ann, guest, role),
        )


def test_gets_an_account_with_every_role_and_which_it_holds(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    viewer = new_role(migrated_database, ann)
    bob = verified(migrated_database, "bob@example.com", viewer)

    found = in_transaction(migrated_database, lambda session: get_account(session, bob))

    assert (found.id, found.email) == (bob, "bob@example.com")
    assert found.display_name is not None
    assert [(role.name, role.held) for role in found.roles] == [
        ("Administrator", False),
        ("Viewer", True),
    ]


def test_getting_a_guest_account_is_not_found(migrated_database: Engine) -> None:
    guest = in_transaction(
        migrated_database, lambda session: start_session(session, None, ANN)
    ).account.id

    with pytest.raises(AccountNotFound):
        in_transaction(migrated_database, lambda session: get_account(session, guest))


def test_lists_verified_accounts_by_email(migrated_database: Engine) -> None:
    ann = admin(migrated_database)
    bob = verified(migrated_database, "bob@example.com")
    in_transaction(migrated_database, lambda session: start_session(session, None, ANN))

    page = in_transaction(
        migrated_database, lambda session: list_accounts(session, None)
    )

    assert [(account.id, account.email) for account in page.accounts] == [
        (ann, "ann@example.com"),
        (bob, "bob@example.com"),
    ]
    assert page.accounts[0].role_ids == (administrator(migrated_database),)
    assert page.accounts[1].display_name is not None
    assert not page.has_more


def test_filters_accounts_by_email_whatever_its_case(
    migrated_database: Engine,
) -> None:
    verified(migrated_database, "ann@example.com")
    bob = verified(migrated_database, "bob_100%@example.com")

    page = in_transaction(
        migrated_database, lambda session: list_accounts(session, " B_100% ")
    )

    assert [account.id for account in page.accounts] == [bob]


def test_says_when_more_accounts_match_than_a_page_holds(
    migrated_database: Engine,
) -> None:
    with migrated_database.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO accounts (email)"
                " SELECT 'player' || n || '@example.com'"
                " FROM generate_series(0, :count) AS n"
            ),
            {"count": ACCOUNT_PAGE_SIZE},
        )

    page = in_transaction(migrated_database, lambda session: list_accounts(session, ""))

    assert len(page.accounts) == ACCOUNT_PAGE_SIZE
    assert page.has_more


def test_two_administrators_cannot_revoke_each_other_at_once(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    bob = admin(migrated_database, "bob@example.com")

    _, bobs_revoke = wait_behind(
        migrated_database,
        lambda session: set_account_roles(session, ann, bob, frozenset()),
        lambda session: set_account_roles(session, bob, ann, frozenset()),
    )

    with pytest.raises(MissingPermission):
        bobs_revoke.result()
    assert role_ids(migrated_database, ann) == [administrator(migrated_database)]


def permissions(database: Engine) -> list[PermissionSummary]:
    return in_transaction(database, list_permissions)


def add_permission(database: Engine, actor: AccountId, key: str) -> None:
    in_transaction(
        database,
        lambda session: create_permission(session, actor, key, "Records a game."),
    )


def test_adds_a_permission_that_no_code_checks_yet(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)

    add_permission(migrated_database, ann, "games.record")

    assert PermissionSummary("games.record", "Records a game.", False, 0) in (
        permissions(migrated_database)
    )


def test_lists_permissions_by_key_with_the_roles_that_grant_them(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    new_role(migrated_database, ann)

    assert [
        (permission.key, permission.built_in, permission.role_count)
        for permission in permissions(migrated_database)
    ] == [
        ("account_roles.manage", True, 1),
        ("admin.view", True, 2),
        ("roles.manage", True, 1),
    ]


def test_two_permissions_cannot_share_a_key(migrated_database: Engine) -> None:
    ann = admin(migrated_database)
    add_permission(migrated_database, ann, "games.record")

    with pytest.raises(PermissionKeyTaken):
        add_permission(migrated_database, ann, "games.record")


def test_updates_a_permissions_description(migrated_database: Engine) -> None:
    ann = admin(migrated_database)

    updated = in_transaction(
        migrated_database,
        lambda session: update_permission(session, ann, "admin.view", "Look."),
    )

    assert updated == PermissionSummary("admin.view", "Look.", True, 1)


def test_an_unknown_permission_is_not_found(migrated_database: Engine) -> None:
    ann = admin(migrated_database)

    with pytest.raises(PermissionNotFound):
        in_transaction(
            migrated_database,
            lambda session: update_permission(session, ann, "games.record", ""),
        )
    with pytest.raises(PermissionNotFound):
        in_transaction(
            migrated_database,
            lambda session: delete_permission(session, ann, "games.record"),
        )


def test_a_built_in_permission_cannot_be_deleted(migrated_database: Engine) -> None:
    ann = admin(migrated_database)

    with pytest.raises(BuiltInPermission):
        in_transaction(
            migrated_database,
            lambda session: delete_permission(session, ann, "admin.view"),
        )


def test_deleting_a_permission_takes_it_from_every_role(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    add_permission(migrated_database, ann, "games.record")
    coach = new_role(
        migrated_database, ann, RoleDraft("Coach", "", frozenset({"games.record"}))
    )
    bob = verified(migrated_database, "bob@example.com", coach)

    in_transaction(
        migrated_database,
        lambda session: delete_permission(session, ann, "games.record"),
    )

    assert [role.permissions for role in roles(migrated_database)] == [
        tuple(sorted(Permission)),
        (),
    ]
    assert (
        in_transaction(migrated_database, lambda session: permissions_of(session, bob))
        == frozenset()
    )


def test_an_account_has_its_roles_custom_permissions(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    add_permission(migrated_database, ann, "games.record")
    coach = new_role(
        migrated_database, ann, RoleDraft("Coach", "", frozenset({"games.record"}))
    )
    bob = verified(migrated_database, "bob@example.com", coach)

    assert in_transaction(
        migrated_database, lambda session: permissions_of(session, bob)
    ) == {"games.record"}


def test_a_role_cannot_grant_an_unknown_permission(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    draft = RoleDraft("Coach", "", frozenset({"games.record"}))

    with pytest.raises(UnknownPermission):
        new_role(migrated_database, ann, draft)
    with pytest.raises(UnknownPermission):
        in_transaction(
            migrated_database,
            lambda session: update_role(
                session, ann, administrator(migrated_database), draft
            ),
        )


def test_an_account_without_roles_manage_cannot_change_permissions(
    migrated_database: Engine,
) -> None:
    ann = admin(migrated_database)
    bob = verified(
        migrated_database, "bob@example.com", new_role(migrated_database, ann)
    )

    with pytest.raises(MissingPermission):
        add_permission(migrated_database, bob, "games.record")
