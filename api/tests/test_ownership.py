from sqlalchemy import Connection, Engine, text

from fortymm_api.ownership import OWNERSHIP_RULES

FOREIGN_KEYS_TO_OWNERS = text(
    """
    SELECT key.table_name, key.column_name
    FROM information_schema.table_constraints AS constraint_
    JOIN information_schema.key_column_usage AS key
      USING (constraint_schema, constraint_name)
    JOIN information_schema.constraint_column_usage AS referred
      USING (constraint_schema, constraint_name)
    WHERE constraint_.constraint_type = 'FOREIGN KEY'
      AND referred.table_name IN ('accounts', 'players')
    """
)


def foreign_keys_to_owners(connection: Connection) -> set[tuple[str, str]]:
    """Each (table, column) whose foreign key refers to `accounts` or `players`."""
    return {
        (table, column) for table, column in connection.execute(FOREIGN_KEYS_TO_OWNERS)
    }


def unlisted_foreign_keys(connection: Connection) -> set[tuple[str, str]]:
    return foreign_keys_to_owners(connection) - OWNERSHIP_RULES.keys()


def test_every_foreign_key_to_an_owner_has_a_rule(migrated_database: Engine) -> None:
    with migrated_database.connect() as connection:
        assert unlisted_foreign_keys(connection) == set()


def test_every_rule_names_a_foreign_key(migrated_database: Engine) -> None:
    with migrated_database.connect() as connection:
        assert OWNERSHIP_RULES.keys() <= foreign_keys_to_owners(connection)


def test_finds_a_foreign_key_without_a_rule(migrated_database: Engine) -> None:
    with migrated_database.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE notes"
                " (id uuid PRIMARY KEY, author_id uuid REFERENCES accounts (id))"
            )
        )

    with migrated_database.connect() as connection:
        assert unlisted_foreign_keys(connection) == {("notes", "author_id")}
