from collections.abc import Iterator

import pytest
from sqlalchemy import ForeignKey, create_engine
from sqlalchemy.exc import InvalidRequestError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from fortymm_api.models import relationship


class Base(DeclarativeBase):
    pass


class Club(Base):
    __tablename__ = "clubs"
    id: Mapped[int] = mapped_column(primary_key=True)
    members: Mapped[list[Member]] = relationship(back_populates="club")
    coaches: Mapped[list[Coach]] = relationship(lazy="selectin")


class Member(Base):
    __tablename__ = "members"
    id: Mapped[int] = mapped_column(primary_key=True)
    club_id: Mapped[int] = mapped_column(ForeignKey("clubs.id"))
    club: Mapped[Club] = relationship(back_populates="members")


class Coach(Base):
    __tablename__ = "coaches"
    id: Mapped[int] = mapped_column(primary_key=True)
    club_id: Mapped[int] = mapped_column(ForeignKey("clubs.id"))


@pytest.fixture
def session() -> Iterator[Session]:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(Club(id=1, members=[Member(id=1)], coaches=[Coach(id=1)]))
        session.commit()
        session.expunge_all()
        yield session


def test_a_relationship_refuses_to_load_lazily(session: Session) -> None:
    club = session.get_one(Club, 1)

    with pytest.raises(InvalidRequestError, match="lazy='raise'"):
        _ = club.members


def test_a_relationship_can_choose_another_loader(session: Session) -> None:
    club = session.get_one(Club, 1)
    session.expunge(club)

    assert [coach.id for coach in club.coaches] == [1]
