# VoidLink — Build Plan

> Tauri + React + FastAPI desktop tool suite.
> Notion-style editor, DB querying, structured data exports.

## Stack

| Layer      | Tech                                        |
|------------|---------------------------------------------|
| Frontend   | React 18, Vite, TypeScript, shadcn/ui, Tiptap |
| Desktop    | Tauri (Rust)                                |
| Backend    | Python 3.13, FastAPI, SQLAlchemy, uv        |
| Database   | PostgreSQL 16 (pgvector optional)           |
| Infra      | Docker Compose, GitHub Actions CI/CD        |

---

## Phase 1: Project Setup and Foundations — DONE

### Task 1.1: Initialize Monorepo ✅
- Git repo with `/frontend`, `/backend`, `/src-tauri`
- `.gitignore`, `LICENSE` (MIT), `docker-compose.yml`

### Task 1.2: Configure Tauri with React ✅
- Tauri wraps React frontend, `@tauri-apps/api` integrated
- Greet command exposed from Rust, `cargo check` passes

### Task 1.3: Set Up FastAPI Backend and Docker ✅
- `app/main.py`, `database.py`, `config.py`
- Docker Compose: Postgres + FastAPI services
- Health endpoint at `/health`

### Task 1.4: Initial Testing and CI ✅
- Vitest (frontend), pytest (backend), cargo test (Rust)
- `.github/workflows/ci.yml` — runs on push/PR to main

---

## Phase 2: Notion-Style Editor — DONE

### Task 2.1: Tiptap Editor ✅
- Block-based editor with toolbar and slash commands
- Sidebar navigation, localStorage persistence
- Markdown support via Tiptap extensions

### Task 2.2: FastAPI Pages CRUD ✅
- `/api/pages` endpoints (create, read, update, delete)
- Frontend API client with localStorage fallback when backend unavailable

### Task 2.3: Export Menu ✅
- Export from toolbar: CSV, JSON, plain text
- Parses Tiptap JSON to structured output

---

## Phase 3: DB Querying Wrapper — TODO

### Task 3.1: DB Schema and SQL Wrapper
- Postgres schema for pages/docs (id, content_json, metadata)
- `/api/query` endpoint with parameterized SQL
- Evaluate pgvector for semantic search vs full-text search
- **Guard**: parameterized queries only, no raw SQL passthrough

### Task 3.2: Integrate Querying into Editor
- Search bar UI in React (shadcn Command palette)
- Call `/api/query`, display results inline as editor blocks
- Paginated results

### Task 3.3: Export Query Results
- `/api/export` endpoint: format query results as CSV/JSON
- Stream large datasets
- Extend existing export menu to include query outputs

---

## Phase 4: AI Optimization, Testing, Deployment — TODO

### Task 4.1: Optimize for AI Coding Agents
- Add extension hooks and plugin points
- Document API contracts for AI-assisted development

### Task 4.2: Full Testing
- E2e tests (Playwright or Cypress)
- Performance benchmarks (RAM, startup time)
- Target: 80% coverage across all layers

### Task 4.3: Self-Host Guide and Builds
- Tauri release builds for macOS and Linux
- Docker-based self-host deployment guide
- Environment variable documentation for custom DB (e.g., Neon)

---

## Future (Post-MVP)

- Real-time collaboration (CRDT/Yjs)
- Local LLM integration (Ollama)
- Plugin system for custom blocks/extensions
- Windows support
- Mobile companion (read-only)
