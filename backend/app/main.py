import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.database import Base, engine
from app.routes.pages import router as pages_router

Base.metadata.create_all(bind=engine)

# Safe migration: add parent_id if the column doesn't exist yet
with engine.connect() as _conn:
    _conn.execute(text("ALTER TABLE pages ADD COLUMN IF NOT EXISTS parent_id VARCHAR(36) NULL"))
    _conn.commit()

app = FastAPI(title="VoidLink API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(pages_router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}
