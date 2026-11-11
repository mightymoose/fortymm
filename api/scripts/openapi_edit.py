"""Edit api/openapi.json for api:openapi-temporary-check, in the api container, so the
host needs only Docker. Prints to standard output; never writes the file.

python scripts/openapi_edit.py stable              # each unmarked operation: "<path> <method>"
python scripts/openapi_edit.py without-temporary   # the document without draft operations
python scripts/openapi_edit.py without PATH METHOD # the document without that operation
"""

import json
import sys
from pathlib import Path
from typing import Any

DOCUMENT = Path(__file__).parent.parent / "openapi.json"


def is_temporary(operation: Any) -> bool:
    return isinstance(operation, dict) and operation.get("x-stability-level") == "draft"


def without(document: dict[str, Any], keep: Any) -> dict[str, Any]:
    paths = {
        path: {method: op for method, op in item.items() if keep(path, method, op)}
        for path, item in document["paths"].items()
    }
    return {**document, "paths": {path: item for path, item in paths.items() if item}}


def main(argv: list[str]) -> None:
    document: dict[str, Any] = json.loads(DOCUMENT.read_text())
    match argv:
        case ["stable"]:
            for path, item in document["paths"].items():
                for method, operation in item.items():
                    if not is_temporary(operation):
                        print(path, method)
        case ["without-temporary"]:
            print(json.dumps(without(document, lambda p, m, op: not is_temporary(op))))
        case ["without", path, method]:
            print(json.dumps(without(document, lambda p, m, op: (p, m) != (path, method))))
        case _:
            sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
