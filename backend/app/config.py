import os

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://voidlink:voidlink@localhost:5432/voidlink",
)
