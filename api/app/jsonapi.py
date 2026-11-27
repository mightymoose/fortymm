from pydantic import BaseModel


class Document[T: BaseModel](BaseModel):
    """A JSON:API-style top-level document: the response payload goes under `data`."""

    data: T
