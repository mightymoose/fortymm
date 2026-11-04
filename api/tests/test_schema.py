import hashlib
import uuid
from collections.abc import Iterator

import psycopg
import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import IntegrityError, ProgrammingError

from fortymm_api.services.signing_keys import LABEL_MAX_LENGTH
from fortymm_api.signing_keys import SigningPrivateKey


@pytest.fixture
def connection(migrated_database: Engine) -> Iterator[Connection]:
    with migrated_database.connect() as connection:
        yield connection


def add_account(connection: Connection) -> uuid.UUID:
    id: uuid.UUID = connection.scalar(
        text("INSERT INTO accounts DEFAULT VALUES RETURNING id")
    )
    return id


def add_player(connection: Connection, display_name: str = "Ann") -> uuid.UUID:
    id: uuid.UUID = connection.scalar(
        text("INSERT INTO players (display_name) VALUES (:name) RETURNING id"),
        {"name": display_name},
    )
    return id


def add_manager(
    connection: Connection,
    player_id: uuid.UUID,
    account_id: uuid.UUID,
    relationship: str = "self",
) -> None:
    connection.execute(
        text(
            "INSERT INTO player_managers (player_id, account_id, relationship)"
            " VALUES (:player_id, :account_id, :relationship)"
        ),
        {
            "player_id": player_id,
            "account_id": account_id,
            "relationship": relationship,
        },
    )


def add_session(
    connection: Connection, account_id: uuid.UUID, token_hash: bytes
) -> None:
    connection.execute(
        text(
            "INSERT INTO sessions (token_hash, account_id, expires_at)"
            " VALUES (:token_hash, :account_id, now() + interval '1 day')"
        ),
        {"token_hash": token_hash, "account_id": account_id},
    )


def violated_constraint(error: pytest.ExceptionInfo[IntegrityError]) -> str | None:
    orig = error.value.orig
    assert isinstance(orig, psycopg.Error)
    return orig.diag.constraint_name


def test_an_email_is_lowercase(connection: Connection) -> None:
    with pytest.raises(IntegrityError) as error:
        connection.execute(text("INSERT INTO accounts (email) VALUES ('Ann@x.com')"))

    assert violated_constraint(error) == "ck_accounts_email_lowercase"


def test_an_account_cannot_be_adopted_into_itself(connection: Connection) -> None:
    account = add_account(connection)

    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text("UPDATE accounts SET adopted_into = id WHERE id = :id"),
            {"id": account},
        )

    assert violated_constraint(error) == "ck_accounts_not_adopted_into_self"


def test_a_player_cannot_be_merged_into_itself(connection: Connection) -> None:
    player = add_player(connection)

    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text("UPDATE players SET merged_into = id WHERE id = :id"),
            {"id": player},
        )

    assert violated_constraint(error) == "ck_players_not_merged_into_self"


def test_a_player_is_never_deleted(connection: Connection) -> None:
    player = add_player(connection)

    with pytest.raises(ProgrammingError, match="players are never deleted"):
        connection.execute(text("DELETE FROM players WHERE id = :id"), {"id": player})


def test_display_names_are_unique_whatever_their_case(
    connection: Connection,
) -> None:
    add_player(connection, "Ann")

    with pytest.raises(IntegrityError) as error:
        add_player(connection, "aNN")

    assert violated_constraint(error) == "unique_display_name"


def test_a_merged_player_gives_up_its_display_name(connection: Connection) -> None:
    survivor = add_player(connection, "Ann")
    merged = add_player(connection, "Bob")
    connection.execute(
        text("UPDATE players SET merged_into = :survivor WHERE id = :merged"),
        {"survivor": survivor, "merged": merged},
    )

    add_player(connection, "bob")


def test_unique_display_name_skips_merged_players(connection: Connection) -> None:
    # alembic check doesn't compare an index's WHERE clause.
    indexdef = connection.scalar(
        text(
            "SELECT indexdef FROM pg_indexes"
            " WHERE tablename = 'players' AND indexname = 'unique_display_name'"
        )
    )

    assert indexdef == (
        "CREATE UNIQUE INDEX unique_display_name ON public.players"
        " USING btree (lower(display_name)) WHERE (merged_into IS NULL)"
    )


def test_an_account_has_at_most_one_self_player(connection: Connection) -> None:
    account = add_account(connection)
    add_manager(connection, add_player(connection, "Ann"), account)

    with pytest.raises(IntegrityError) as error:
        add_manager(connection, add_player(connection, "Bob"), account)

    assert violated_constraint(error) == "one_self_player_per_account"


