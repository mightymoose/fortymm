"""Representative result-derived seating topology for provenance scenarios.

Tests finalize the source, then correct/void it or explicitly seed unknown history.
No seed invents a revision for imported history that did not retain one.
"""

from sqlalchemy import select

from app.models import DrawType, TournamentEvent, TournamentFixture
from tests._helpers import directed_tournament_match, event_draw_settings


async def seed_knockout_advancement(db, tag="advancement"):
    match, director = await directed_tournament_match(
        db, tag=tag, best_of=1, rated=False
    )
    source = (
        await db.execute(
            select(TournamentFixture).where(TournamentFixture.match_id == match.id)
        )
    ).scalar_one()
    event = await db.get(TournamentEvent, source.scope_event_id)
    event.draw_settings = event_draw_settings(DrawType.single_elim)
    source.stage.draw_type = DrawType.single_elim
    target = TournamentFixture(
        stage_id=source.stage_id, group_id=source.group_id, round=2, position=1
    )
    db.add(target)
    await db.commit()
    return match, director, source, target
