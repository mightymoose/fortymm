---
name: commit
description: Commit the current work in this repo by filling in the commit message template. Use when asked to commit, make a commit, or write a commit message.
---

# Commit

1. Run `git status` and `git diff` (staged and unstaged) to see what is being committed. If on `main`, create a branch first.
2. Stage the files by path. Leave out anything unrelated to this change and anything that may hold secrets (`.env`, credentials).
3. Fill in the template below and commit it with a heredoc: `git commit -F - <<'EOF' … EOF`.

## Template

```
<Subject: imperative, ≤ 72 chars, no trailing period>

<What changed and why, in 1–3 short paragraphs wrapped at 72 columns.>

<How to run or check it, e.g. `./bin/mise run <task>`. Delete if nothing to run.>
```