def test_an_account_can_manage_other_players_beside_its_self_player(
    connection: Connection,
) -> None:
    account = add_account(connection)
    add_manager(connection, add_player(connection, "Ann"), account)
    add_manager(connection, add_player(connection, "Bob"), account, "managed")
    add_manager(connection, add_player(connection, "Cy"), account, "managed")


def test_a_player_has_at_most_one_self_account(connection: Connection) -> None:
    player = add_player(connection)
    add_manager(connection, player, add_account(connection))

    with pytest.raises(IntegrityError) as error:
        add_manager(connection, player, add_account(connection))

    assert violated_constraint(error) == "one_self_account_per_player"


def test_a_player_can_have_managers_beside_its_self_account(
    connection: Connection,
) -> None:
    player = add_player(connection)
    add_manager(connection, player, add_account(connection))
    add_manager(connection, player, add_account(connection), "managed")
    add_manager(connection, player, add_account(connection), "managed")


def test_an_account_manages_a_player_once(connection: Connection) -> None:
    player = add_player(connection)
    account = add_account(connection)
    add_manager(connection, player, account, "managed")

    with pytest.raises(IntegrityError) as error:
        add_manager(connection, player, account, "managed")

    assert violated_constraint(error) == "uq_player_managers_player_id"


def test_two_sessions_cannot_share_a_token_hash(connection: Connection) -> None:
    token_hash = uuid.uuid4().bytes
    add_session(connection, add_account(connection), token_hash)

    with pytest.raises(IntegrityError) as error:
        add_session(connection, add_account(connection), token_hash)

    assert violated_constraint(error) == "uq_sessions_token_hash"


def test_a_network_has_one_guest_account_count(connection: Connection) -> None:
    insert = text(
        "INSERT INTO guest_account_counts (network, window_ends_at, started)"
        " VALUES ('203.0.113.7/32', now(), 1)"
    )
    connection.execute(insert)

    with pytest.raises(IntegrityError) as error:
        connection.execute(insert)

    assert violated_constraint(error) == "pk_guest_account_counts"


def add_identity(connection: Connection, sub: str) -> None:
    connection.execute(
        text("INSERT INTO identities (auth0_sub, account_id) VALUES (:sub, :id)"),
        {"sub": sub, "id": add_account(connection)},
    )


def test_two_identities_cannot_share_a_sub(connection: Connection) -> None:
    add_identity(connection, "auth0|ann")

    with pytest.raises(IntegrityError) as error:
        add_identity(connection, "auth0|ann")

    assert violated_constraint(error) == "uq_identities_auth0_sub"


def add_login_attempt(connection: Connection, state: str) -> uuid.UUID:
    session_id: uuid.UUID = connection.scalar(
        text(
            "INSERT INTO sessions (token_hash, account_id, expires_at)"
            " VALUES (:token_hash, :account_id, now() + interval '1 day')"
            " RETURNING id"
        ),
        {"token_hash": uuid.uuid4().bytes, "account_id": add_account(connection)},
    )
    connection.execute(
        text(
            "INSERT INTO login_attempts (state, started_with_session, session_id,"
            " code_verifier, nonce, return_to, expires_at)"
            " VALUES (:state, true, :session_id, 'v', 'n', '/', now())"
        ),
        {"state": state, "session_id": session_id},
    )
    return session_id


def test_two_login_attempts_cannot_share_a_state(connection: Connection) -> None:
    add_login_attempt(connection, "s")

    with pytest.raises(IntegrityError) as error:
        add_login_attempt(connection, "s")

    assert violated_constraint(error) == "uq_login_attempts_state"


def test_deleting_a_session_keeps_its_login_attempts(
    connection: Connection,
) -> None:
    session_id = add_login_attempt(connection, "s")

    connection.execute(text("DELETE FROM sessions WHERE id = :id"), {"id": session_id})

    assert connection.execute(
        text("SELECT started_with_session, session_id FROM login_attempts")
    ).one() == (True, None)


def test_a_login_attempt_without_a_session_at_start_has_no_session(
    connection: Connection,
) -> None:
    session_id = add_login_attempt(connection, "s")

    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text(
                "UPDATE login_attempts SET started_with_session = false"
                " WHERE session_id = :id"
            ),
            {"id": session_id},
        )

    assert (
        violated_constraint(error)
        == "ck_login_attempts_session_only_if_started_with_one"
    )


