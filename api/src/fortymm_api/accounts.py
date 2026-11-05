"""The kinds of account a valid session can belong to, and its self player."""

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
    email: ClassVar[None] = None


@dataclass(frozen=True)
class VerifiedAccount:
    kind: ClassVar[Literal["verified"]] = "verified"
    id: AccountId
    email: Email


@dataclass(frozen=True)
class SelfPlayer:
    """The player an account plays as: its player_managers row is 'self'."""

    id: PlayerId
    display_name: str


# An adopted account is neither kind: its sessions are invalid.
CurrentAccount = GuestAccount | VerifiedAccount
