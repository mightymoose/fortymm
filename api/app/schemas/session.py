from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

# Lowercase alphanumerics with optional dots/hyphens/underscores between them.
# Must start and end with an alphanumeric so we don't store names that look
# like punctuation. 40 chars admits the auto-generated `slug-slug-XXXXXXXX`
# format with headroom while keeping display sane.
USERNAME_PATTERN = r"^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$"
USERNAME_MIN_LENGTH = 3
USERNAME_MAX_LENGTH = 40


class SessionUser(BaseModel):
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
    email: EmailStr


class ResendEmailRequest(CaptchaProtectedRequest):
    pass


class ConfirmEmailRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)


class RequestLoginRequest(CaptchaProtectedRequest):
    email: EmailStr


class LoginRequestAccepted(BaseModel):
    """202 body for the magic-link request endpoint. Always echoes the
    submitted address — identical whether or not it maps to a real account,
    so the response leaks nothing about which addresses are registered."""

    email: EmailStr


class ConsumeLoginRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)
