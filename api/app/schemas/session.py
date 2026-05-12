from pydantic import BaseModel


class SessionUser(BaseModel):
    username: str
    permissions: list[str]


class SessionData(BaseModel):
    user: SessionUser


class SessionResponse(BaseModel):
    data: SessionData
