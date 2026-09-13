# Retention and deletion matrix

Implements [the #1690 decision](adr/20260912-identities-and-sporting-history-survive-deletion.md).
Normal-operation rules apply before and after beta cutover. A fixture-owned test
reset is not an application deletion operation.

| Record | Normal deletion/lifecycle | Retained meaning |
| --- | --- | --- |
| Account | No hard deletion; deactivate/reactivate or erase identifying Account fields and credentials | Stable historical actor; erasure never implies self-registration or consent |
| Player | No hard deletion; retire/restore; explicit merge remains separate | Reserved username, sporting identity, results and rating inputs |
| Login/session/email credentials and delivery state | Explicit revocation/cleanup permitted | These grant access or deliver messages; they are not sporting evidence |
| Current Player management grants | May be explicitly removed; deactivation alone preserves them | Reactivation honors current grants, never resurrects revoked authority |
| Event Entry, including team Entries | Withdraw or supersede; never erase a registration or its parent | Competing identity, membership intervals, original actors |
| Registration, participation and withdrawal periods | Close or explicitly restore through lifecycle operations; retain original periods | Historical registration priority, competition eligibility, seats and acting Accounts |
| Draw revision | Retire on removal or replacement; retain fixtures and cut-time configuration | Original field, stages, groups, placements and configuration snapshots |
| Competition and Match rules | Immutable snapshots; retain source revision while a surviving Match requires it | Cut-time rules, stage binding and materialized Match provenance |
| Entry member | Close interval or append replacement under existing roster rules | Original Player and membership provenance; lineup references survive |
| Fixture and stage/group ancestors | Disposable only without protected references | Recorded lineup/play, advancement and call evidence protect their required parents |
| Untouched standalone Match | May be discarded | No saved score or result exists |
| Recorded Match | Retain after score clearing, correction, void or merge | Durable first score/proposal evidence and original participant snapshot |
| Participant proposal / official result / advancement | Immutable history; append corrections or explicit replacement | Original predecessors, result evidence, actor and rule snapshots |
| Rating inputs and rating bases | Retain; never reset through identity lifecycle | Inputs, strategy and official-result provenance |
| Rating projections | May be rebuilt under existing rating rules | Retirement filters current visibility without deleting inputs or changing results |
| Tournament | Only unused drafts may be hard-deleted; otherwise archive | Any registration, call, play, result, advancement or lifecycle/archive history protects it |
| Director grants / ownership transfers | Retain while tournament survives; revoke/transfer explicitly | Original actors and merge provenance; unused draft cleanup may remove owned history |
| Venue table | Explicit uncalled removal allowed with placement protection; otherwise retire | Call history protects stable table identity |
| Reservation membership / outage | Release/end intervals; explicit unused configuration cleanup remains possible | Closing an interval does not delete or change a fixture's placement |
| Call/move/cancellation history | Immutable, including calls cancelled before scoring | Table and fixture references remain; tournament deletion cannot erase calls |
| Configuration/catalogues | Delete only when no retained dependent requires them | Match settings, draw/rating strategies and rule snapshots keep their existing historical meanings |
| Solve/required-repair delivery records | Owned operational cleanup only when parent is deletable | Recovery obligations for retained sporting parents remain available |

The current schema has team-format Entries/member rows and one Match per fixture.
It does not yet contain separate reusable Team or multi-match Encounter tables;
those feature issues must apply this matrix to their own real references.

## Foreign-key review

Every FK registered in the current backend metadata is listed below. `NO ACTION`
means PostgreSQL's default when no explicit delete action is specified. Deferred
checks validate the final transaction state; retention triggers still prohibit
removing immutable history, including child-first deletion attempts.

Review rationale:

- **Identity:** referenced Account/Player rows cannot be hard-deleted at all. Actor
  references never use deletion as a reason to become NULL or change meaning.
- **Evidence:** immutable rows/triggers and restrictive references retain original
  subjects and predecessor chains. Immediate RESTRICT is appropriate where the
  referenced evidence is never a disposable draft child.
- **Owned setup:** cascades remove only owned data when its parent is legitimately
  deletable. Registration, call, play and lifecycle guards protect retained parents.
  A Match's restrictive settings reference and rule-source checks also prevent a
  draw revision cascade from removing rules required by a surviving Match.
- **Current/delivery state:** explicit cleanup is permitted; it does not remove the
  sporting fact. Identity deletion cascades are unreachable in normal operation.
- **Projection:** calculated data can be rebuilt; retained inputs and matches block
  deleting a league that still owns sporting evidence.
- **Placement:** surviving references must resolve at commit; deferred NO ACTION
  permits valid aggregate cleanup without temporarily unplacing every fixture.
- **Interval:** explicit unused catalogue cleanup follows the table lifecycle ADR;
  ordinary release closes an interval and retains its identity.

| Referencing table | Columns → referenced columns | Delete action | Timing | Rationale |
| --- | --- | --- | --- | --- |
| `account_email_intents` | `target_account_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `account_email_intents` | `user_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `account_email_tokens` | `guest_account_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `account_email_tokens` | `target_account_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `account_email_tokens` | `user_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `account_first_sign_in_intents` | `user_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `account_players` | `account_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `account_players` | `player_id` → `players.id` | RESTRICT | Immediate | Identity |
| `account_session_tokens` | `user_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `accounts` | `merged_into_user_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `advancement_decision_evidence` | `decision_id` → `fixture_advancement_decisions.id` | NO ACTION | Immediate | Evidence |
| `advancement_decision_evidence` | `match_id` → `matches.id` | NO ACTION | Immediate | Evidence |
| `advancement_decision_evidence` | `official_result_id, match_id` → `match_official_results.id, match_official_results.match_id` | NO ACTION | Immediate | Evidence |
| `device_tokens` | `user_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `fixture_advancement_decisions` | `actor_account_id` → `accounts.id` | NO ACTION | Immediate | Identity |
| `fixture_advancement_decisions` | `entry_id` → `tournament_entries.id` | NO ACTION | Immediate | Evidence |
| `fixture_advancement_decisions` | `event_id` → `tournament_events.id` | NO ACTION | Immediate | Evidence |
| `fixture_advancement_decisions` | `fixture_id` → `tournament_fixtures.id` | NO ACTION | Immediate | Evidence |
| `fixture_advancement_decisions` | `predecessor_id, fixture_id, side` → `fixture_advancement_decisions.id, fixture_advancement_decisions.fixture_id, fixture_advancement_decisions.side` | NO ACTION | Immediate | Evidence |
| `fixture_advancement_decisions` | `source_fixture_id` → `tournament_fixtures.id` | NO ACTION | Immediate | Evidence |
| `fixture_advancement_decisions` | `source_group_id` → `tournament_event_stage_groups.id` | NO ACTION | Immediate | Evidence |
| `league_memberships` | `league_id` → `leagues.id` | CASCADE | Immediate | Current/delivery state |
| `league_memberships` | `user_id` → `players.id` | RESTRICT | Immediate | Identity |
| `leagues` | `rating_strategy_id` → `rating_strategies.id` | RESTRICT | Immediate | Evidence |
| `login_identities` | `account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `match_game_scores` | `match_game_id` → `match_games.id` | CASCADE | Immediate | Owned setup |
| `match_games` | `match_id` → `matches.id` | CASCADE | Immediate | Owned setup |
| `match_lineup_players` | `entry_member_id` → `tournament_entry_members.id` | RESTRICT | Immediate | Evidence |
| `match_lineup_players` | `lineup_id` → `match_lineups.id` | CASCADE | Immediate | Evidence |
| `match_lineup_players` | `player_id` → `players.id` | RESTRICT | Immediate | Identity |
| `match_lineups` | `match_id` → `matches.id` | RESTRICT | Immediate | Evidence |
| `match_lineups` | `recorded_by_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `match_official_results` | `actor_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `match_official_results` | `director_grant_id` → `tournament_account_grants.id` | RESTRICT | Immediate | Evidence |
| `match_official_results` | `match_id` → `matches.id` | RESTRICT | Immediate | Evidence |
| `match_official_results` | `predecessor_id, match_id` → `match_official_results.id, match_official_results.match_id` | RESTRICT | Immediate | Evidence |
| `match_official_results` | `proposal_id, match_id` → `match_results.id, match_results.match_id` | RESTRICT | Immediate | Evidence |
| `match_official_results` | `restored_from_id, match_id` → `match_official_results.id, match_official_results.match_id` | RESTRICT | Immediate | Evidence |
| `match_official_results` | `tournament_id` → `tournaments.id` | RESTRICT | Immediate | Evidence |
| `match_rating_bases` | `match_id` → `matches.id` | RESTRICT | Immediate | Evidence |
| `match_rating_bases` | `rating_strategy_id` → `rating_strategies.id` | RESTRICT | Immediate | Evidence |
| `match_recorded_participants` | `match_id` → `match_recorded_play.match_id` | RESTRICT | Immediate | Evidence |
| `match_recorded_participants` | `player_id` → `players.id` | RESTRICT | Immediate | Identity |
| `match_recorded_play` | `match_id` → `matches.id` | RESTRICT | Immediate | Evidence |
| `match_results` | `accepted_by_user_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `match_results` | `match_id` → `matches.id` | RESTRICT | Immediate | Evidence |
| `match_results` | `submitted_by_user_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `match_results` | `submitted_for_player_id` → `players.id` | RESTRICT | Immediate | Identity |
| `match_results` | `supersedes_result_id, match_id` → `match_results.id, match_results.match_id` | RESTRICT | Immediate | Evidence |
| `match_settings` | `source_rule_revision_id` → `tournament_draw_revisions.id` | CASCADE | Immediate | Owned setup |
| `match_side_players` | `match_id` → `matches.id` | CASCADE | Immediate | Owned setup |
| `match_side_players` | `match_side_id, match_id` → `match_sides.id, match_sides.match_id` | CASCADE | Immediate | Owned setup |
| `match_side_players` | `user_id` → `players.id` | RESTRICT | Immediate | Identity |
| `match_sides` | `match_id` → `matches.id` | CASCADE | Immediate | Owned setup |
| `match_void_actions` | `actor_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `match_void_actions` | `director_grant_id` → `tournament_account_grants.id` | RESTRICT | Immediate | Evidence |
| `match_void_actions` | `match_id` → `matches.id` | RESTRICT | Immediate | Evidence |
| `match_void_actions` | `official_result_id, match_id` → `match_official_results.id, match_official_results.match_id` | RESTRICT | Immediate | Evidence |
| `match_void_actions` | `tournament_id` → `tournaments.id` | RESTRICT | Immediate | Evidence |
| `matches` | `created_by_user_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `matches` | `current_official_result_id, id` → `match_official_results.id, match_official_results.match_id` | NO ACTION | Immediate | Evidence |
| `matches` | `league_id` → `leagues.id` | RESTRICT | Immediate | Evidence |
| `matches` | `match_settings_id` → `match_settings.id` | RESTRICT | Immediate | Evidence |
| `notification_channel_settings` | `channel` → `notification_channels.key` | RESTRICT | Immediate | Current/delivery state |
| `notification_channel_settings` | `user_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `notification_preferences` | `category` → `notification_types.key` | RESTRICT | Immediate | Current/delivery state |
| `notification_preferences` | `channel` → `notification_channels.key` | RESTRICT | Immediate | Current/delivery state |
| `notification_preferences` | `user_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `notifications` | `category` → `notification_types.key` | RESTRICT | Immediate | Current/delivery state |
| `notifications` | `result_id` → `match_results.id` | SET NULL | Immediate | Current/delivery state |
| `notifications` | `user_id` → `accounts.id` | CASCADE | Immediate | Identity |
| `players` | `merged_into_player_id` → `players.id` | RESTRICT | Immediate | Identity |
| `rating_history` | `created_by_user_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `rating_history` | `league_id` → `leagues.id` | CASCADE | Immediate | Projection |
| `rating_history` | `match_id` → `matches.id` | RESTRICT | Immediate | Projection |
| `rating_history` | `match_id, rating_strategy_id` → `match_rating_bases.match_id, match_rating_bases.rating_strategy_id` | RESTRICT | Immediate | Projection |
| `rating_history` | `official_result_id, match_id` → `match_official_results.id, match_official_results.match_id` | RESTRICT | Immediate | Projection |
| `rating_history` | `rating_input_id` → `rating_inputs.id` | RESTRICT | Immediate | Projection |
| `rating_history` | `rating_strategy_id` → `rating_strategies.id` | RESTRICT | Immediate | Projection |
| `rating_history` | `user_id` → `players.id` | RESTRICT | Immediate | Identity |
| `rating_inputs` | `actor_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `rating_inputs` | `league_id` → `leagues.id` | RESTRICT | Immediate | Evidence |
| `rating_inputs` | `player_id` → `players.id` | RESTRICT | Immediate | Identity |
| `rating_inputs` | `rating_strategy_id` → `rating_strategies.id` | RESTRICT | Immediate | Evidence |
| `rating_inputs` | `supersedes_id` → `rating_inputs.id` | RESTRICT | Immediate | Evidence |
| `required_repair_attempts` | `repair_id` → `required_repairs.id` | CASCADE | Immediate | Current/delivery state |
| `required_repairs` | `player_id` → `players.id` | RESTRICT | Immediate | Identity |
| `required_repairs` | `tournament_id` → `tournaments.id` | CASCADE | Immediate | Current/delivery state |
| `role_permissions` | `permission_id` → `permissions.id` | CASCADE | Immediate | Current/delivery state |
| `role_permissions` | `role_id` → `roles.id` | CASCADE | Immediate | Current/delivery state |
| `schedule_solves` | `tournament_id` → `tournaments.id` | CASCADE | Immediate | Current/delivery state |
| `tournament_account_grants` | `account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_account_grants` | `granted_by_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_account_grants` | `inherited_from_grant_id` → `tournament_account_grants.id` | NO ACTION | Deferred | Evidence |
| `tournament_account_grants` | `revoked_by_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_account_grants` | `tournament_id` → `tournaments.id` | CASCADE | Immediate | Owned setup |
| `tournament_draw_revisions` | `created_by_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_draw_revisions` | `event_id` → `tournament_events.id` | CASCADE | Immediate | Evidence |
| `tournament_entries` | `added_by_user_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_entries` | `event_id` → `tournament_events.id` | CASCADE | Immediate | Owned setup |
| `tournament_entries` | `event_id, superseded_by_entry_id` → `tournament_entries.event_id, tournament_entries.id` | RESTRICT | Immediate | Evidence |
| `tournament_entry_members` | `entry_id` → `tournament_entries.id` | CASCADE | Immediate | Owned setup |
| `tournament_entry_members` | `joined_by_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_entry_members` | `left_by_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_entry_members` | `player_id` → `players.id` | RESTRICT | Immediate | Identity |
| `tournament_entry_participations` | `ended_by_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_entry_participations` | `event_id, draw_revision_id` → `tournament_draw_revisions.event_id, tournament_draw_revisions.id` | NO ACTION | Deferred | Evidence |
| `tournament_entry_participations` | `event_id, entry_id` → `tournament_entries.event_id, tournament_entries.id` | CASCADE | Immediate | Evidence |
| `tournament_entry_participations` | `event_id, stage_id` → `tournament_event_stages.event_id, tournament_event_stages.id` | CASCADE | Immediate | Evidence |
| `tournament_entry_participations` | `stage_id, group_id` → `tournament_event_stage_groups.stage_id, tournament_event_stage_groups.id` | NO ACTION | Deferred | Evidence |
| `tournament_entry_registrations` | `entry_id` → `tournament_entries.id` | CASCADE | Immediate | Evidence |
| `tournament_entry_registrations` | `registered_by_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_entry_registrations` | `withdrawn_by_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_entry_withdrawals` | `actor_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_entry_withdrawals` | `event_id, entry_id` → `tournament_entries.event_id, tournament_entries.id` | CASCADE | Immediate | Evidence |
| `tournament_entry_withdrawals` | `event_id, stage_id` → `tournament_event_stages.event_id, tournament_event_stages.id` | NO ACTION | Immediate | Evidence |
| `tournament_entry_withdrawals` | `restored_by_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_event_group_reservations` | `event_id, reservation_id` → `tournament_event_reservations.event_id, tournament_event_reservations.id` | CASCADE | Immediate | Owned setup |
| `tournament_event_group_reservations` | `event_id, stage_id` → `tournament_event_stages.event_id, tournament_event_stages.id` | CASCADE | Immediate | Owned setup |
| `tournament_event_group_reservations` | `stage_id, group_id` → `tournament_event_stage_groups.stage_id, tournament_event_stage_groups.id` | CASCADE | Immediate | Owned setup |
| `tournament_event_reservation_tables` | `event_id, reservation_id` → `tournament_event_reservations.event_id, tournament_event_reservations.id` | CASCADE | Immediate | Interval |
| `tournament_event_reservation_tables` | `tournament_id, event_id` → `tournament_events.tournament_id, tournament_events.id` | CASCADE | Immediate | Interval |
| `tournament_event_reservation_tables` | `tournament_id, table_id` → `tournament_tables.tournament_id, tournament_tables.id` | CASCADE | Immediate | Interval |
| `tournament_event_reservations` | `event_id` → `tournament_events.id` | CASCADE | Immediate | Owned setup |
| `tournament_event_stage_groups` | `stage_id` → `tournament_event_stages.id` | CASCADE | Immediate | Owned setup |
| `tournament_event_stages` | `draw_type_id` → `draw_types.id` | RESTRICT | Immediate | Evidence |
| `tournament_event_stages` | `event_id` → `tournament_events.id` | CASCADE | Immediate | Owned setup |
| `tournament_event_stages` | `event_id, rule_revision_id` → `tournament_draw_revisions.event_id, tournament_draw_revisions.id` | RESTRICT | Immediate | Evidence |
| `tournament_events` | `draw_type_id` → `draw_types.id` | RESTRICT | Immediate | Evidence |
| `tournament_events` | `tournament_id` → `tournaments.id` | CASCADE | Immediate | Owned setup |
| `tournament_fixtures` | `entry_a_id` → `tournament_entries.id` | NO ACTION | Deferred | Placement |
| `tournament_fixtures` | `entry_b_id` → `tournament_entries.id` | NO ACTION | Deferred | Placement |
| `tournament_fixtures` | `match_id` → `matches.id` | SET NULL | Immediate | Placement |
| `tournament_fixtures` | `participation_a_id, entry_a_id, stage_id, group_id, draw_revision_id` → `tournament_entry_participations.id, tournament_entry_participations.entry_id, tournament_entry_participations.stage_id, tournament_entry_participations.group_id, tournament_entry_participations.draw_revision_id` | NO ACTION | Deferred | Placement |
| `tournament_fixtures` | `participation_b_id, entry_b_id, stage_id, group_id, draw_revision_id` → `tournament_entry_participations.id, tournament_entry_participations.entry_id, tournament_entry_participations.stage_id, tournament_entry_participations.group_id, tournament_entry_participations.draw_revision_id` | NO ACTION | Deferred | Placement |
| `tournament_fixtures` | `scope_event_id, draw_revision_id` → `tournament_draw_revisions.event_id, tournament_draw_revisions.id` | NO ACTION | Deferred | Placement |
| `tournament_fixtures` | `scope_event_id, entry_a_id` → `tournament_entries.event_id, tournament_entries.id` | NO ACTION | Deferred | Placement |
| `tournament_fixtures` | `scope_event_id, entry_b_id` → `tournament_entries.event_id, tournament_entries.id` | NO ACTION | Deferred | Placement |
| `tournament_fixtures` | `scope_event_id, stage_id` → `tournament_event_stages.event_id, tournament_event_stages.id` | CASCADE | Deferred | Owned setup |
| `tournament_fixtures` | `scope_tournament_id, scope_event_id` → `tournament_events.tournament_id, tournament_events.id` | NO ACTION | Deferred | Placement |
| `tournament_fixtures` | `scope_tournament_id, table_id` → `tournament_tables.tournament_id, tournament_tables.id` | NO ACTION | Deferred | Placement |
| `tournament_fixtures` | `stage_id, group_id` → `tournament_event_stage_groups.stage_id, tournament_event_stage_groups.id` | NO ACTION | Deferred | Placement |
| `tournament_fixtures` | `table_id` → `tournament_tables.id` | NO ACTION | Deferred | Placement |
| `tournament_fixtures` | `winner_entry_id` → `tournament_entries.id` | NO ACTION | Deferred | Placement |
| `tournament_ownership_transfers` | `actor_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_ownership_transfers` | `new_owner_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_ownership_transfers` | `previous_owner_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournament_ownership_transfers` | `tournament_id` → `tournaments.id` | CASCADE | Immediate | Owned setup |
| `tournament_table_call_history` | `tournament_id` → `tournaments.id` | CASCADE | Immediate | Evidence |
| `tournament_table_call_history` | `tournament_id, fixture_id` → `tournament_fixtures.scope_tournament_id, tournament_fixtures.id` | NO ACTION | Deferred | Evidence |
| `tournament_table_call_history` | `tournament_id, table_id` → `tournament_tables.tournament_id, tournament_tables.id` | NO ACTION | Deferred | Evidence |
| `tournament_table_outages` | `tournament_id, table_id` → `tournament_tables.tournament_id, tournament_tables.id` | CASCADE | Immediate | Interval |
| `tournament_tables` | `tournament_id` → `tournaments.id` | CASCADE | Immediate | Owned setup |
| `tournaments` | `created_by_user_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `tournaments` | `league_id` → `leagues.id` | RESTRICT | Immediate | Evidence |
| `tournaments` | `owner_account_id` → `accounts.id` | RESTRICT | Immediate | Identity |
| `user_league_ratings` | `league_id` → `leagues.id` | CASCADE | Immediate | Projection |
| `user_league_ratings` | `rating_strategy_id` → `rating_strategies.id` | RESTRICT | Immediate | Projection |
| `user_league_ratings` | `user_id` → `players.id` | RESTRICT | Immediate | Identity |
| `user_roles` | `role_id` → `roles.id` | CASCADE | Immediate | Current/delivery state |
| `user_roles` | `user_id` → `accounts.id` | CASCADE | Immediate | Identity |

Reviewed 161 foreign keys. Regenerate this inventory when adding references,
and review their ownership and historical meaning rather than copying a delete action.
