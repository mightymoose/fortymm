# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `mightymoose/fortymm`.
Use the `gh` CLI from this repo, or pass
`--repo mightymoose/fortymm` explicitly.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- Inspect fields: `gh issue view <number> --json number,title,body,labels,comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body-file <file>`
- Label: `gh issue edit <number> --add-label "..." --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Use a temporary file with actual newlines for multiline bodies.
Apply appropriate label and state filters when listing issues.

“Publish to the issue tracker” means create a GitHub issue.
“Fetch the relevant ticket” means read the issue and its comments.

## Pull requests as a triage surface

PRs as a request surface: no.

Issues and PRs share a number space. If a reference is ambiguous,
resolve it with `gh pr view <number>`, falling back to
`gh issue view <number>`.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Child tickets: link as GitHub sub-issues. If unavailable, use
  a task list in the map and `Part of #<map>` in each child.
  Label children `wayfinder:<type>`:
  research, prototype, grilling, or task.
- Blocking: use native GitHub issue dependencies through
  `gh api --method POST repos/mightymoose/fortymm/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  Fetch the database ID with
  `gh api repos/mightymoose/fortymm/issues/<number> --jq .id`.
  If dependencies are unavailable, put `Blocked by: #<number>`
  at the top of the child body.
- Frontier: select the first open, unassigned child in map order
  with no open blockers.
- Claim: `gh issue edit <number> --add-assignee @me`.
- Resolve: comment with the answer, close the ticket, and append
  a summary and link to the map's Decisions-so-far.
