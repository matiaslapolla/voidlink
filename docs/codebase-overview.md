# VoidLink — Codebase Overview

> Generated: 2026-04-02

---

## Features

- **Document Editor**: Notion-style block editor (Tiptap/ProseMirror), slash commands, markdown paste, export (CSV/JSON/text)
- **Integrated Terminal**: Real PTY with multiple sessions, split-view (Ctrl+\\)
- **Repository Scanner & Search**: Hybrid lexical + semantic search with embeddings, .gitignore-aware
- **Workflow Engine**: LLM-powered workflow DSL generation from objectives, execution with retry logic
- **5-Phase Git Suite**:
  - Phase 1: Core ops (branch, stage, commit, push)
  - Phase 2: Worktrees (isolated under `.worktrees/`)
  - Phase 3: Diff viewer (working tree, branch comparison, file explanations)
  - Phase 4: Autonomous AI agent (task → branch → implement → PR)
  - Phase 5: PR dashboard (review checklists, merge, audit log)
- **Settings**: Workspace/tab persistence, vibrancy effects (macOS)

---

## Architecture

```
voidlink/
├── src-tauri/           (Rust, ~5,634 lines)
│   ├── lib.rs           command registration, global state, PTY store
│   ├── migration.rs     scanner, index builder, hybrid search, workflow engine
│   ├── git.rs           phases 1-3: core git ops, worktrees, diffs
│   ├── git_agent.rs     phase 4: autonomous AI agent, event streaming
│   └── git_review.rs    phase 5: PR review, GitHub API, merge, audit log
├── frontend/            (SolidJS, 35 components)
│   └── src/
│       ├── App.tsx      workspace/tab orchestration
│       ├── api/         Tauri invoke wrappers
│       ├── types/       TypeScript interfaces mirroring Rust
│       └── components/
│           ├── git/     (13 components)
│           ├── editor/  Tiptap integration
│           ├── terminal/ xterm.js + PTY bridge
│           └── ...
└── backend/             (Optional FastAPI + PostgreSQL)
```

**Key patterns:**

- `#[tauri::command]` Rust → `invoke()` TypeScript IPC
- `Arc<Mutex<HashMap>>` state stores for PTY sessions, agent tasks, git repos
- Real-time via `app_handle.emit(...)` → SolidJS `createEffect` listeners
- All state in SQLite (local-first); PostgreSQL optional for page persistence

---

## User Flows

| Flow | Steps |
|------|-------|
| **Scan & Search** | Pick repo → scan (respects .gitignore) → build SQLite index + embeddings → hybrid search → bundle context |
| **Workflow** | Write objective → LLM generates DSL → review → execute steps → results + audit trail |
| **AI Git Agent** | Enter task → LLM names branch → create worktree → implement + commit → push → draft PR |
| **PR Review** | List PRs → select → generate AI checklist → mark items → merge (merge/squash/rebase) → logged to audit |

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop shell | Tauri 2 (2.10.3) |
| Core logic | Rust 1.77+ |
| Frontend | SolidJS 1.9.7 |
| Styling | Tailwind 4 + shadcn/ui |
| Editor | Tiptap (ProseMirror) |
| Terminal | xterm.js + portable-pty |
| Git | git2-rs (vendored libgit2, no system binary needed) |
| Database | SQLite (rusqlite bundled) + optional PostgreSQL |
| HTTP | reqwest (rustls) |
| AI | Multi-provider adapter: OpenAI, Groq, OpenRouter, Ollama |
| Optional backend | FastAPI + Python 3.13 |

---

## Future Plans

From `PLAN.md` and code TODOs:

**Short-term:**
- Parameterized SQL wrapper
- pgvector semantic search inline in editor
- Plugin API for AI-assisted dev
- E2E tests (Playwright), 80% coverage target

**Medium-term:**
- Real-time collaboration (CRDT/Yjs)
- Local LLM support (Ollama config already in place)
- Plugin system for custom blocks
- Windows support
- Mobile read-only companion

**Infrastructure:**
- Tauri release builds for macOS/Linux
- Self-host Docker guide

---

## Deprecated / Sidelined

| Item | Status |
|------|--------|
| `NotionPane.tsx` (5,051 lines) + `PageTreePanel.tsx` (4,837 lines) | Still functional but sidelined after hard pivot to repo-centric workflow |
| Optional FastAPI backend (pages CRUD) | Not deprecated, just not central — frontend falls back to localStorage |
| `greet(name)` command in `lib.rs` | Tauri demo stub, not used in UI |
| Old localStorage format | One-time migration on startup via `MIGRATION_MARKER_KEY`, then discarded |
| `migration.rs` (2,711 lines in one file) | Not deprecated, but flagged for future sub-module split |

---

## Notes

The biggest recent shifts:

- **React → SolidJS migration** completed (~8 commits, Jan 2026)
- **Hard pivot** from Notion-clone to repo-centric dev tool — the 5-phase Git integration is now the headline feature
