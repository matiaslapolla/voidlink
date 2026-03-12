# MVP Plan for Tool Suite App: Tauri + React Desktop Application

This MVP plan is structured for efficient execution by AI coding agents (e.g., Claude Dev, GitHub Copilot, or Codex). Each phase includes clear, modular tasks with detailed instructions, dependencies, input/output expectations, and code snippets where applicable. Tasks are broken into small, self-contained units (e.g., "Implement X component") that can be pasted directly into AI tools for generation, review, and iteration. Prioritize strong foundations: Focus on clean architecture, modularity, error handling, and testing in early phases. Since there's no hurry, emphasize thoroughness—include edge cases, nuances, and implications in task descriptions.

The MVP scope narrows to core features: 
- Notion-style editor (using Tiptap or similar for block-based composition with Markdown support).
- Querying info from DB (wrapper for RAG or SQL; review vector vs. SQL—start with SQL for simplicity, add vector if needed for semantic search).
- Export data to structured tables (e.g., CSV/JSON exports from editor/DB queries).

Tech Stack:
- **Frontend**: React 18+ with shadcn/ui (for components like buttons, modals), Tiptap (editor).
- **Backend**: Rust (Tauri core for desktop integration), Python FastAPI (API server for DB/AI logic).
- **Database**: Postgres (with optional pgvector for RAG; use Neon-compatible setup for custom backends).
- **Deployment/Self-Host**: Docker Compose for local setup (DB, FastAPI); Tauri builds for desktop executables. Open source on GitHub with setup guide. Cross-platform: Test on macOS and Linux.
- **General**: Modular design (plugins for features). No mobile. AI agents as primary builders—tasks include prompts for code gen.

Plan Phases: Sequential but with parallelizable sub-tasks. Total estimated time: 2-4 weeks (flexible). Milestones: End of each phase includes testing and review.

## Phase 1: Project Setup and Foundations (1-3 days)
Focus: Establish monorepo, configure tools, and ensure cross-platform dev environment. This builds strong foundations for modularity and AI-assisted coding.

### Task 1.1: Initialize Monorepo
- **Description**: Set up a Git monorepo for frontend (React), backend (FastAPI), and Tauri (Rust). Include .gitignore, LICENSE (MIT for open source), and README with setup instructions.
- **Dependencies**: None.
- **Steps for AI Agent**:
  1. Create GitHub repo: "tool-suite-app".
  2. In root: `cargo new src-tauri` (for Tauri/Rust).
  3. In root: `npx create-react-app frontend --template typescript` (or Vite for speed: `npm create vite@latest frontend -- --template react-ts`).
  4. In root: `mkdir backend && cd backend && poetry init` (use Poetry for Python deps; add FastAPI, SQLAlchemy).
- **Edge Cases/Nuances**: Ensure cross-platform (macOS/Linux) by avoiding OS-specific paths. Implication: Allows separate deploys (e.g., FastAPI to cloud).
- **Output**: Committed repo with folders: /frontend, /backend, /src-tauri.
- **Test**: Run `git clone` on macOS and Linux; verify no errors.

### Task 1.2: Configure Tauri with React
- **Description**: Integrate Tauri to wrap React as desktop app. Use shadcn/ui for UI consistency.
- **Dependencies**: Task 1.1.
- **Steps for AI Agent** (Prompt: "Generate Tauri config for React app with shadcn/ui"):
  1. In root: `npm install -g @tauri-apps/cli`.
  2. Run `tauri init` in /frontend (or root if monorepo).
  3. Edit `tauri.conf.json`: Set productName, window title, frontend dist to /frontend/build.
  4. In /frontend: `npx shadcn-ui@latest init` (add components like Button, Input).
  5. Add basic Rust command: In src-tauri/src/main.rs, expose a greet fn.
- **Edge Cases**: Linux webview issues—add fallback to WebKitGTK. Nuances: Hot-reload works on macOS; test on Linux.
- **Output**: Runnable desktop app shell (e.g., `tauri dev` launches window with React "Hello World").
- **Test**: Build on macOS/Linux; check RAM usage (<100MB idle).

### Task 1.3: Set Up FastAPI Backend and Docker
- **Description**: Basic FastAPI server for API endpoints. Docker for self-hosting DB/FastAPI.
- **Dependencies**: Task 1.1.
- **Steps for AI Agent** (Prompt: "Create FastAPI app with Postgres connection; include Docker Compose"):
  1. In /backend: `poetry add fastapi uvicorn sqlalchemy psycopg2-binary`.
  2. Create app.py: Basic /health endpoint.
  3. In root: docker-compose.yml with services: postgres (image: postgres:16), fastapi (build: ./backend).
  4. Setup guide in README: "docker-compose up" for local; mention Neon for custom (env vars for DB URL).
- **Edge Cases**: Handle DB migrations with Alembic. Implication: Allows decoupling—users swap to Neon.
- **Output**: Running backend at localhost:8000; connected to Postgres.
- **Test**: Curl /health; verify on macOS/Linux.

### Task 1.4: Initial Testing and CI
- **Description**: Add basic tests and GitHub Actions for cross-platform builds.
- **Steps for AI Agent**: Jest for React, pytest for FastAPI, cargo test for Rust.
- **Output**: .github/workflows/build.yml.
- **Milestone**: Commit foundations; review for modularity.

