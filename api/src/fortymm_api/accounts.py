"""The kinds of account a valid session can belong to."""

from dataclasses import dataclass
from typing import NewType
from uuid import UUID

AccountId = NewType("AccountId", UUID)
PlayerId = NewType("PlayerId", UUID)
Email = NewType("Email", str)  # lowercase


@dataclass(frozen=True)
class GuestAccount:
    id: AccountId


@dataclass(frozen=True)
class VerifiedAccount:
    id: AccountId
    email: Email


# An adopted account is neither kind: its sessions are invalid.
CurrentAccount = GuestAccount | VerifiedAccount
