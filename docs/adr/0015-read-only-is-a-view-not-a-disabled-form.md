# 15. Read-only is a view, not a disabled form

Date: 2026-07-11

## Status

Accepted

## Context

Several tournament surfaces are editable by the tournament's creator and merely
viewable by everyone else. Ownership is server-computed — `can_edit` on the
tournament payload (`api/app/tournaments.py`, `t.created_by_user_id ==
current_user_id`) — and every mutating endpoint independently enforces it with a
403 (`_require_owner`). The server has never been at risk here. The question is
only what a **non-owner's** screen should look like.

The codebase answered that question two different ways, and nothing recorded
which one was right:

- `tables-tab.tsx` and `tournament-card.tsx` **hide** the mutating controls. A
  non-owner simply has no Delete button, no "Add table" form.
- `details-tab.tsx` **disables** them — it renders the organizer's edit form with
  `disabled={!canEdit}` on all nine controls, so a non-owner gets a greyed-out
  editor.

The event side panel (`event-editor.tsx`) started down the second path and never
finished. Its own doc comment declared that for a non-creator "the editor becomes
a read-only view of the event", but it only ever hid the Save and Delete buttons.
The four sections underneath — Basics, Eligibility, Match settings, Table pools —
kept rendering **live, enabled** inputs, switches, selects, and add/remove
buttons. A non-owner could type into the panel, edit eligibility rules, and add
table pools; none of it could be committed, because there was no Save button, so
every keystroke was silently discarded on close.

That bug is the argument. A disabled form and a hidden control are not two styles
of the same idea:

- A **disabled form still presents as an editor.** It has the shape, the field
  boxes, and the affordances of something you are meant to fill in. It invites
  the input it is going to refuse.
- The failure is **silent**. A control that is enabled-but-pointless (the event
  panel) discards work with no feedback at all. Even a correctly disabled control
  is a dead end that never explains itself — the user is told "no" without being
  told why, and grey-on-grey is a weak signal at that.
- It **leaks the organizer's voice** to a reader. Copy written for the person in
  control ("Edit the basics. Players see this on the public page…") is addressed
  to someone who is not the organizer and cannot change any of it.
- It is a **drift trap**. Twenty `disabled={!canEdit}` props are twenty chances
  to forget one, and forgetting one restores exactly the bug above. That is not
  hypothetical; it is what happened.

## Decision

**A viewer gets a rendering of the data. Only an editor gets controls.**

Concretely, on any surface gated by an ownership/permission flag:

1. **Render values, don't disable inputs.** When the user cannot edit, the
   surface renders the data as text — a label and its value — not a form control
   in a disabled state. There should be no `<input>`, `<select>`, `<textarea>`,
   or `<switch>` in the accessibility tree at all.

   **This extends to the form's furniture, not just its controls.** A field
   **hint** ("Optional. Shown on the public registration page.") explains how to
   fill in a control; with no control, there is nothing to explain. A **required
   asterisk** marks a field the user must complete; it is nonsense on a field
   nobody can fill in. Both are suppressed in the read-only rendering — dropped,
   not reworded.

   **`Field` owns the branch, not merely a flag.** A `Field` takes the value and
   renders *either* its control *or* the value, deciding for itself; the call
   site passes one `readOnly` and is done. This matters more than it looks. An
   earlier draft of this ADR had `Field` suppress only the furniture while each
   call site *separately* wrote `canEdit ? <Input/> : <ReadOnlyValue/>` — two
   obligations per field, and `readOnly={!canEdit}` repeated a dozen times. That
   is the very shape this ADR condemns: "twenty `disabled` props are twenty
   chances to forget one" applies just as well to twelve `readOnly` props. Worse,
   the two invariants are not equally protected — the control sweep (rule 6)
   generalizes to any control anyone adds, but the furniture assertions are
   per-named-field, so a new field that forgot the flag would leak an asterisk to
   a reader and *nothing would catch it*. Folding the branch into `Field` makes
   the leak structurally impossible at that boundary, which is strictly better
   than catching it in a test.

