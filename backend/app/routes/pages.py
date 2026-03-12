from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Page
from app.schemas import PageCreate, PageOut, PageSummary, PageUpdate

router = APIRouter(prefix="/pages", tags=["pages"])


@router.get("/", response_model=list[PageSummary])
def list_pages(db: Session = Depends(get_db)):
    return db.query(Page).order_by(Page.updated_at.desc()).all()


@router.post("/", response_model=PageOut, status_code=201)
def create_page(data: PageCreate, db: Session = Depends(get_db)):
    kwargs = {"title": data.title, "content": data.content, "parent_id": data.parent_id}
    if data.id:
        kwargs["id"] = data.id
    page = Page(**kwargs)
    db.add(page)
    db.commit()
    db.refresh(page)
    return page


@router.get("/{page_id}", response_model=PageOut)
def get_page(page_id: str, db: Session = Depends(get_db)):
    page = db.get(Page, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    return page


@router.patch("/{page_id}", response_model=PageOut)
def update_page(page_id: str, data: PageUpdate, db: Session = Depends(get_db)):
    page = db.get(Page, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    if data.title is not None:
        page.title = data.title
    if data.content is not None:
        page.content = data.content
    db.commit()
    db.refresh(page)
    return page


@router.delete("/{page_id}", status_code=204)
def delete_page(page_id: str, db: Session = Depends(get_db)):
    page = db.get(Page, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    db.delete(page)
    db.commit()
