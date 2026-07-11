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
   not reworded. Suppress them at the `Field` component rather than at each call
   site, so a new field cannot reintroduce them by omission.

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
   `type="time"` input has **no role at all**, and a `ToggleGroupItem` is a
   `radio`. Such a guard goes green with five live inputs still on screen — the
   precise false-green this rule exists to prevent. Query the DOM
   (`input, select, textarea, button, [role="switch"], [role="radio"], [tabindex],
   [contenteditable]`), scoped to the component's root.

We considered enforcing this structurally instead — separate `*-section.tsx` and
`*-section-readonly.tsx` components, so a read-only component *cannot* render an
input. That gives the guarantee by construction, but it duplicates the label and
layout markup of every section and roughly triples the file count under the
colocated-quartet convention. It also trades a dangerous drift (an editable field
leaks) for a quiet one (a field is added to the editor and never to the view). We
chose the single-component form with the guard test: the same protection, bought
at the test layer instead of the file layer.

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
