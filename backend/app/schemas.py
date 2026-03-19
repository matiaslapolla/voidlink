from datetime import datetime

from pydantic import BaseModel


class PageCreate(BaseModel):
    id: str | None = None
    title: str = "Untitled"
    content: str = ""
    parent_id: str | None = None
    workspace_id: str | None = None


class PageUpdate(BaseModel):
    title: str | None = None
    content: str | None = None


class PageOut(BaseModel):
    id: str
    title: str
    content: str
    parent_id: str | None = None
    workspace_id: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PageSummary(BaseModel):
    id: str
    title: str
    parent_id: str | None = None
    workspace_id: str | None = None
    updated_at: datetime

    model_config = {"from_attributes": True}