def add_role(connection: Connection, name: str) -> uuid.UUID:
    id: uuid.UUID = connection.scalar(
        text("INSERT INTO roles (name) VALUES (:name) RETURNING id"), {"name": name}
    )
    return id


def test_role_names_are_unique_whatever_their_case(connection: Connection) -> None:
    add_role(connection, "Coach")

    with pytest.raises(IntegrityError) as error:
        add_role(connection, "cOACH")

    assert violated_constraint(error) == "unique_role_name"


@pytest.mark.parametrize(
    ("name", "constraint"),
    [
        (" Coach", "ck_roles_name_trimmed"),
        ("Coach ", "ck_roles_name_trimmed"),
        ("", "ck_roles_name_trimmed"),
        ("x" * 51, "ck_roles_name_length"),
    ],
)
def test_a_role_name_is_trimmed_and_short(
    connection: Connection, name: str, constraint: str
) -> None:
    with pytest.raises(IntegrityError) as error:
        add_role(connection, name)

    assert violated_constraint(error) == constraint


def test_an_account_holds_a_role_once(connection: Connection) -> None:
    grant = text("INSERT INTO account_roles (account_id, role_id) VALUES (:a, :r)")
    params = {"a": add_account(connection), "r": add_role(connection, "Coach")}
    connection.execute(grant, params)

    with pytest.raises(IntegrityError) as error:
        connection.execute(grant, params)

    assert violated_constraint(error) == "pk_account_roles"


def test_an_email_role_grant_is_lowercase(connection: Connection) -> None:
    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text(
                "INSERT INTO email_role_grants (email, role_id)"
                " VALUES ('Ann@x.com', :role)"
            ),
            {"role": add_role(connection, "Coach")},
        )

    assert violated_constraint(error) == "ck_email_role_grants_email_lowercase"


def test_deleting_a_permission_takes_it_from_its_roles(
    connection: Connection,
) -> None:
    role = add_role(connection, "Coach")
    connection.execute(text("INSERT INTO permissions (key) VALUES ('games.record')"))
    connection.execute(
        text(
            "INSERT INTO role_permissions (role_id, permission_key)"
            " VALUES (:role, 'games.record')"
        ),
        {"role": role},
    )

    connection.execute(text("DELETE FROM permissions WHERE key = 'games.record'"))

    assert (
        connection.scalar(
            text("SELECT count(*) FROM role_permissions WHERE role_id = :role"),
            {"role": role},
        )
        == 0
    )


def test_a_role_permission_names_a_known_permission(connection: Connection) -> None:
    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text(
                "INSERT INTO role_permissions (role_id, permission_key)"
                " VALUES (:role, 'games.cheat')"
            ),
            {"role": add_role(connection, "Coach")},
        )

    assert (
        violated_constraint(error) == "fk_role_permissions_permission_key_permissions"
    )


def test_deleting_a_role_deletes_its_grants(connection: Connection) -> None:
    role = add_role(connection, "Coach")
    account = add_account(connection)
    for grant in (
        "INSERT INTO role_permissions (role_id, permission_key)"
        " VALUES (:role, 'admin.view')",
        "INSERT INTO account_roles (account_id, role_id, granted_by)"
        " VALUES (:account, :role, :account)",
        "INSERT INTO email_role_grants (email, role_id) VALUES ('a@x.com', :role)",
    ):
        connection.execute(text(grant), {"role": role, "account": account})

    connection.execute(text("DELETE FROM roles WHERE id = :role"), {"role": role})

    for table in ("role_permissions", "account_roles", "email_role_grants"):
        assert (
            connection.scalar(
                text(f"SELECT count(*) FROM {table} WHERE role_id = :role"),
                {"role": role},
            )
            == 0
        )


def test_unique_role_name_is_on_the_lowercase_name(connection: Connection) -> None:
    indexdef = connection.scalar(
        text(
            "SELECT indexdef FROM pg_indexes"
            " WHERE tablename = 'roles' AND indexname = 'unique_role_name'"
        )
    )

    assert indexdef == (
        "CREATE UNIQUE INDEX unique_role_name ON public.roles USING btree (lower(name))"
    )


@pytest.mark.parametrize(
    ("key", "constraint"),
    [
        ("Games.record", "ck_permissions_key_format"),
        ("games..record", "ck_permissions_key_format"),
        ("games.record.", "ck_permissions_key_format"),
        ("1games", "ck_permissions_key_format"),
        ("games record", "ck_permissions_key_format"),
        ("g" * 65, "ck_permissions_key_length"),
    ],
)
def test_a_permission_key_is_a_short_lowercase_dotted_slug(
    connection: Connection, key: str, constraint: str
) -> None:
    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text("INSERT INTO permissions (key) VALUES (:key)"), {"key": key}
        )

    assert violated_constraint(error) == constraint


