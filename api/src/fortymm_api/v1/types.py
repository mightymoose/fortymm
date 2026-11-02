"""The JSON forms of values JSON has no type for."""

import re
from typing import Annotated

from pydantic import BeforeValidator, PlainSerializer, WithJsonSchema

# Lowercase hex pairs, as vectors.json and the signed result spec write bytes.
# One spelling, so a kid has one URL.
HEX_PATTERN = r"^(?:[0-9a-f]{2})*$"


def _bytes_from_hex(value: object) -> object:
    if not isinstance(value, str):
        return value
    if not re.fullmatch(HEX_PATTERN, value):
        raise ValueError("not lowercase hex")
    return bytes.fromhex(value)


# Bytes in this API's JSON are lowercase hex. A string that isn't gets
# FastAPI's own 422, as any body shape error does.
HexBytes = Annotated[
    bytes,
    BeforeValidator(_bytes_from_hex),
    PlainSerializer(lambda data: data.hex(), return_type=str),
    WithJsonSchema({"type": "string", "pattern": HEX_PATTERN}),
]
