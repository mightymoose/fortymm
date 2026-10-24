"""The ORM's declarative base. Mapped classes subclass `Base`."""

import functools

from sqlalchemy import MetaData, orm
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    # Named constraints, so a migration can refer to one by a stable name.
    metadata = MetaData(
        naming_convention={
            "ix": "ix_%(column_0_label)s",
            "uq": "uq_%(table_name)s_%(column_0_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )


# lazy="raise" makes a lazy load fail, so every load shows in the query that
# needs it. Pass another `lazy` to choose a loader for one relationship.
relationship = functools.partial(orm.relationship, lazy="raise")
