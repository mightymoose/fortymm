import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class UserBase(BaseModel):
    username: str = Field(min_length=1, max_length=255)


class UserCreate(UserBase):
    pass


class UserRead(UserBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class UserProfile(BaseModel):
    """Minimal user shape for profile pages — public-safe (no email)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
