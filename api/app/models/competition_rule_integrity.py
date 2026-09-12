"""Immutable rule values and their historical references."""

from typing import Any

from sqlalchemy import MetaData, event
from sqlalchemy.engine import Connection

from app.db import Base

COMPETITION_RULE_INTEGRITY_DDL = (
    """
    CREATE FUNCTION bind_competition_stage_rules() RETURNS trigger LANGUAGE plpgsql
            AS $$
    BEGIN
        UPDATE tournament_event_stages SET rule_revision_id=NEW.id
            WHERE event_id=NEW.event_id AND retired_at IS NULL;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER bind_competition_stage_rules AFTER INSERT ON
            tournament_draw_revisions
    FOR EACH ROW EXECUTE FUNCTION bind_competition_stage_rules()
    """,
    """
    CREATE FUNCTION match_rules_agree(settings match_settings, rules jsonb)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
        SELECT (settings.rule_version, settings.team_size, settings.best_of,
            settings.affects_rating,
                settings.verification_policy::text, settings.retirement_window)
        IS NOT DISTINCT FROM
            ((rules->>'rule_version')::smallint, (rules->>'team_size')::smallint,
            (rules->>'best_of')::smallint,
             (rules->>'affects_rating')::boolean, rules->>'verification_policy',
             (rules->>'retirement_window')::interval)
    $$
    """,
    """
    CREATE FUNCTION check_match_rule_source() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE rules jsonb;
    BEGIN
        IF NEW.source_rule_revision_id IS NOT NULL THEN
            SELECT match_rules INTO STRICT rules FROM tournament_draw_revisions
                WHERE id=NEW.source_rule_revision_id;
            IF NOT match_rules_agree(NEW, rules) THEN
                RAISE EXCEPTION 'match rules must agree with their source revision'
                    USING ERRCODE='23514';
            END IF;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER check_match_rule_source BEFORE INSERT ON match_settings
    FOR EACH ROW EXECUTE FUNCTION check_match_rule_source()
    """,
    """
    CREATE FUNCTION check_fixture_rules() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE settings match_settings; rules jsonb; stage_revision uuid;
    BEGIN
        SELECT rule_revision_id INTO STRICT stage_revision FROM tournament_event_stages
            WHERE id=NEW.stage_id;
        IF stage_revision IS DISTINCT FROM NEW.draw_revision_id THEN
            RAISE EXCEPTION 'fixture stage rules must agree with its draw revision'
                USING ERRCODE='23514';
        END IF;
        IF NEW.match_id IS NOT NULL THEN
            SELECT ms.* INTO STRICT settings FROM match_settings ms
                JOIN matches m ON m.match_settings_id=ms.id WHERE m.id=NEW.match_id;
            SELECT match_rules INTO STRICT rules FROM tournament_draw_revisions
                WHERE id=NEW.draw_revision_id;
            IF NOT match_rules_agree(settings, rules) OR
                (settings.source_rule_revision_id IS NOT NULL AND
                 settings.source_rule_revision_id <> NEW.draw_revision_id) THEN
                RAISE EXCEPTION 'fixture match rules must agree with its draw revision'
                    USING ERRCODE='23514';
            END IF;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER check_fixture_rules AFTER INSERT OR UPDATE OF match_id,
            draw_revision_id, stage_id
    ON tournament_fixtures FOR EACH ROW EXECUTE FUNCTION check_fixture_rules()
    """,
    """
    CREATE FUNCTION preserve_stage_rules() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF OLD.rule_revision_id IS NOT NULL AND
            (NEW.rule_revision_id, NEW.event_id, NEW.draw_type_id, NEW.position)
            IS DISTINCT FROM (OLD.rule_revision_id, OLD.event_id, OLD.draw_type_id,
            OLD.position)
        THEN
            RAISE EXCEPTION 'stage rules binding is immutable' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_stage_rules BEFORE UPDATE ON tournament_event_stages
    FOR EACH ROW EXECUTE FUNCTION preserve_stage_rules()
    """,
    """
    CREATE FUNCTION preserve_match_rule_reference() RETURNS trigger LANGUAGE plpgsql
            AS $$
    BEGIN
        IF NEW.match_settings_id IS DISTINCT FROM OLD.match_settings_id THEN
            RAISE EXCEPTION 'match rules reference is immutable' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER immutable_match_rule_reference BEFORE UPDATE OF match_settings_id
            ON matches
    FOR EACH ROW EXECUTE FUNCTION preserve_match_rule_reference()
    """,
    """
    CREATE FUNCTION capture_competition_rules() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE event_row tournament_events; draw_key text;
    BEGIN
        SELECT * INTO STRICT event_row FROM tournament_events WHERE id=NEW.event_id;
        SELECT key INTO STRICT draw_key FROM draw_types WHERE id=event_row.draw_type_id;
        IF event_row.format = 'teams' THEN
            RAISE EXCEPTION 'team competition rules are not supported' USING
            ERRCODE='23514';
        END IF;
        IF NEW.match_rules IS NULL THEN
            NEW.match_rules := jsonb_build_object(
                'rule_version', 1, 'team_size', CASE WHEN event_row.format='doubles'
            THEN 2 ELSE 1 END,
                'best_of', event_row.match_settings->'length_games',
                'affects_rating', event_row.match_settings->'rated',
                'verification_policy', 'none', 'retirement_window', 'P7D');
        END IF;
        IF NEW.format_rules IS NULL THEN
            NEW.format_rules := jsonb_build_object('version', 1,
                'draw_type', draw_key, 'settings', event_row.draw_settings);
        END IF;
        IF (jsonb_typeof(NEW.match_rules) = 'object'
            AND NEW.match_rules ?& ARRAY['rule_version','team_size','best_of',
            'affects_rating','verification_policy','retirement_window']
            AND NEW.match_rules - ARRAY['rule_version','team_size','best_of',
            'affects_rating','verification_policy','retirement_window'] = '{}'::jsonb
            AND NEW.match_rules->'rule_version' = '1'::jsonb
            AND NEW.match_rules->'team_size' IN ('1'::jsonb, '2'::jsonb)
            AND jsonb_typeof(NEW.match_rules->'best_of') = 'number'
            AND NEW.match_rules->'best_of' IN ('1'::jsonb, '3'::jsonb,
                '5'::jsonb, '7'::jsonb)
            AND jsonb_typeof(NEW.match_rules->'affects_rating') = 'boolean'
            AND NEW.match_rules->>'verification_policy' IN ('none','self_report',
            'opponent_confirms','all_players_confirm')
            AND jsonb_typeof(NEW.match_rules->'retirement_window') IN ('null',
            'string')) IS NOT TRUE THEN
            RAISE EXCEPTION 'invalid match rule snapshot' USING ERRCODE='23514';
        END IF;
        IF NEW.match_rules->'retirement_window' <> 'null'::jsonb AND
            (NEW.match_rules->>'retirement_window') !~
            '^P([0-9]+D)?(T([0-9]+H)?([0-9]+M)?([0-9]+([.][0-9]+)?S)?)?$' THEN
            RAISE EXCEPTION 'invalid match rule duration' USING ERRCODE='23514';
        END IF;
        IF (NEW.match_rules->>'best_of')::integer % 2 <> 1 OR
            ((NEW.match_rules->>'retirement_window')::interval <= interval '0') THEN
            RAISE EXCEPTION 'invalid match rule values' USING ERRCODE='23514';
        END IF;
        IF (jsonb_typeof(NEW.format_rules) = 'object'
            AND NEW.format_rules ?& ARRAY['version','draw_type','settings']
            AND NEW.format_rules - ARRAY['version','draw_type','settings'] = '{}'::jsonb
            AND NEW.format_rules->'version' = '1'::jsonb
            AND NEW.format_rules->>'draw_type' IN ('round-robin','single-elim',
            'rr-then-ko','swiss')
            AND jsonb_typeof(NEW.format_rules->'settings') = 'object') IS NOT TRUE THEN
            RAISE EXCEPTION 'invalid format rule snapshot' USING ERRCODE='23514';
        END IF;
        IF (CASE NEW.format_rules->>'draw_type'
            WHEN 'round-robin' THEN NEW.format_rules->'settings' = '{}'::jsonb
            WHEN 'single-elim' THEN NEW.format_rules->'settings' = '{}'::jsonb
            WHEN 'rr-then-ko' THEN
                ((NEW.format_rules->'settings') - 'qualifiers_per_group' = '{}'::jsonb
                 AND jsonb_typeof(NEW.format_rules->'settings'->
                     'qualifiers_per_group') = 'number'
                 AND NEW.format_rules->'settings'->>'qualifiers_per_group' ~
            '^[1-9][0-9]*$')
            WHEN 'swiss' THEN
                ((NEW.format_rules->'settings') - 'rounds' = '{}'::jsonb
                 AND jsonb_typeof(NEW.format_rules->'settings'->'rounds') = 'number'
                 AND NEW.format_rules->'settings'->>'rounds' ~ '^[1-9][0-9]*$')
            ELSE false END) IS NOT TRUE THEN
            RAISE EXCEPTION 'invalid format rule settings' USING ERRCODE='23514';
        END IF;
        IF NEW.format_rules->>'draw_type' = 'swiss' AND
            (NEW.format_rules->'settings'->>'rounds')::integer > 32 THEN
            RAISE EXCEPTION 'invalid format rule rounds' USING ERRCODE='23514';
        END IF;
        IF NEW.format_rules->>'draw_type' = 'rr-then-ko' AND
            (NEW.format_rules->'settings'->>'qualifiers_per_group')::integer > 1000 THEN
            RAISE EXCEPTION 'invalid format rule qualifiers' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER capture_competition_rules BEFORE INSERT ON tournament_draw_revisions
    FOR EACH ROW EXECUTE FUNCTION capture_competition_rules()
    """,
    """
    CREATE FUNCTION preserve_match_rules() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'match rules are immutable' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_match_rules BEFORE UPDATE ON match_settings
    FOR EACH ROW EXECUTE FUNCTION preserve_match_rules()
    """,
)


@event.listens_for(Base.metadata, "after_create")
def install_competition_rule_integrity(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    for statement in COMPETITION_RULE_INTEGRITY_DDL:
        connection.exec_driver_sql(statement)