def test_a_permission_key_can_hold_digits_and_underscores(
    connection: Connection,
) -> None:
    connection.execute(text("INSERT INTO permissions (key) VALUES ('games_2.record')"))


def test_one_default_league_is_on_default_leagues_only(
    connection: Connection,
) -> None:
    indexdef = connection.scalar(
        text(
            "SELECT indexdef FROM pg_indexes"
            " WHERE tablename = 'leagues' AND indexname = 'one_default_league'"
        )
    )

    assert indexdef == (
        "CREATE UNIQUE INDEX one_default_league ON public.leagues"
        " USING btree (is_default) WHERE is_default"
    )


def test_one_default_role_is_on_default_roles_only(connection: Connection) -> None:
    indexdef = connection.scalar(
        text(
            "SELECT indexdef FROM pg_indexes"
            " WHERE tablename = 'roles' AND indexname = 'one_default_role'"
        )
    )

    assert indexdef == (
        "CREATE UNIQUE INDEX one_default_role ON public.roles"
        " USING btree (is_default) WHERE is_default"
    )


def test_there_is_at_most_one_default_role(connection: Connection) -> None:
    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text("INSERT INTO roles (name, is_default) VALUES ('Member', true)")
        )

    assert violated_constraint(error) == "one_default_role"


def test_unique_league_name_is_on_the_lowercase_name(connection: Connection) -> None:
    indexdef = connection.scalar(
        text(
            "SELECT indexdef FROM pg_indexes"
            " WHERE tablename = 'leagues' AND indexname = 'unique_league_name'"
        )
    )

    assert indexdef == (
        "CREATE UNIQUE INDEX unique_league_name ON public.leagues"
        " USING btree (lower(name))"
    )


def test_a_new_player_joins_the_default_league(connection: Connection) -> None:
    # alembic check doesn't see triggers.
    trigger = connection.execute(
        text(
            "SELECT tgenabled, pg_get_triggerdef(oid) FROM pg_trigger"
            " WHERE tgname = 'players_join_default_league'"
        )
    ).one()

    assert trigger == (
        "O",
        "CREATE TRIGGER players_join_default_league AFTER INSERT ON public.players"
        " FOR EACH ROW EXECUTE FUNCTION join_default_league()",
    )


def test_there_is_at_most_one_default_league(connection: Connection) -> None:
    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text("INSERT INTO leagues (name, is_default) VALUES ('Club', true)")
        )

    assert violated_constraint(error) == "one_default_league"


def test_league_names_are_unique_whatever_their_case(connection: Connection) -> None:
    with pytest.raises(IntegrityError) as error:
        connection.execute(text("INSERT INTO leagues (name) VALUES ('fortymm')"))

    assert violated_constraint(error) == "unique_league_name"


@pytest.mark.parametrize(
    ("name", "constraint"),
    [
        (" Club", "ck_leagues_name_trimmed"),
        ("", "ck_leagues_name_trimmed"),
        ("x" * 51, "ck_leagues_name_length"),
    ],
)
def test_a_league_name_is_trimmed_and_short(
    connection: Connection, name: str, constraint: str
) -> None:
    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text("INSERT INTO leagues (name) VALUES (:name)"), {"name": name}
        )

    assert violated_constraint(error) == constraint


def test_a_league_with_members_is_never_deleted(connection: Connection) -> None:
    add_player(connection)

    with pytest.raises(IntegrityError) as error:
        connection.execute(text("DELETE FROM leagues"))

    assert violated_constraint(error) == "fk_league_members_league_id_leagues"


COSE_KEY = SigningPrivateKey(hashlib.sha256(b"schema test key").digest()).public_key


def add_signing_key(
    connection: Connection,
    account_id: uuid.UUID,
    *,
    public_key: bytes = COSE_KEY.to_cose_key(),
    id: bytes | None = None,
    label: str = "Ann's phone",
) -> None:
    connection.execute(
        text(
            "INSERT INTO signing_keys (id, public_key, account_id, label)"
            " VALUES (:id, :public_key, :account_id, :label)"
        ),
        {
            "id": hashlib.sha256(public_key).digest() if id is None else id,
            "public_key": public_key,
            "account_id": account_id,
            "label": label,
        },
    )


