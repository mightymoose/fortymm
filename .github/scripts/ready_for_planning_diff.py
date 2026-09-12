#!/usr/bin/env python3
"""Diff one poll of a project column against the previous poll.

Reads the pages of a `gh api graphql --paginate --slurp` response, keeps the
items sitting in the target column, and compares that set against the set the
last poll saved. The difference is the set of tickets that *moved into* the
column since the last poll. A single poll cannot tell you that on its own. It
only ever sees "is in the column now".

Usage:

    ready_for_planning_diff.py <pages.json> <state.json> <arrived.json>

The arriving tickets go to a file, and only their count goes to GITHUB_OUTPUT.
A ticket title is arbitrary text that someone else wrote, and a step output is
substituted into the workflow by `${{ }}` before any shell sees it. Handing the
next step a filename keeps every title out of that substitution.

Environment:

    COLUMN               column name to watch (default: "Ready For Planning")
    GITHUB_OUTPUT        written with `arrived_count=<n>` when present
    GITHUB_STEP_SUMMARY  written with a human-readable report when present

Run it by hand against a saved `pages.json` to see what it would do.
"""

import json
import os
import sys


def load_pages(path):
    """Parse the GraphQL response and fail loudly if it is not what we expect.

    The response is untrusted input like any other. A partial GraphQL response
    carries HTTP 200 with an `errors` key, and a missing project yields a null
    `user` rather than an error, so both have to be checked by hand. Letting
    either through would silently read an empty column, and an empty column
    looks exactly like "every ticket left", which is a diff we would act on.
    """
    with open(path) as handle:
        pages = json.load(handle)

    # `--slurp` always produces an array, but a single un-slurped page is an
    # object. Accept both so the script is usable by hand.
    if isinstance(pages, dict):
        pages = [pages]
    if not isinstance(pages, list) or not pages:
        raise SystemExit(f"{path}: expected a non-empty array of GraphQL pages")

    nodes = []
    for page in pages:
        if page.get("errors"):
            raise SystemExit(f"GraphQL errors: {json.dumps(page['errors'])}")
        project = ((page.get("data") or {}).get("user") or {}).get("projectV2")
        if project is None:
            raise SystemExit(
                "GraphQL returned no project. Check the owner, the project "
                "number, and that PROJECT_BOARD_TOKEN carries read:project."
            )
        nodes.extend(project["items"]["nodes"])
    return nodes


def in_column(nodes, column):
    """Map item id -> ticket, for the items whose Status is `column`.

    Keyed on the project item id, not the issue number, because that is what
    survives a title change and what an item without content still has.
    """
    found = {}
    for node in nodes:
        status = node.get("fieldValueByName") or {}
        if status.get("name") != column:
            continue
        content = node.get("content") or {}
        # Draft items have no number. There is nothing to comment on.
        if content.get("number") is None:
            continue
        found[node["id"]] = {
            "number": content["number"],
            "title": content.get("title", ""),
            "url": content.get("url", ""),
        }
    return found


def emit(name, value):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as handle:
            handle.write(f"{name}={value}\n")


def summarize(lines):
    print("\n".join(lines))
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as handle:
            handle.write("\n".join(lines) + "\n")


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    pages_path, state_path, arrived_path = sys.argv[1], sys.argv[2], sys.argv[3]
    column = os.environ.get("COLUMN") or "Ready For Planning"

    current = in_column(load_pages(pages_path), column)

    seeding = not os.path.exists(state_path)
    if seeding:
        # First run, or the cache expired. Every ticket already in the column
        # would otherwise read as newly arrived, and we would comment on all of
        # them. Record the column and act on nothing.
        previous = set(current)
    else:
        with open(state_path) as handle:
            previous = set(json.load(handle)["items"])

    arrived = [current[item_id] for item_id in current if item_id not in previous]
    arrived.sort(key=lambda ticket: ticket["number"])

    with open(state_path, "w") as handle:
        json.dump({"column": column, "items": sorted(current)}, handle, indent=2)

    with open(arrived_path, "w") as handle:
        json.dump(arrived, handle)

    emit("arrived_count", str(len(arrived)))

    lines = [f"## {column}", ""]
    if seeding:
        lines.append(
            f"No previous state, so this run seeded from the column as it is "
            f"now ({len(current)} ticket(s)) and acted on nothing."
        )
    elif arrived:
        lines.append(f"{len(arrived)} ticket(s) arrived since the last poll:")
        lines.append("")
        lines += [f"- [#{t['number']}]({t['url']}) {t['title']}" for t in arrived]
    else:
        lines.append(f"Nothing new. {len(current)} ticket(s) in the column.")
    summarize(lines)


if __name__ == "__main__":
    main()
