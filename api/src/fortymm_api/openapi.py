"""Write the API's OpenAPI schema to `openapi.json`, which clients generate
their types from: `uv run python -m fortymm_api.openapi`.
"""

import json
from pathlib import Path

from fortymm_api.main import create_app

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "openapi.json"


def main() -> None:
    SCHEMA_PATH.write_text(json.dumps(create_app().openapi(), indent=2) + "\n")


if __name__ == "__main__":
    main()