def test_a_signing_keys_id_is_its_public_keys_thumbprint(
    connection: Connection,
) -> None:
    with pytest.raises(IntegrityError) as error:
        add_signing_key(connection, add_account(connection), id=bytes(32))

    assert violated_constraint(error) == "ck_signing_keys_id_is_thumbprint"


def test_a_signing_keys_public_key_is_75_bytes(connection: Connection) -> None:
    with pytest.raises(IntegrityError) as error:
        add_signing_key(
            connection, add_account(connection), public_key=COSE_KEY.to_cose_key()[:74]
        )

    assert violated_constraint(error) == "ck_signing_keys_public_key_length"


@pytest.mark.parametrize(
    ("label", "constraint"),
    [
        (" Ann's phone", "ck_signing_keys_label_trimmed"),
        ("Ann's phone ", "ck_signing_keys_label_trimmed"),
        ("", "ck_signing_keys_label_trimmed"),
        ("x" * 51, "ck_signing_keys_label_length"),
    ],
)
def test_a_signing_key_label_is_trimmed_and_short(
    connection: Connection, label: str, constraint: str
) -> None:
    with pytest.raises(IntegrityError) as error:
        add_signing_key(connection, add_account(connection), label=label)

    assert violated_constraint(error) == constraint


def test_the_label_length_check_matches_the_services_limit(
    connection: Connection,
) -> None:
    add_signing_key(connection, add_account(connection), label="x" * LABEL_MAX_LENGTH)

    with pytest.raises(IntegrityError) as error:
        add_signing_key(
            connection,
            add_account(connection),
            public_key=SigningPrivateKey(
                hashlib.sha256(b"another schema test key").digest()
            ).public_key.to_cose_key(),
            label="x" * (LABEL_MAX_LENGTH + 1),
        )

    assert violated_constraint(error) == "ck_signing_keys_label_length"


def test_a_signing_key_is_registered_once(connection: Connection) -> None:
    add_signing_key(connection, add_account(connection))

    with pytest.raises(IntegrityError) as error:
        add_signing_key(connection, add_account(connection))

    assert violated_constraint(error) == "pk_signing_keys"


def test_an_account_with_a_signing_key_is_never_deleted(
    connection: Connection,
) -> None:
    account = add_account(connection)
    add_signing_key(connection, account)

    with pytest.raises(IntegrityError) as error:
        connection.execute(text("DELETE FROM accounts WHERE id = :id"), {"id": account})

    assert violated_constraint(error) == "fk_signing_keys_account_id_accounts"


def test_signing_keys_are_indexed_by_account(connection: Connection) -> None:
    indexdef = connection.scalar(
        text(
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'signing_keys'"
            " AND indexname = 'ix_signing_keys_account_id'"
        )
    )

    assert indexdef == (
        "CREATE INDEX ix_signing_keys_account_id ON public.signing_keys"
        " USING btree (account_id)"
    )


@pytest.mark.parametrize(
    "values",
    ["revoked_at = now()", "revoked_by = account_id"],
)
def test_a_signing_key_is_revoked_by_someone_and_only_a_revoked_one(
    connection: Connection, values: str
) -> None:
    add_signing_key(connection, add_account(connection))

    with pytest.raises(IntegrityError) as error:
        connection.execute(text(f"UPDATE signing_keys SET {values}"))

    assert violated_constraint(error) == "ck_signing_keys_revoked_by_with_revoked_at"


def add_match(
    connection: Connection,
    sides: list[list[uuid.UUID]] | None = None,
    *,
    best_of: int = 5,
) -> uuid.UUID:
    """A match whose sides hold `sides`' players, by default one new player
    each. The sides check runs at commit."""
    settings = connection.scalar(
        text(
            "INSERT INTO match_settings (team_size, best_of, rated)"
            " VALUES (1, :best_of, true) RETURNING id"
        ),
        {"best_of": best_of},
    )
    match = uuid.uuid4()
    connection.execute(
        text(
            "INSERT INTO matches (id, settings_id, league_id)"
            " SELECT :id, :settings, id FROM leagues WHERE is_default"
        ),
        {"id": match, "settings": settings},
    )
    if sides is None:
        sides = [
            [add_player(connection, f"Ann {match}")],
            [add_player(connection, f"Bea {match}")],
        ]
    for number, players in enumerate(sides):
        side = connection.scalar(
            text(
                "INSERT INTO match_sides (match_id, side)"
                " VALUES (:match, :side) RETURNING id"
            ),
            {"match": match, "side": number},
        )
        for player in players:
            connection.execute(
                text(
                    "INSERT INTO match_side_players"
                    " (match_side_id, match_id, player_id)"
                    " VALUES (:side, :match, :player)"
                ),
                {"side": side, "match": match, "player": player},
            )
    return match


