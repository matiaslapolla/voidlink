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

### LLM Provider (Tauri migration engine)

The migration engine supports OpenAI-compatible providers via env vars:

| Variable | Default | Description |
|----------|---------|-------------|
| `VOIDLINK_LLM_PROVIDER` | `openai` | `openai`, `groq`, `openrouter`, or `ollama` |
| `VOIDLINK_LLM_TIMEOUT_SECS` | `30` | HTTP timeout for provider calls |
| `OPENAI_API_KEY` | - | OpenAI key (used when provider is `openai`) |
| `GROQ_API_KEY` | - | Groq key (used when provider is `groq`) |
| `OPENROUTER_API_KEY` | - | OpenRouter key (used when provider is `openrouter`) |
| `VOIDLINK_OPENAI_MODEL` | `gpt-5-mini` | Chat model for OpenAI |
| `VOIDLINK_GROQ_MODEL` | `llama-3.3-70b-versatile` | Chat model for Groq |
| `VOIDLINK_OPENROUTER_MODEL` | `openai/gpt-4.1-mini` | Chat model for OpenRouter |
| `VOIDLINK_OLLAMA_MODEL` | `llama3.2` | Chat model for Ollama |
| `VOIDLINK_OPENAI_EMBED_MODEL` | `text-embedding-3-small` | Embeddings model for OpenAI |
| `VOIDLINK_OPENROUTER_EMBED_MODEL` | `openai/text-embedding-3-small` | Embeddings model for OpenRouter |
| `VOIDLINK_GROQ_EMBED_MODEL` | - | Optional embeddings model for Groq (if available) |
| `VOIDLINK_OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embeddings model for Ollama |
| `VOIDLINK_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL override |
| `VOIDLINK_GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Groq base URL override |
| `VOIDLINK_OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter base URL override |
| `VOIDLINK_OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama OpenAI-compatible base URL |
| `VOIDLINK_OPENROUTER_SITE_URL` | `https://voidlink.local` | OpenRouter `HTTP-Referer` header |
| `VOIDLINK_OPENROUTER_APP_NAME` | `VoidLink` | OpenRouter `X-Title` header |

Ollama note:
- If your local Ollama is running, set `VOIDLINK_LLM_PROVIDER=ollama`.
- API key is optional for Ollama.

## License

MIT
