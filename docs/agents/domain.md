# Domain docs

## Layout

This repo uses a single domain context:

- `CONTEXT.md`: root domain glossary.
- `docs/adr/`: architecture decisions.

## Before exploring

Read `CONTEXT.md` and ADRs relevant to the area being changed.

If these files are absent, proceed silently. Do not propose
creating them merely because they are missing. Domain-modeling
work creates them when terms or decisions are resolved.

## Vocabulary

Use the glossary's terms in issue titles, proposals, hypotheses,
and tests. Avoid synonyms the glossary explicitly rejects.

If a needed concept is missing, reconsider whether it belongs
or note the gap for domain-modeling work.

## Decisions

Surface conflicts with existing ADRs explicitly, citing the
decision and explaining why it may need to be reopened.
