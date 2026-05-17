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


class SessionData(BaseModel):
    user: SessionUser


class SessionResponse(BaseModel):
    data: SessionData


class UpdateCurrentUserRequest(BaseModel):
    username: str = Field(
        min_length=USERNAME_MIN_LENGTH,
        max_length=USERNAME_MAX_LENGTH,
        pattern=USERNAME_PATTERN,
    )


class SetEmailRequest(BaseModel):
    email: EmailStr
    captcha_token: str = Field(min_length=1, max_length=4096)
    # Honeypot — bots fill in every field; humans never see this one because
    # the FE keeps it visually hidden. Any non-empty value short-circuits the
    # request as if it succeeded (so bots don't learn the field is a trap).
    website: str = Field(default="", max_length=512)


class ConfirmEmailRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)


class ResendEmailRequest(BaseModel):
    captcha_token: str = Field(min_length=1, max_length=4096)
    website: str = Field(default="", max_length=512)
