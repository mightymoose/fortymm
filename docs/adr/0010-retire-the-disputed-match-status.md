# Retire the `disputed` match status

`MatchStatus.disputed` was a leftover from the pre-#721 dispute cluster: a
match "reopened for correction" as a distinct terminal-ish status. Epic #721
replaced that model with **propose/accept**, where contesting a result is a
**correction** — a propose that supersedes the standing result on a still
`in_progress` match (the `review` bucket the opposing side sees). Nothing in the
API ever transitions a match *into* `disputed`; the value survived only in the
enum and in read-side handling (`attention.py`, `matches.py` scoring guards,
`match_details_mapper.py`, both the dashboard and match-list status maps) and in
the generated `schema.d.ts` / `Types.swift`.

The status also **contradicted the glossary**: `CONTEXT.md` already defines
**Correction** with `_Avoid_: dispute`, so a live `disputed` status plus
`dispute` / `_DISPUTE_PRIORITY` naming pulled the code away from the settled
ubiquitous language.

We removed the `disputed` enum value and all its dead handling across API, web,
and iOS, retiring "dispute" as a **status** while keeping "dispute" as a domain
*verb* realized by correction/counter-propose. Because fortymm is undeployed and
no row ever held the value, we edited the original `create_match_tables`
migration in place (Postgres can't `DROP VALUE` from an enum) and wipe +
re-migrate, rather than chaining an alter.

## Consequences

- The dashboard's `AttentionKind`, `attention.py`'s `ListAttentionKind`, and the
  attention-priority ranks lose their `dispute` member/branch. Remaining ranks
  keep their relative order (`review` still outranks `score`).
- The shared actionable filter (`_actionable_attention_filter`) collapses to a
  single clause: `in_progress AND NOT my_standing_proposal`.
- The scoring-write guards that accepted `in_progress OR disputed` now accept
  only `in_progress` — no behavior change, since `disputed` was never set.
- Reintroducing an explicit dispute/reopen state later is a real schema change
  again (new enum value + migration), not a revival of dead code — an
  acceptable cost given the propose/accept model already covers correction.
