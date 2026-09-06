# Proposals form an immutable linear history

Status: Accepted. Implements #1676, following the design interview.

A match with proposals has one root and one chain. Every predecessor belongs
to the same match and has at most one successor. A predecessor must already
exist when its successor is inserted, including within batch SQL statements.
The proposal ID, match, predecessor, score snapshot, submitting Account and
submission time cannot change. These construction and immutability rules prevent
longer cycles; a no-self-reference CHECK alone does not.

Proposals cannot be deleted, including the tail. A match with proposal history
cannot be hard-deleted. Voiding retains proposals. Explicit disposable pre-beta
database resets remain permitted until #1670; they are not a normal application
operation.

Acceptance consists of an Account and timestamp recorded together. A proposal
may be inserted already accepted, or its acceptance may be recorded once while
it is the head. Recorded acceptance cannot be rewritten or cleared. Accepted
proposals may have successors and several proposals in a chain may retain
acceptance: future director overrides must not erase earlier consent. Today's
API restrictions on completed matches remain; official revisions and correction
workflows belong to #1682. Reminder bookkeeping remains mutable.

The represented Player is the sole identity exception. Recording a same-person
Player merge atomically repoints proposal representation through a database
trigger. Direct reassignment, even citing a previously recorded merge, and
changes to or from NULL are rejected. The source Player's recorded merge target
and time become immutable so the merge cannot be erased after moving history.
Submitting and accepting Accounts remain the original actors. A later merge of
the surviving Player can move representation again through the same mechanism.

The database serializes proposal inserts and first acceptance using a new row
version of their owning match. This gives direct SQL writers the same ordering
as backend writers holding the match lock, and rejects stale writers under
Repeatable Read or Serializable isolation. An append that wins the race makes
acceptance of its predecessor fail; acceptance that wins can be followed by an
append. Callers inserting multiple proposals must use predecessor order.

The Alembic baseline owns the trigger implementation and remains self-contained.
Model metadata mirrors the foreign keys, uniqueness and CHECK constraints;
`create_all` alone is not a complete application database. Backend regressions
run on fresh Alembic installs, alongside schema parity and direct SQL tests for
malformed chains, mutation, retention, merge behavior and concurrent writes.

This refines the merge mechanics in
[Accounts authorize durable Players](20260905-accounts-authorize-durable-players.md):
the database now performs representation changes when the merge is recorded,
and preserves that merge record. Its Account/Player distinction and same-person
merge policy remain in force. No earlier domain decision is superseded.

Proposal insertion also writes the represented Player's row version and rejects
a Player already merged. This serializes insertion with the merge transition in
both orders, including stale Repeatable Read transactions. Recorded Player merge
rows cannot be deleted. Match-details readers select acceptance from the chain
head, so retained earlier acceptances cannot hide a successor or its score.
