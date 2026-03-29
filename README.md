# VoidLink

Local-first desktop tool suite combining a Notion-style document editor, integrated terminal, repository intelligence (scanning + semantic search + workflow generation), and a full Git suite with an autonomous AI agent. Built with Tauri, SolidJS, and Rust.

## Tech Stack

| Layer | Technology | Role |
|---|---|---|
| Desktop shell | **Tauri 2** | Native window, JS ↔ Rust IPC |
| Core logic | **Rust** | Git, AI, repo scanning, PTY — all heavy work |
| Frontend | **SolidJS + TypeScript** | Reactive UI rendered in WebView |
| Styles | **Tailwind CSS 4 + shadcn/ui** (`@kobalte/core`) | CSS utilities, headless components |
| Editor | **Tiptap v3** (ProseMirror) | Rich text / block editor |
| Terminal | **portable-pty** (Rust) + **xterm.js** | Real PTY, canvas-rendered terminal |
| Git | **git2** (libgit2, vendored) | Git operations without requiring git binary |
| Database | **rusqlite** (SQLite, bundled) | Local embedded DB for index, workflows, audit log |
| HTTP | **reqwest** (blocking, rustls) | GitHub REST API calls |
| AI | Multi-provider adapter | OpenAI, Groq, OpenRouter, Ollama |
| Backend (optional) | **Python 3.13 + FastAPI + SQLAlchemy** | Notion page persistence in PostgreSQL |
| Infra (optional) | **Docker Compose** | Postgres + FastAPI for optional backend |

---

## Features

### Document Editor
Notion-style block editor powered by Tiptap.
- Rich text formatting (bold, italic, headings, lists, code blocks, blockquotes, task lists)
- Slash command menu (`/`) for inserting blocks
- Markdown paste support
- Nested page nodes
- Export to CSV, JSON, and plain text
- Inline tab rename (double-click)

