"""The kinds of account a valid session can belong to."""

from dataclasses import dataclass
from typing import ClassVar, Literal, NewType
from uuid import UUID

AccountId = NewType("AccountId", UUID)
PlayerId = NewType("PlayerId", UUID)
Email = NewType("Email", str)  # lowercase


@dataclass(frozen=True)
class GuestAccount:
    kind: ClassVar[Literal["guest"]] = "guest"
    id: AccountId


@dataclass(frozen=True)
class VerifiedAccount:
    kind: ClassVar[Literal["verified"]] = "verified"
    id: AccountId
    email: Email


# An adopted account is neither kind: its sessions are invalid.
CurrentAccount = GuestAccount | VerifiedAccount
