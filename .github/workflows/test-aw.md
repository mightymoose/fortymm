---
on:
  workflow_dispatch:

engine: claude

permissions:
  contents: read

safe-outputs:
  create-pull-request:
---

# Tiny Claude experiment

Inspect this repository and its README.

Find one small, clearly useful improvement to the README. Examples include:

- fixing a typo
- clarifying a confusing sentence
- adding a missing development command
- correcting stale information that can be verified from the repository

Do not change application code.

If you find a worthwhile improvement:

1. Make the smallest reasonable change.
2. Open a pull request containing only that change.
3. Explain in the pull request why you made it.

If there is nothing clearly worth changing, do nothing.
