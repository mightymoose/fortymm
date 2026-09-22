"""Stable, non-PII references for payment support workflows."""

from __future__ import annotations

import base64
import uuid


def payment_support_reference(entity_id: uuid.UUID) -> str:
    """Encode the full UUID in a compact reference that fits the 32-char column.

    Base32 preserves all 128 bits of the UUID, unlike the former eight-character
    display prefix.  The result is deterministic, so retries keep presenting the
    same reference without needing a second durable identifier.
    """
    encoded = base64.b32encode(entity_id.bytes).decode("ascii").rstrip("=")
    return f"PAY-{encoded}"
