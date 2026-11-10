"""Write the API's OpenAPI document to a file, or check that the file is current.

python -m api.openapi openapi.json          # write
python -m api.openapi openapi.json --check  # exit 1 if the file differs
"""

import argparse
import json
import sys
import warnings
from pathlib import Path

from api.app import create_app


def render() -> str:
    with warnings.catch_warnings():
        # FastAPI only warns when two operations share an operationId; a client generated
        # from that document would lose one of them, so make it fail instead.
        warnings.filterwarnings("error", message="Duplicate Operation ID")
        document = create_app().openapi()
    return json.dumps(document, indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    document = render()
    if args.check:
        current = args.path.read_text() if args.path.exists() else ""
        if current != document:
            print(f"{args.path} is out of date. Run ./bin/mise run api:openapi", file=sys.stderr)
            return 1
        return 0
    args.path.write_text(document)
    return 0


if __name__ == "__main__":
    sys.exit(main())
