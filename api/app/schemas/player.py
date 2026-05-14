import uuid

from pydantic import BaseModel, ConfigDict


class PlayerRead(BaseModel):
    """A user the current player can pick as a match opponent."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
