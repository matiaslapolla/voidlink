# VoidLink Migration Plan: Repo-Native Prompt + Workflow Builder (MVP)

## Summary

Hard-pivot the current Notion/Terminal product into a local-first repo intelligence app that:

1. Scans a repository and builds a searchable graph/index.
2. Provides Cursor-like optimized file search (hybrid lexical + semantic).
3. Builds spec-driven workflow steps from user prompt + selected context.
4. Executes workflow steps in a basic sequential run loop via an OpenAI-first provider adapter.

Target architecture remains desktop-first with Tauri, with optional CLI entrypoint and local SQLite persistence.

## Implementation Changes

### Product shell pivot

- Replace current tab model (`notion`/`terminal`) with 3 core work areas: `Repository`, `Context Builder`, `Workflow`.
- Remove old feature surfaces from default UX (hard pivot), keep only migration script for old local state cleanup.
- Keep workspace concept but redefine it around `repo_root`.

### Repository scan + graph/index subsystem (local, Tauri side)

- Add scanner pipeline: file discovery, ignore rules (`.gitignore` + app ignore), language detection, chunking.
- Build graph entities: `Repo`, `File`, `Symbol/Chunk`, `Edge(import|calls|contains|path_parent)`.
- Persist metadata + embeddings refs in local SQLite.
- Trigger model: initial full scan + incremental update (mtime/hash).

### Optimized file search (Cursor-inspired hybrid)

- Implement retrieval stages:
  1. lexical candidate generation (path/token/BM25),
  2. semantic candidate generation (embedding similarity),
  3. fusion + rerank,
  4. return snippets with stable file anchors.
- Expose search API for UI and workflow generator with filters (`path`, `language`, `type`, `max_tokens`).
- Add "why this result" metadata (matched terms, semantic score, graph proximity).

### Context engineering + prompt/workflow builder

- New panel with drag/drop from file tree + free text + search picks.
- Context packer that enforces token budget and prioritization (recency, relevance, diversity).
- Define fixed workflow DSL (JSON schema) for generated tasks:
  - `workflow`: id, objective, constraints
  - `steps[]`: id, intent, inputs, tools, expected_output, acceptance_checks, retry_policy
  - `artifacts[]`: outputs and references
- Generator uses prompt + selected context + search augmentation to output valid DSL only.

### Workflow execution engine + provider adapter

- Build basic sequential executor: `pending -> running -> success|failed|skipped`, step logs, simple retry.
- Tool contract for MVP: `search_files`, `open_file_snippet`, `write_note/artifact` (no destructive code edits in v1).
- Add OpenAI-first adapter behind provider interface (`generate`, `structured_generate`, `embed`) for future multi-provider support.

### Entry points and packaging

- Desktop launcher remains primary.
- CLI entry (`voidlink <path>`) opens app focused on repo path; fallback to picker if none.

## Public Interfaces / Types

### New Tauri commands

- `scan_repository(repoPath, options) -> scanJobId`
- `get_scan_status(scanJobId) -> progress`
- `search_repository(query, options) -> SearchResult[]`
- `generate_workflow(input) -> WorkflowDSL`
- `run_workflow(workflowId|dsl) -> RunId`
- `get_run_status(runId) -> RunState`

### New core contracts

- `SearchQuery`, `SearchResult`, `ContextBundle`, `WorkflowDSL`, `WorkflowStep`, `RunEvent`.

### Storage schema (SQLite)

- `repos`, `files`, `chunks`, `edges`, `embeddings`, `workflows`, `workflow_runs`, `run_events`.

## Test Plan

- Scanner/index: indexes medium repo correctly, respects ignore files, incremental rescan updates touched files only.
- Search: exact symbol/path queries return lexical hits; natural-language intent queries return semantic hits; hybrid outperforms either alone on fixture benchmark.
- Context builder: drag/drop + search selection produces deterministic packed context under token limits.
- Workflow generation: invalid DSL rejected; valid DSL always includes acceptance checks and tool-bound inputs.
- Execution: sequential runs produce correct state transitions, retry behavior, and persisted logs.
- E2E: `voidlink /repo` -> scan -> search -> build workflow -> run -> inspect artifacts.

## Assumptions and Defaults

- Local-first MVP: scanning/index/search/execution runs on device via Tauri + SQLite.
- OpenAI is the only provider in MVP, but adapter boundary is mandatory for later expansion.
- Hard pivot: old Notion/Terminal UX is removed from primary product flow.
- Search design follows current Cursor direction: semantic + grep/lexical hybrid and codebase indexing approach.
- External references used for search behavior target:
  - https://cursor.com/blog/semsearch
  - https://docs.cursor.com/chat/codebase