def add_result(
    connection: Connection,
    match: uuid.UUID,
    payload: bytes,
    replaces: uuid.UUID | None = None,
) -> uuid.UUID:
    id: uuid.UUID = connection.scalar(
        text(
            "INSERT INTO match_results (match_id, payload, replaces_id)"
            " VALUES (:match, :payload, :replaces) RETURNING id"
        ),
        {"match": match, "payload": payload, "replaces": replaces},
    )
    return id


def add_submission(
    connection: Connection, match: uuid.UUID, result: uuid.UUID | None = None
) -> int:
    id: int = connection.scalar(
        text(
            "INSERT INTO match_submissions (match_id, kind, body, outcome, result_id)"
            " VALUES (:match, 'result', '\\x00', 'accepted', :result) RETURNING id"
        ),
        {"match": match, "result": result},
    )
    return id


def accept(connection: Connection, result: uuid.UUID) -> None:
    connection.execute(
        text("UPDATE match_results SET accepted_at = now() WHERE id = :id"),
        {"id": result},
    )


def test_a_match_has_two_sides_of_one_player_each(connection: Connection) -> None:
    add_match(connection)

    connection.commit()


def test_a_match_with_one_side_is_refused_at_commit(connection: Connection) -> None:
    add_match(connection, [[add_player(connection)]])

    with pytest.raises(IntegrityError, match="two sides of team_size players"):
        connection.commit()


def test_a_match_has_no_third_side(connection: Connection) -> None:
    players = [[add_player(connection, name)] for name in ("Ann", "Bea", "Cy")]

    with pytest.raises(IntegrityError) as error:
        add_match(connection, players)

    assert violated_constraint(error) == "ck_match_sides_side"


def test_a_singles_side_with_two_players_is_refused_at_commit(
    connection: Connection,
) -> None:
    ann, bea, cy = (add_player(connection, name) for name in ("Ann", "Bea", "Cy"))
    add_match(connection, [[ann, bea], [cy]])

    with pytest.raises(IntegrityError, match="two sides of team_size players"):
        connection.commit()


def test_a_player_is_on_one_side_of_a_match(connection: Connection) -> None:
    ann = add_player(connection)

    with pytest.raises(IntegrityError) as error:
        add_match(connection, [[ann], [ann]])

    assert violated_constraint(error) == "uq_match_side_players_match_id"


@pytest.mark.parametrize(
    ("best_of", "allowed"), [(1, True), (3, True), (7, True), (2, False), (9, False)]
)
def test_a_match_is_best_of_1_3_5_or_7(
    connection: Connection, best_of: int, allowed: bool
) -> None:
    if allowed:
        add_match(connection, best_of=best_of)
        return
    with pytest.raises(IntegrityError) as error:
        add_match(connection, best_of=best_of)

    assert violated_constraint(error) == "ck_match_settings_best_of"


def test_doubles_waits_for_the_next_result_format(connection: Connection) -> None:
    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text(
                "INSERT INTO match_settings (team_size, best_of, rated)"
                " VALUES (2, 5, true)"
            )
        )

    assert violated_constraint(error) == "ck_match_settings_singles_only"


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE match_settings SET rated = false",
        "DELETE FROM match_sides",
        "UPDATE match_side_players SET player_id = player_id",
    ],
)
def test_a_matchs_settings_and_sides_never_change(
    connection: Connection, statement: str
) -> None:
    add_match(connection)

    with pytest.raises(ProgrammingError, match="rows never change"):
        connection.execute(text(statement))


def test_a_match_is_never_deleted(connection: Connection) -> None:
    add_match(connection)

    with pytest.raises(ProgrammingError, match="matches are never deleted"):
        connection.execute(text("DELETE FROM matches"))


def test_a_match_changes_only_its_current_result(connection: Connection) -> None:
    add_match(connection)

    with pytest.raises(ProgrammingError, match="changes only its current result"):
        connection.execute(
            text("UPDATE matches SET created_at = created_at - interval '1 day'")
        )


def test_a_matchs_current_result_is_an_accepted_one(connection: Connection) -> None:
    match = add_match(connection)
    result = add_result(connection, match, b"first")
    update = text("UPDATE matches SET current_result_id = :result WHERE id = :match")

    with (
        pytest.raises(ProgrammingError, match="current result is its accepted head"),
        connection.begin_nested(),
    ):
        connection.execute(update, {"result": result, "match": match})

    accept(connection, result)
    connection.execute(update, {"result": result, "match": match})