## Phase 2: Notion-Style Editor Implementation (3-5 days)
Focus: Core UI feature. Make it modular for easy extension (e.g., future collab).

### Task 2.1: Integrate Tiptap Editor in React
- **Description**: Block-based editor with Markdown support. Use shadcn for styling.
- **Dependencies**: Phase 1.
- **Steps for AI Agent** (Prompt: "Implement Notion-like editor in React with Tiptap and shadcn/ui; include slash commands and Markdown export"):
  1. In /frontend: `npm install @tiptap/react @tiptap/starter-kit @tiptap/extension-document` (add more extensions as needed).
  2. Create Editor.tsx: ProseMirror-based editor with blocks (text, headings, lists).
  3. Add Markdown: Use @tiptap/extension-markdown for import/export.
  4. UI: Sidebar for page tree (use shadcn Tree component); editor in main view.
- **Edge Cases**: Offline editing—use localStorage for drafts. Nuances: Performance for large docs (debounce saves).
- **Output**: Editable page in desktop app.
- **Test**: Create/edit blocks; export Markdown.

### Task 2.2: Connect Editor to FastAPI
- **Description**: Save/load editor content via API.
- **Steps for AI Agent**: Add /pages endpoints in FastAPI; use Axios in React to fetch/save JSON content.
- **Edge Cases**: Handle conflicts (basic versioning). Implication: Prepares for future collab.
- **Output**: Persistent editor data in DB.
- **Test**: CRUD operations.

### Task 2.3: Export to Structured Tables
- **Description**: Parse editor content to export as tables (e.g., if content has lists/tables, convert to CSV/JSON).
- **Steps for AI Agent** (Prompt: "Add export button in React editor; parse Tiptap JSON to CSV using PapaParse"):
  1. In Editor.tsx: Button to trigger export.
  2. Logic: Traverse editor JSON, extract tabular data (e.g., from bullet lists).
  3. If not tabular: Fallback to flat table (e.g., key-value from headings/paragraphs).
- **Edge Cases**: Non-structured content—warn user. Nuances: If possible, detect tables via Tiptap extensions.
- **Output**: Downloadable CSV/JSON.
- **Test**: Export sample doc; verify structure.

### Milestone: Demo editor with export; review for AI extensibility (e.g., add hooks for future AI gen).

## Phase 3: DB Querying Wrapper (RAG/SQL) (4-7 days)
Focus: Review vector vs. SQL—start with SQL for structured queries; add pgvector if semantic needed. Wrapper for unified access.

### Task 3.1: DB Schema and SQL Wrapper
- **Description**: Postgres schema for pages/docs. SQL wrapper in FastAPI for querying.
- **Dependencies**: Phase 1-2.
- **Steps for AI Agent** (Prompt: "Design Postgres schema for docs; create FastAPI endpoints for SQL queries with param sanitization"):
  1. Schema: Tables for pages (id, content_json, metadata).
  2. Wrapper: /query endpoint accepting SQL-like params (e.g., SELECT * WHERE keyword).
  3. Review: If vector better for RAG (semantic), install pgvector; else stick to SQL full-text search.
- **Edge Cases**: SQL injection—use parameterized queries. Nuances: For RAG, embed content with sentence-transformers.
- **Output**: Queryable DB.
- **Test**: Sample queries return results.

### Task 3.2: Integrate Querying into Editor
- **Description**: UI for querying (e.g., command console to search DB).
- **Steps for AI Agent**: Add search bar in React; call FastAPI /query.
- **Edge Cases**: Paginated results. Implication: If switching to vector, update to similarity search.
- **Output**: Display query results in editor (e.g., insert as block).
- **Test**: Search and insert.

### Task 3.3: Export Query Results to Tables
- **Description**: Extend export to include query outputs as tables.
- **Steps for AI Agent**: /export endpoint in FastAPI to format results as CSV.
- **Edge Cases**: Large datasets—stream exports.
- **Output**: Integrated export flow.
- **Test**: Query + export.

### Milestone: Review vector/SQL trade-offs (e.g., SQL for speed; vector for relevance). Commit; test cross-platform.

## Phase 4: AI Optimization, Testing, and Deployment (3-5 days)
Focus: Polish for AI agents; add self-host guide.

### Task 4.1: Optimize for AI Coding Agents
- **Description**: Add comments/hooks in code for easy extension (e.g., "// AI TODO: Add RAG here").
- **Steps for AI Agent**: Scan codebase; insert prompts.
- **Output**: Agent-friendly code.

### Task 4.2: Full Testing
- **Description**: Unit/e2e tests; performance benchmarks (RAM, speed).
- **Steps**: Use Cypress for frontend; profile with Rust tools.
- **Edge Cases**: macOS vs. Linux differences.
- **Output**: 80% coverage.

### Task 4.3: Self-Host Guide and Builds
- **Description**: README with Docker setup; Tauri builds for macOS/Linux.
- **Steps for AI Agent** (Prompt: "Write open-source setup guide for Docker + Neon fallback"):
  1. Guide: "Clone repo; docker-compose up; tauri build".
  2. Env vars for custom DB (e.g., Neon URL).
- **Output**: Distributable binaries; guide.
- **Test**: Install on fresh macOS/Linux.

### Milestone: MVP complete. Review foundations; plan iterations (e.g., add local LLMs next).
