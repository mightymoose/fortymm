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
    DECLARE target_match uuid; side_size integer; rated boolean;
        first_count integer; second_count integer;
    BEGIN
        IF TG_TABLE_NAME = 'match_results' THEN
            target_match := NEW.match_id;
        ELSE
            SELECT match_id INTO target_match FROM match_games
            WHERE id = NEW.match_game_id;
        END IF;
        PERFORM id FROM matches WHERE id=target_match FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM match_recorded_play WHERE match_id=target_match)
        THEN
            SELECT settings.team_size, settings.affects_rating INTO side_size, rated
            FROM matches m JOIN match_settings settings
                ON settings.id=m.match_settings_id
            WHERE m.id=target_match;
            SELECT count(*) FILTER (WHERE s.side_number=1),
                   count(*) FILTER (WHERE s.side_number=2)
            INTO first_count, second_count FROM match_side_players p
            JOIN match_sides s ON s.id=p.match_side_id WHERE p.match_id=target_match;
            IF (SELECT count(*) FROM match_sides WHERE match_id=target_match) <> 2
                OR first_count <> side_size
                OR (second_count <> side_size AND NOT
                    (side_size=1 AND second_count=0 AND NOT rated)) THEN
                RAISE EXCEPTION 'recorded play requires complete participants'
                    USING ERRCODE='23514';
            END IF;
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
    """
    CREATE FUNCTION lock_recorded_participants() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        PERFORM id FROM matches WHERE id IN (
            CASE WHEN TG_OP <> 'DELETE' THEN NEW.match_id END,
            CASE WHEN TG_OP <> 'INSERT' THEN OLD.match_id END
        ) ORDER BY id FOR UPDATE;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER lock_recorded_participants BEFORE INSERT OR UPDATE OR DELETE
    ON match_side_players FOR EACH ROW EXECUTE FUNCTION lock_recorded_participants()""",
    """
    CREATE FUNCTION check_recorded_participants() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE participant match_side_players%ROWTYPE;
    BEGIN
        SELECT * INTO participant FROM match_side_players WHERE id=NEW.id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        -- Deferred so an explicit same-person merge can finish its identity
        -- tombstones before current participants are compared with original ones.
        IF EXISTS (SELECT 1 FROM match_recorded_play
            WHERE match_id=participant.match_id)
            AND NOT EXISTS (
                SELECT 1 FROM match_recorded_participants recorded
                JOIN match_sides side ON side.id=participant.match_side_id
                WHERE recorded.match_id=participant.match_id
                  AND recorded.side_number=side.side_number
                  AND entry_canonical_player(recorded.player_id)=
                      entry_canonical_player(participant.user_id)
            )
            AND NOT EXISTS (
                SELECT 1 FROM match_lineups lineup
                JOIN match_lineup_players p ON p.lineup_id=lineup.id
                JOIN match_sides side ON side.id=participant.match_side_id
                WHERE lineup.match_id=participant.match_id AND lineup.revision > 1
                  AND p.side_number=side.side_number AND p.player_id=participant.user_id
            ) THEN
            RAISE EXCEPTION 'recorded participants cannot gain an unrecorded identity'
                USING ERRCODE='23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """CREATE CONSTRAINT TRIGGER check_recorded_participants
    AFTER INSERT OR UPDATE ON match_side_players DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_recorded_participants()""",
)


def install_sporting_retention(
    metadata: MetaData, connection: Connection, **kwargs: object
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in SPORTING_RETENTION_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_sporting_retention)
