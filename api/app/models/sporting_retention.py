"""Durable score/result evidence, independent of the editable scratchpad."""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    MetaData,
    SmallInteger,
    event,
    func,
)
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class MatchRecordedPlay(Base):
    __tablename__ = "match_recorded_play"

    match_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("matches.id", ondelete="RESTRICT"), primary_key=True
    )
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )


class MatchRecordedParticipant(Base):
    """Original identity at first score or proposal; merges change current sides."""

    __tablename__ = "match_recorded_participants"
    __table_args__ = (
        CheckConstraint("side_number IN (1, 2)", name="ck_recorded_participant_side"),
    )

    match_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("match_recorded_play.match_id", ondelete="RESTRICT"),
        primary_key=True,
    )
    side_number: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="RESTRICT"), primary_key=True
    )


SPORTING_RETENTION_DDL = (
    """
    CREATE FUNCTION preserve_recorded_score_identity() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW.match_game_id <> OLD.match_game_id THEN
            RAISE EXCEPTION 'a recorded score preserves its game identity'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_recorded_score_identity BEFORE UPDATE
    ON match_game_scores FOR EACH ROW
    EXECUTE FUNCTION preserve_recorded_score_identity()
    """,
    """
    CREATE FUNCTION preserve_published_tournament() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'UPDATE' THEN
            IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
                RAISE EXCEPTION 'tournament publication history must be retained'
                    USING ERRCODE='23514';
            END IF;
            RETURN NEW;
        END IF;
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'only unused draft tournaments can be deleted'
                USING ERRCODE='23514';
        END IF;
        RETURN OLD;
    END $$
    """,
    """CREATE TRIGGER preserve_published_tournament
    BEFORE DELETE OR UPDATE OF status ON tournaments
    FOR EACH ROW EXECUTE FUNCTION preserve_published_tournament()""",
    """
    CREATE FUNCTION retain_match_play() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_match uuid;
    BEGIN
        IF TG_TABLE_NAME = 'match_results' THEN
            target_match := NEW.match_id;
        ELSE
            SELECT match_id INTO target_match FROM match_games
            WHERE id = NEW.match_game_id;
        END IF;
        WITH recorded AS (
            INSERT INTO match_recorded_play(match_id)
            VALUES (target_match)
            ON CONFLICT DO NOTHING RETURNING match_id
        )
        INSERT INTO match_recorded_participants(match_id, side_number, player_id)
        SELECT p.match_id, s.side_number, p.user_id
        FROM recorded r JOIN match_side_players p ON p.match_id = r.match_id
        JOIN match_sides s ON s.id = p.match_side_id;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER retain_proposal_participants AFTER INSERT ON match_results
    FOR EACH ROW EXECUTE FUNCTION retain_match_play()""",
    """CREATE TRIGGER retain_match_play AFTER INSERT ON match_game_scores
    FOR EACH ROW EXECUTE FUNCTION retain_match_play()""",
    """
    CREATE FUNCTION preserve_match_play() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP <> 'INSERT' OR pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION 'recorded play history is immutable and database owned'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER preserve_match_participants BEFORE INSERT OR UPDATE OR DELETE
    ON match_recorded_participants
    FOR EACH ROW EXECUTE FUNCTION preserve_match_play()""",
    """CREATE TRIGGER preserve_match_play BEFORE INSERT OR UPDATE OR DELETE
    ON match_recorded_play FOR EACH ROW EXECUTE FUNCTION preserve_match_play()""",
)


def install_sporting_retention(
    metadata: MetaData, connection: Connection, **kwargs: object
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in SPORTING_RETENTION_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_sporting_retention)
