"""Ordinary ORM reads operate on the current draw; history is explicit."""

from sqlalchemy import event
from sqlalchemy.orm import ORMExecuteState, Session, with_loader_criteria

from app.models.tournament_event_stage import TournamentEventStage
from app.models.tournament_fixture import TournamentFixture
from app.models.tournament_table import VenueTable


@event.listens_for(Session, "do_orm_execute")
def select_current_draw(state: ORMExecuteState) -> None:
    if state.is_select and not state.execution_options.get(
        "include_draw_history", False
    ):
        state.statement = state.statement.options(
            with_loader_criteria(
                TournamentFixture,
                lambda fixture: fixture.retired_at.is_(None),
                include_aliases=True,
            ),
            with_loader_criteria(
                TournamentEventStage,
                lambda stage: stage.retired_at.is_(None),
                include_aliases=True,
            ),
            with_loader_criteria(
                VenueTable,
                lambda table: table.retired_at.is_(None),
                include_aliases=True,
            ),
        )