### Terminal
Real PTY terminal powered by `portable-pty` + `xterm.js`.
- Multiple independent terminal sessions across tabs
- Each session has its own PTY with the user's default shell
- Split view: two tabs side by side (`Ctrl+\`)

### Repository Scanner & Search
Local-first repo intelligence (runs entirely on-device).
- Scans a repository respecting `.gitignore` rules
- Builds a file/chunk index with embeddings stored in SQLite
- Hybrid search: lexical (TF-IDF) + semantic (embedding similarity)
- Context builder: select search results and free text, enforce token budget
- Workflow generator: provide an objective + context → LLM generates a `WorkflowDSL` (steps with tools, dependencies, acceptance checks)
- Workflow executor: runs steps sequentially with retry and progress events

### Git Suite (Phases 1–5)

**Phase 1 — Core ops**
- Repo info (branch, HEAD, remote URL, clean state)
- List, create, and switch branches
- File status (modified, staged, untracked)
- Stage files, write commit message, commit, push

**Phase 2 — Worktrees**
- Create/list/delete git worktrees isolated under `.worktrees/`
- Open a terminal tab directly in any worktree

**Phase 3 — Diff viewer**
- Working tree diff, branch comparison, commit diffs
- File list with hunk/line-level view (added/removed lines)
- AI-powered diff explanation (summary, risk level, suggestions) — requires LLM

**Phase 4 — Autonomous AI agent**
- Provide a task objective and a base branch
- Agent pipeline: LLM generates branch name → creates worktree → implements changes → commits → pushes → opens draft PR on GitHub
- Real-time event log in the UI per step
- Requires `GITHUB_TOKEN` + LLM provider

**Phase 5 — PR dashboard & merge**
- Lists open PRs from the connected GitHub repository
- AI-generated review checklist per PR (security, performance, correctness, style, testing)
- Mark checklist items as passed/flagged
- One-click merge (merge / squash / rebase) with optional branch deletion
- SQLite audit log of all actions (generate checklist, update item, merge)
- Requires `GITHUB_TOKEN`

### Settings
- Background opacity and vibrancy effect (macOS only)
- Workspace and tab state persisted across restarts

---

## Prerequisites

- **Node.js** 20+
- **Rust** 1.77+ (`rustup update stable`)
- **Python** 3.13+ with [uv](https://docs.astral.sh/uv/) *(optional backend only)*
- **Docker** *(optional backend only)*
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`

---

## Quick Start

### Desktop App (Tauri + SolidJS)

```bash
# Install frontend dependencies
cd frontend && npm install && cd ..

# Start (macOS)
cargo tauri dev

# Start (Linux / Wayland)
WAYLAND_DISPLAY="" cargo tauri dev
```

### Frontend Only (no Tauri window)

```bash
cd frontend
npm run dev
# Opens at http://localhost:5173
```

### Optional Backend (FastAPI + PostgreSQL)

```bash
# Start Postgres
docker compose up postgres -d

# Start FastAPI
cd backend
uv sync
uv run uvicorn app.main:app --reload
# API at http://localhost:8000 — health check at /health
```

---

## Environment Variables

Copy `.env.example` to `.env`:

### Database (optional backend)

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://voidlink:voidlink@localhost:5432/voidlink` | Postgres connection string |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:1420` | Allowed CORS origins |

### LLM Provider (AI features)

| Variable | Default | Description |
|---|---|---|
| `VOIDLINK_LLM_PROVIDER` | `openai` | `openai`, `groq`, `openrouter`, or `ollama` |
| `VOIDLINK_LLM_TIMEOUT_SECS` | `30` | HTTP timeout for LLM calls |
| `OPENAI_API_KEY` | — | Required when provider is `openai` |
| `GROQ_API_KEY` | — | Required when provider is `groq` |
| `OPENROUTER_API_KEY` | — | Required when provider is `openrouter` |
| `VOIDLINK_OPENAI_MODEL` | `gpt-4o-mini` | Chat model (OpenAI) |
| `VOIDLINK_GROQ_MODEL` | `llama-3.3-70b-versatile` | Chat model (Groq) |
| `VOIDLINK_OPENROUTER_MODEL` | `openai/gpt-4.1-mini` | Chat model (OpenRouter) |
| `VOIDLINK_OLLAMA_MODEL` | `llama3.2` | Chat model (Ollama) |
| `VOIDLINK_OPENAI_EMBED_MODEL` | `text-embedding-3-small` | Embeddings model (OpenAI) |
| `VOIDLINK_OPENROUTER_EMBED_MODEL` | `openai/text-embedding-3-small` | Embeddings model (OpenRouter) |
| `VOIDLINK_OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embeddings model (Ollama) |
| `VOIDLINK_OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL override (OpenAI-compatible) |

For Ollama, `OPENAI_API_KEY` is optional.

### GitHub (Git agent and PR dashboard)

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | Personal access token with `repo` scope — required for Phase 4 (agent) and Phase 5 (PR dashboard/merge) |

---

## Running Tests

```bash
# Frontend (Vitest)
cd frontend && npm test

# Backend (pytest) — optional
cd backend && uv run pytest

# Rust (cargo)
cd src-tauri && cargo test
```

---

## Manual Testing Guide

### Smoke test checklist

```
[ ] App opens without errors
[ ] Workspace persists after restart
[ ] Terminal opens and executes commands
[ ] Split view works with 2 tabs (Ctrl+\)
[ ] Document editor formats text correctly (bold, headings, slash commands)
[ ] GitStatusBar shows correct branch
[ ] Can list and switch branches
[ ] Can view working tree diff
[ ] Can create and delete a worktree
[ ] PRs are listed when GITHUB_TOKEN is set
```

### Editor

1. Open or create a Document tab
2. Type text, apply bold (`Ctrl+B`), italic (`Ctrl+I`), inline code
3. Type `/` — confirm the slash command menu appears with block options
4. Double-click a tab title — confirm inline rename works
5. Use the toolbar export menu — verify CSV, JSON, and plain text downloads

### Terminal

1. Click `+` → "New Terminal" — confirm shell prompt appears
2. Run `echo "hello"` — confirm output
3. Open a second terminal tab, run `pwd` in each — confirm independent sessions
4. Open two tabs, use `Ctrl+\` — confirm split view with both panels active

### Repository Scanner

> Requires a local git repository with multiple files.

1. Select a repo path in the workspace
2. Start a scan — confirm file count progress and "done" state
3. Type a search query — confirm results with file paths and snippets
4. Add results to context, write an objective, click "Generate Workflow" — confirm DSL with named steps appears

### Git — Phase 1 (Core ops)

> Requires a local git repo with at least 2 branches.

1. Open the Git tab — confirm `GitStatusBar` shows the current branch
2. Go to "Branches" — confirm all local branches are listed, current one marked
3. Click a different branch — confirm the switch and status bar update
4. Modify a file, go to "Status", click Refresh — confirm the file appears as `modified`
5. Stage the file, write a commit message, commit — confirm the entry appears in "Log"

### Git — Phase 2 (Worktrees)

1. Go to "Worktrees", enter a branch name (e.g. `feature/test`), click "Create Worktree"
2. Confirm `.worktrees/feature/test` exists in the repo
3. Click the terminal icon next to the worktree — confirm terminal opens in that directory
4. Delete the worktree — confirm it disappears from the list and filesystem

### Git — Phase 3 (Diff viewer)

1. Modify a file (unstaged), go to "Diff" — confirm file list with hunk/line view (green/red lines)
2. Switch to "Branch comparison", pick two branches — confirm full diff
3. Click "Explain" on a file — confirm AI explanation appears with risk level *(requires LLM)*

### Git — Phase 4 (AI Agent)

> Requires `GITHUB_TOKEN` + LLM provider configured.

1. Go to "AI Agent", write an objective, select base branch, enable "Auto-create PR"
2. Click "Start Task" — confirm real-time event log showing: branching → implementing → pr_creating → success
3. Copy the PR link shown — confirm draft PR exists on GitHub with AI-generated description
4. Start a new task, click "Cancel" before it finishes — confirm state becomes `failed`, no PR created

### Git — Phase 5 (PR Dashboard)

> Requires `GITHUB_TOKEN` + open PRs in the connected GitHub repo.

1. Go to "Pull Requests" — confirm open PRs listed with title, author, branch
2. Click "Review" on a PR → "Generate Checklist" — confirm items grouped by category (security, performance, correctness, style, testing)
3. Mark items as passed/flagged — confirm state persists on view reload
4. Go to "Audit" — confirm action history with timestamps and actor (human/ai-agent)
5. With a **test PR**: select merge method, click "Merge" — confirm PR merges on GitHub and audit log entry is created

### Known error behaviors

| Scenario | Expected behavior |
|---|---|
| `GITHUB_TOKEN` not set | PR/Agent features show a descriptive error; rest of app unaffected |
| No LLM provider configured | AI features show error; Git core ops and terminal still work |
| Repo without remote | `push` fails with clear message; staging/commit work normally |
| Worktree with uncommitted changes on delete | Requires "Force delete" option; fails with message otherwise |
| Dirty working tree when switching branch | Operation fails with a message asking to commit or stash first |

---

## Project Structure

```
voidlink/
├── frontend/               # SolidJS + Vite + TypeScript
│   └── src/
│       ├── App.tsx         # Root component, workspace/tab orchestration
│       ├── api/            # IPC wrappers (invoke → Tauri command)
│       ├── types/          # TypeScript interfaces mirroring Rust structs
│       └── components/
│           ├── git/        # Git suite (13 components)
│           ├── editor/     # Tiptap editor + slash commands
│           ├── terminal/   # TerminalPane + xterm.js
│           └── tabs/       # Tab strip + new tab picker
├── src-tauri/              # Rust (Tauri desktop shell)
│   └── src/
│       ├── lib.rs          # Command registration, global state
│       ├── migration.rs    # Repo scanner, hybrid search, workflow engine, LLM adapter
│       ├── git.rs          # Git ops phases 1–3 (git2)
│       ├── git_agent.rs    # Autonomous AI agent pipeline (phase 4)
│       └── git_review.rs   # PR dashboard, merge, SQLite audit log (phase 5)
├── backend/                # Python FastAPI (optional — Notion page persistence)
├── docs/                   # Architecture and planning docs
└── docker-compose.yml
```

---

## License

MIT
