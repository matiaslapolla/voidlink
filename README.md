# VoidLink

Desktop tool suite — Notion-style editor, DB querying, and structured data exports. Built with Tauri, React, and FastAPI.

## Prerequisites

- **Node.js** 22+
- **Rust** 1.94+ (`rustup update stable`)
- **Python** 3.13+ with [uv](https://docs.astral.sh/uv/)
- **Docker** (for Postgres)
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`

## Quick Start

### 1. Start Postgres

```bash
docker compose up postgres -d
```

### 2. Start the Backend (FastAPI)

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload
```

API runs at http://localhost:8000. Check http://localhost:8000/health.

### 3. Install Tauri CLI (one-time)

```bash
cargo install tauri-cli
```

### 4. Start the Desktop App (Tauri + React)

```bash
cd frontend
npm install
cd ..
cargo tauri dev
```

This launches the React dev server and opens the Tauri desktop window.

### 5. Frontend Only (no Tauri)

```bash
cd frontend
npm run dev
```

Opens at http://localhost:5173.

## Running Tests

```bash
# Frontend (Vitest)
cd frontend && npm test

# Backend (pytest)
cd backend && uv run pytest

# Rust (cargo)
cd src-tauri && cargo test
```

## Docker (Full Stack)

```bash
docker compose up
```

Starts Postgres + FastAPI backend. Then run `cargo tauri dev` from the project root for the desktop app.

## Project Structure

```
voidlink/
├── frontend/       # React + Vite + TypeScript
├── backend/        # Python FastAPI + SQLAlchemy
├── src-tauri/      # Rust (Tauri desktop shell)
└── docker-compose.yml
```

## Environment Variables

Copy `.env.example` to `.env` and adjust as needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://voidlink:voidlink@localhost:5432/voidlink` | Postgres connection string |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:1420` | Allowed CORS origins |

## License

MIT