def test_a_matchs_current_result_is_its_own(connection: Connection) -> None:
    match, other = add_match(connection), add_match(connection)
    result = add_result(connection, other, b"other's")
    accept(connection, result)

    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text("UPDATE matches SET current_result_id = :result WHERE id = :match"),
            {"result": result, "match": match},
        )

    assert violated_constraint(error) == "fk_matches_current_result_id_match_results"


def test_a_match_starts_with_no_current_result(connection: Connection) -> None:
    settings = connection.scalar(
        text(
            "INSERT INTO match_settings (team_size, best_of, rated)"
            " VALUES (1, 5, true) RETURNING id"
        )
    )

    with pytest.raises(ProgrammingError, match="starts with no current result"):
        connection.execute(
            text(
                "INSERT INTO matches (id, settings_id, league_id, current_result_id)"
                " SELECT gen_random_uuid(), :settings, id, gen_random_uuid()"
                " FROM leagues WHERE is_default"
            ),
            {"settings": settings},
        )


def make_current(connection: Connection, match: uuid.UUID, result: uuid.UUID) -> None:
    connection.execute(
        text("UPDATE matches SET current_result_id = :result WHERE id = :match"),
        {"result": result, "match": match},
    )


def test_a_final_match_stays_final(connection: Connection) -> None:
    match = add_match(connection)
    result = add_result(connection, match, b"3-1")
    accept(connection, result)
    make_current(connection, match, result)

    with pytest.raises(ProgrammingError, match="a final match stays final"):
        connection.execute(text("UPDATE matches SET current_result_id = NULL"))


def test_a_matchs_current_result_never_goes_back_to_a_replaced_one(
    connection: Connection,
) -> None:
    match = add_match(connection)
    first = add_result(connection, match, b"3-1")
    accept(connection, first)
    make_current(connection, match, first)
    second = add_result(connection, match, b"3-2", replaces=first)
    accept(connection, second)
    make_current(connection, match, second)

    with pytest.raises(ProgrammingError, match="current result is its accepted head"):
        make_current(connection, match, first)


def test_a_replaced_result_never_becomes_current(connection: Connection) -> None:
    match = add_match(connection)
    first = add_result(connection, match, b"3-1")
    add_result(connection, match, b"3-2", replaces=first)
    accept(connection, first)

    with pytest.raises(ProgrammingError, match="current result is its accepted head"):
        make_current(connection, match, first)


def test_a_result_replaces_one_that_already_exists(connection: Connection) -> None:
    match = add_match(connection)
    a, b = uuid.uuid4(), uuid.uuid4()

    with pytest.raises(ProgrammingError, match="replaces one that already exists"):
        connection.execute(
            text(
                "INSERT INTO match_results (id, match_id, payload, replaces_id)"
                " VALUES (:a, :match, 'A', :b), (:b, :match, 'B', :a)"
            ),
            {"a": a, "b": b, "match": match},
        )


def test_a_payload_is_stored_once(connection: Connection) -> None:
    match = add_match(connection)
    add_result(connection, match, b"same bytes")

    with pytest.raises(IntegrityError) as error:
        add_result(connection, match, b"same bytes")

    assert violated_constraint(error) == "match_results_by_hash"


def test_a_result_is_found_by_its_payloads_hash(connection: Connection) -> None:
    match = add_match(connection)
    result = add_result(connection, match, b"payload")
    indexdef = connection.scalar(
        text(
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'match_results'"
            " AND indexname = 'match_results_by_hash'"
        )
    )

    assert indexdef == (
        "CREATE UNIQUE INDEX match_results_by_hash ON public.match_results"
        " USING btree (sha256(payload))"
    )
    assert (
        connection.scalar(
            text("SELECT id FROM match_results WHERE sha256(payload) = :hash"),
            {"hash": hashlib.sha256(b"payload").digest()},
        )
        == result
    )


def test_a_match_has_one_first_result(connection: Connection) -> None:
    match = add_match(connection)
    add_result(connection, match, b"3-1")

    with pytest.raises(IntegrityError) as error:
        add_result(connection, match, b"3-2")

    assert violated_constraint(error) == "one_successor"


def test_a_result_has_one_successor(connection: Connection) -> None:
    match = add_match(connection)
    first = add_result(connection, match, b"3-1")
    add_result(connection, match, b"3-2", replaces=first)

    with pytest.raises(IntegrityError) as error:
        add_result(connection, match, b"3-0", replaces=first)

    assert violated_constraint(error) == "one_successor"


