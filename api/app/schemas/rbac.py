import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class PermissionBase(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1024)


class PermissionCreate(PermissionBase):
    pass


class PermissionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
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