2. **Hide mutating affordances; never disable them.** Save, Delete, Revert, "Add
   rule", "Add pool", the row trash buttons — a user who cannot perform the
   action does not see the button. (`tournament-card.tsx` already reasons this
   way: "deleting is owner-only on the server, so a non-creator never sees a
   button that would 403".) A disabled button is an unexplained dead end; an
   absent one asks no questions.

3. **The read-only view mirrors the editor's information architecture.** Same
   sections, same order, same fields — so nothing is silently dropped and drift
   between the two renderings is visible rather than dangerous. A field the
   organizer left empty renders as an em-dash (`—`), not an omitted row: absent
   and not-applicable must stay distinguishable, which matters most for exactly
   the fields a player needs (entry fee, registration deadline, entrant cap).

4. **Rows that are sentences render as sentences.** An eligibility predicate is
   `[field] [operator] [value]` — three controls that are already a sentence
   chopped into a grid. Read-only, it renders as prose: "Rating is under 1500".
   The operator labels are already sentence fragments, so this composes from the
   existing vocabulary rather than inventing copy.

5. **Copy addresses the reader, not the organizer.** Imperatives written for the
   person in control ("Edit event", "Click any event to edit") are swapped for
   neutral copy when the user cannot edit.

6. **Enforce it with a guard test, not with vigilance.** Each read-only-capable
   section carries a test asserting that with `canEdit: false` it renders **zero**
   interactive controls. This is what makes rule 1 durable: it fails loudly the
   moment someone adds an ungated control, which is the drift that produced the
   original bug.

   **The sweep must be over the DOM, not over ARIA roles.** We learned this the
   expensive way while implementing this ADR: a sweep of `textbox` / `combobox` /
   `switch` / `button` catches only 3 of the event panel's 8 Basics controls,
   because a `type="number"` input is a `spinbutton`, a `type="date"` or
   `type="time"` input has **no role at all**, and a `ToggleGroupItem` renders
   `<button role="radio">` — an explicit role **overrides** the implicit one, so
   the `button` query never matches it. Such a guard goes green with five live
   inputs still on screen — the precise false-green this rule exists to prevent.

   **The selector lives in exactly one place** — `web-client/src/test/read-only.ts`
   — and every page object composes it. This is not tidiness; it is the rule
   itself. When the selector was copy-pasted per page object, it forked **three
   ways within this single change**, and one of those forks silently dropped
   `[role="switch"]` and `[role="radio"]` while another omitted `a[href]` — so a
   live link passed all six section guards. A guard test enforced by "remember to
   copy the string verbatim" is enforced by vigilance, which is the thing this
   rule exists to abolish. One constant, one place to extend when a `Slider` or a
   `Combobox` arrives.

We considered enforcing this structurally instead — separate `*-section.tsx` and
`*-section-readonly.tsx` components, so a read-only component *cannot* render an
input. That gives the guarantee by construction, but it duplicates the label and
layout markup of every section and roughly triples the file count under the
colocated-quartet convention. It also trades a dangerous drift (an editable field
leaks) for a quiet one (a field is added to the editor and never to the view). We
chose the single-component form with the guard test: the same protection, bought
at the test layer instead of the file layer.

### Which shape: branch per field, or branch the whole subtree?

That framing is a false binary, and the code proves it — a third of these
components use a third shape, correctly. The real choice is:

- **Branch per field** (`basics-section`, `match-section`, `details-tab`) — when
  the read-only view **mirrors** the editor field-for-field. The two renderings
  share a skeleton, so sharing the markup is what keeps them honest. With `Field`
  owning the branch, most of these need no `canEdit` in their JSX at all.
- **Branch the whole subtree** — an early `if (!canEdit) return …` returning a
  different tree (`predicate-row`, `pool-card`) — when the read-only
  **information architecture genuinely differs** from the editor's. A predicate
  is three controls in a grid but *one sentence* as prose; a pool is a grid of
  table toggles but *a list of table names* as text. Forcing those through a
  per-cell ternary would be worse: it would preserve a layout that only exists to
  hold controls that are gone.

The test to apply: **does the viewer's rendering have the same shape as the
editor's, or a different one?** Same shape → branch per field, and let the shared
markup prevent drift. Different shape → branch the subtree, and accept that the
two branches share only their data. Reach for the second only when you can say
what the *reader's* structure is, independent of the form's.

## Consequences

- Non-owners never see a form they cannot submit. The silently-discarded-input
  class of bug is gone from these surfaces and is caught mechanically if it
  returns.
- `details-tab.tsx` loses its nine `disabled={!canEdit}` props and gains a
  read-only rendering, so the two conflicting precedents in the codebase collapse
  into one.
- Read-only renderings must be kept in step with their editors as fields are
  added. The guard test does not catch a *missing* field — only an *editable*
  one. Mirroring the editor's structure (rule 3) is what keeps that omission
  obvious to a reviewer.
- This ADR is about **presentation only**. It changes nothing about
  authorization: the server already 403s every mutating tournament endpoint for a
  non-owner, and it must continue to, because hiding a control is a UX decision
  and never a security boundary.