def test_one_successor_counts_every_result_and_treats_nulls_as_equal(
    connection: Connection,
) -> None:
    indexdef = connection.scalar(
        text(
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'match_results'"
            " AND indexname = 'one_successor'"
        )
    )

    assert indexdef == (
        "CREATE UNIQUE INDEX one_successor ON public.match_results"
        " USING btree (match_id, replaces_id) NULLS NOT DISTINCT"
    )


def test_a_result_replaces_a_result_of_its_own_match(connection: Connection) -> None:
    match, other = add_match(connection), add_match(connection)
    elsewhere = add_result(connection, other, b"elsewhere")

    with pytest.raises(IntegrityError) as error:
        add_result(connection, match, b"here", replaces=elsewhere)

    assert violated_constraint(error) == "fk_match_results_replaces_id_match_results"


def test_a_result_is_accepted_once_and_otherwise_never_changes(
    connection: Connection,
) -> None:
    result = add_result(connection, add_match(connection), b"3-1")
    accept(connection, result)

    with pytest.raises(ProgrammingError, match="changes only when it is accepted"):
        accept(connection, result)


def test_a_results_payload_never_changes(connection: Connection) -> None:
    result = add_result(connection, add_match(connection), b"3-1")

    with pytest.raises(ProgrammingError, match="changes only when it is accepted"):
        connection.execute(
            text(
                "UPDATE match_results SET payload = 'edited', accepted_at = now()"
                " WHERE id = :id"
            ),
            {"id": result},
        )


def test_a_result_is_never_deleted(connection: Connection) -> None:
    add_result(connection, add_match(connection), b"3-1")

    with pytest.raises(ProgrammingError, match="match results are never deleted"):
        connection.execute(text("DELETE FROM match_results"))


def test_a_submission_never_changes(connection: Connection) -> None:
    add_submission(connection, add_match(connection))

    with pytest.raises(ProgrammingError, match="rows never change"):
        connection.execute(text("UPDATE match_submissions SET outcome = 'stale'"))


def test_a_submission_is_for_a_match_that_exists(connection: Connection) -> None:
    with pytest.raises(IntegrityError) as error:
        add_submission(connection, uuid.uuid4())

    assert violated_constraint(error) == "fk_match_submissions_match_id_matches"


def test_a_submissions_result_is_of_its_match(connection: Connection) -> None:
    match, other = add_match(connection), add_match(connection)
    result = add_result(connection, other, b"other's")

    with pytest.raises(IntegrityError) as error:
        add_submission(connection, match, result)

    assert violated_constraint(error) == "fk_match_submissions_result_id_match_results"


def add_approval(
    connection: Connection,
    result: uuid.UUID,
    submission: int,
    account: uuid.UUID,
    player: uuid.UUID,
) -> None:
    connection.execute(
        text(
            "INSERT INTO match_approvals (result_id, key_id, side, signature,"
            " account_id, player_id, authority, submission_id)"
            " VALUES (:result, :key, 0, :signature, :account, :player, 'self',"
            " :submission)"
        ),
        {
            "result": result,
            "key": COSE_KEY.kid,
            "signature": bytes(64),
            "account": account,
            "player": player,
            "submission": submission,
        },
    )


def test_a_signature_counts_once_for_its_side(connection: Connection) -> None:
    account, ann = add_account(connection), add_player(connection, "Ann")
    add_signing_key(connection, account)
    match = add_match(connection, [[ann], [add_player(connection, "Bea")]])
    result = add_result(connection, match, b"3-1")
    add_approval(
        connection, result, add_submission(connection, match, result), account, ann
    )

    with pytest.raises(IntegrityError) as error:
        add_approval(
            connection, result, add_submission(connection, match, result), account, ann
        )

    assert violated_constraint(error) == "pk_match_approvals"


def test_an_approval_came_in_a_submission_of_its_result(
    connection: Connection,
) -> None:
    account, ann = add_account(connection), add_player(connection, "Ann")
    add_signing_key(connection, account)
    match = add_match(connection, [[ann], [add_player(connection, "Bea")]])
    first = add_result(connection, match, b"3-1")
    second = add_result(connection, match, b"3-2", replaces=first)

    with pytest.raises(IntegrityError) as error:
        add_approval(
            connection, second, add_submission(connection, match, first), account, ann
        )

    assert (
        violated_constraint(error)
        == "fk_match_approvals_submission_id_match_submissions"
    )
