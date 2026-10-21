"""Write the API's OpenAPI schema to `openapi.json`, which clients generate
their types from.

    uv run python -m fortymm_api.openapi           # (re)write openapi.json
    uv run python -m fortymm_api.openapi --check   # fail if it is out of date
"""

import argparse
import json
import sys
from pathlib import Path

from fortymm_api.main import create_app

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "openapi.json"


def render_schema() -> str:
    return json.dumps(create_app().openapi(), indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit with an error instead of writing if openapi.json is stale",
    )
    args = parser.parse_args()

    schema = render_schema()
    if args.check:
        current = SCHEMA_PATH.read_text() if SCHEMA_PATH.exists() else ""
        if current != schema:
            print(
                f"{SCHEMA_PATH.name} is out of date; run "
                "`./bin/mise run api:openapi` and commit the result.",
                file=sys.stderr,
            )
            return 1
        return 0

    SCHEMA_PATH.write_text(schema)
    return 0


if __name__ == "__main__":
    sys.exit(main())
