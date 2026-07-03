#!/usr/bin/env python3
"""Rewrite Pydantic's `Optional[X]` OpenAPI 3.1 shape into an equivalent
`swift-openapi-generator` can actually type: it drops any `anyOf` branch it
can't otherwise place, and a bare `{"type": "null"}` member is one of those
-- so every truly-optional field (not just ones missing from `required`)
silently vanishes from the generated Swift, warning-only, no build error.
The generator does understand the older `nullable: true` sibling form
(OpenAPIKit normalizes it back to a 3.1 `type` array internally), so that's
the target shape here. Usage: fix_openapi_nullable.py <in.json> <out.json>
"""

import copy
import json
import sys


def _is_null_schema(schema: object) -> bool:
    is_type_null = isinstance(schema, dict) and schema.get("type") == "null"
    return is_type_null and len(schema) == 1


def _fix(node: object) -> object:
    if isinstance(node, dict):
        any_of = node.get("anyOf")
        if isinstance(any_of, list):
            null_members = [m for m in any_of if _is_null_schema(m)]
            other_members = [m for m in any_of if not _is_null_schema(m)]
            if null_members and other_members:
                sibling_keys = {k: v for k, v in node.items() if k != "anyOf"}
                if len(other_members) == 1:
                    other = copy.deepcopy(other_members[0])
                    # `$ref` can't take sibling keywords, so wrap it in
                    # `allOf` (the one construct OpenAPI reserves exactly
                    # for this).
                    if "$ref" in other:
                        merged = {"allOf": [other], **sibling_keys, "nullable": True}
                    else:
                        merged = {**other, **sibling_keys, "nullable": True}
                else:
                    # A real union (e.g. `int | str | bool | None`): keep it
                    # as an `anyOf`, just drop the `null` branch and mark the
                    # whole thing nullable instead.
                    merged = {
                        "anyOf": [copy.deepcopy(m) for m in other_members],
                        "nullable": True,
                        **sibling_keys,
                    }
                return _fix(merged)
        return {key: _fix(value) for key, value in node.items()}
    if isinstance(node, list):
        return [_fix(item) for item in node]
    return node


def main() -> None:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <in.json> <out.json>", file=sys.stderr)
        raise SystemExit(2)
    in_path, out_path = sys.argv[1], sys.argv[2]
    with open(in_path) as f:
        document = json.load(f)
    fixed = _fix(document)
    with open(out_path, "w") as f:
        json.dump(fixed, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
