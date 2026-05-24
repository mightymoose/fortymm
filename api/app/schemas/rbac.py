import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# Permission names follow a `resource.action` convention (e.g. `tournament.publish`).
# Allowed chars per segment: lowercase letters, digits, underscores. At least
# one dot is required so the UI's prefix grouping doesn't bucket everything as
# `other.*`.
PERMISSION_NAME_PATTERN = r"^[a-z0-9_]+(?:\.[a-z0-9_]+)+$"


class PermissionBase(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1024)


class PermissionCreate(PermissionBase):
    # Pattern is enforced on write only — historical rows that predate this
    # constraint must still serialize cleanly through PermissionRead.
    name: str = Field(min_length=1, max_length=255, pattern=PERMISSION_NAME_PATTERN)


class PermissionUpdate(BaseModel):
    name: str | None = Field(
        default=None,
        min_length=1,
        max_length=255,
        pattern=PERMISSION_NAME_PATTERN,
    )
    description: str | None = Field(default=None, max_length=1024)


class PermissionRead(PermissionBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class RoleBase(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1024)


class RoleCreate(RoleBase):
    template_id: uuid.UUID | None = None
    permission_ids: list[uuid.UUID] | None = None


class RoleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1024)
    permission_ids: list[uuid.UUID] | None = None


class RoleRead(RoleBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime
    permission_ids: list[uuid.UUID]


class RbacUserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=255)


class RbacUserRolesUpdate(BaseModel):
    role_ids: list[uuid.UUID]


class RbacUserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    created_at: datetime
    role_ids: list[uuid.UUID]
