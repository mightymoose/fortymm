import uuid
from datetime import datetime
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, EmailStr, Field

# RFC 5321 §4.5.3.1.1 caps the local part (before the ``@``) at 64 octets and
# the whole address at 254. ``EmailStr`` / email-validator enforces the 254
# total but NOT the 64-char local part, so an oversize local part validates and
# we'd enqueue mail to it (#615). Reject it explicitly on inbound addresses.
EMAIL_LOCAL_PART_MAX_LENGTH = 64


def _validate_local_part_length(value: str) -> str:
    local_part, _, _ = value.rpartition("@")
    if len(local_part) > EMAIL_LOCAL_PART_MAX_LENGTH:
        raise ValueError(
            "The email address's local part is too long "
            f"(maximum {EMAIL_LOCAL_PART_MAX_LENGTH} characters)."
        )
    return value


# Use for inbound addresses we'll act on (send mail / persist). Response echoes
# can stay plain ``EmailStr`` — they re-emit an already-validated value.
BoundedEmailStr = Annotated[EmailStr, AfterValidator(_validate_local_part_length)]

# Lowercase alphanumerics with optional dots/hyphens/underscores between them.
# Must start and end with an alphanumeric so we don't store names that look
# like punctuation. 40 chars admits the auto-generated `slug-slug-XXXXXXXX`
# format with headroom while keeping display sane.
USERNAME_PATTERN = r"^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$"
USERNAME_MIN_LENGTH = 3
USERNAME_MAX_LENGTH = 40


class SessionUser(BaseModel):
    # The caller's own user id. Returned only to the holder of the session
    # cookie, and the only place the API tells anyone who they are: without it
    # clients have to guess at "is this me?" by comparing usernames, which a
    # rename breaks. Never null — a guest minted by ``GET /v1/session`` is a
    # real user row with a real id.
    id: uuid.UUID
    username: str
    permissions: list[str]
    email: str | None = None
    confirmed_at: datetime | None = None
    pending_email: str | None = None


class SessionData(BaseModel):
    user: SessionUser


class MergeSummary(BaseModel):
    """Reported by sign-in / email-confirm responses when the call merged the
    caller's ephemeral session into a different (verified) account. Drives the
    "we brought your N matches with you" toast."""

    matches_moved: int


class SessionResponse(BaseModel):
    data: SessionData
    merged: MergeSummary | None = None


class UpdateCurrentUserRequest(BaseModel):
    username: str = Field(
        min_length=USERNAME_MIN_LENGTH,
        max_length=USERNAME_MAX_LENGTH,
        pattern=USERNAME_PATTERN,
    )


class CaptchaProtectedRequest(BaseModel):
    """Base for endpoints gated by Cloudflare Turnstile + an off-screen
    honeypot. ``fmm_hp_token`` is the honeypot — bots fill every field;
    humans never see it. Endpoints short-circuit as if successful when it's
    filled, so the bot doesn't learn the field is a trap.

    The field name deliberately avoids canonical identity-profile names
    (``website``, ``address``, ``phone``) because password managers and
    browser autofillers ignore ``autocomplete=off`` for those and would
    splash a real user's saved value into the trap."""

    captcha_token: str = Field(min_length=1, max_length=4096)
    fmm_hp_token: str = Field(default="", max_length=512)


class SetEmailRequest(CaptchaProtectedRequest):
    email: BoundedEmailStr


class ResendEmailRequest(CaptchaProtectedRequest):
    pass


class ConfirmEmailRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)
    # When the link would fold a guest into this account, the client can offer
    # the owner a "sign in but don't bring those matches" choice. Defaults to
    # merging (the common, desired path).
    skip_merge: bool = False


class RequestLoginRequest(CaptchaProtectedRequest):
    email: BoundedEmailStr


class LoginRequestAccepted(BaseModel):
    """202 body for the magic-link request endpoint. Always echoes the
    submitted address — identical whether or not it maps to a real account,
    so the response leaks nothing about which addresses are registered."""

    email: EmailStr


class LoginSenderResponse(BaseModel):
    """Body for ``GET /v1/login/sender`` — the bare address auth mail really
    sends from, parsed out of ``Settings.email_from``'s RFC 5322 display form
    (``FortyMM <noreply@fortymm.com>`` -> ``noreply@fortymm.com``). A static,
    deployment-wide constant, not user- or request-specific, so it is safe to
    serve with no cookie and no captcha. ``None`` only when the configured
    value doesn't parse to an address at all — the client renders without a
    sender row rather than a broken one."""

    address: str | None


class ConsumeLoginRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)
    # See ConfirmEmailRequest.skip_merge — sign in without folding the recorded
    # guest's matches in.
    skip_merge: bool = False


class MergePreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=1, max_length=512)


class MergePreview(BaseModel):
    """Side-effect-free look at an emailed link before it's consumed, so the
    client can decide whether to show a "bring N matches over?" confirmation.

    ``is_merge`` is true only for a link that would fold a guest into another
    account (a settings merge token, or a sign-in token that recorded a
    requesting guest). The client shows the gate only when there are matches to
    carry (``guest_matches_count > 0``); otherwise it finalizes silently.

    ``adopts_guest_username`` is true only when the link is a *first* sign-in,
    where the account being signed into was minted moments ago and its
    ``owner_username`` is a throwaway generated slug. Accepting the merge moves
    ``guest_username`` onto it; declining leaves the generated one. On every
    other merge the username does not move, so the gate must not promise it
    will."""

    is_merge: bool
    owner_username: str | None = None
    guest_username: str | None = None
    guest_matches_count: int = 0
    adopts_guest_username: bool = False
