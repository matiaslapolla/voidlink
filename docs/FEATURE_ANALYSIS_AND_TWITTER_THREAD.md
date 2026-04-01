# VoidLink: Current Feature Analysis + Twitter Thread Draft

Current state (code-level) is a **workspace-first repo intelligence app**; `main.tsx` mounts only `App.tsx`, and `App.tsx` drives the active UX.

- `frontend/src/main.tsx`
- `frontend/src/App.tsx`

## What users can do right now

- Create/delete/rename multiple workspaces, with persisted state in localStorage.
- Pick a repo, scan it, and see live scan counters/status/error banner.
- Run hybrid search (lexical + semantic + graph proximity), add snippets to context, track estimated tokens.
- Generate a workflow DSL and execute it with run-step events/retries; artifact files are written under `.voidlink/artifacts/<run_id>/...`.
- Use Git area: status diff viewer, AI diff explanations, branch list/switch/create, worktree create/delete, PR dashboard, PR review checklist, merge controls, audit timeline, AI agent task runner.
- Bottom Git status bar auto-refreshes branch/dirty state and opens branch picker.
- Settings for opacity + vibrancy effect.

## Implemented but not currently exposed in the mounted UI

- Terminal + Notion editor modules exist, but are not wired from current `App.tsx` shell.
- Git backend supports `file_status`, `log`, `stage`, `commit`, `push`, `diff_commit`, but current frontend does not expose those actions.
- Worktree “open terminal” button is present but `App.tsx` does not pass `onOpenTerminal`, so it no-ops now.

## Twitter thread (ready to post)

1. Built a local-first desktop copilot for real repos: scan -> search -> context -> workflow -> execute. No cloud index required.
Screenshot: workspace + scan header + progress counters.

2. Search is hybrid by design: lexical + semantic + graph proximity. You can see each score per snippet.
Screenshot: Repository tab search results with lexical | semantic | graph.

3. Context Builder turns raw snippets into actionable objective + constraints before any generation.
Screenshot: Context Builder panel with selected snippets/tokens/objective.

4. Workflow generation outputs explicit steps/tools/checks, then runs with event logs and retries.
Screenshot: Workflow tab showing steps + run log.

5. Git view is first-class: diff explorer, branch/worktree management, AI diff explanations.
Screenshot: Git > Diff + AI Explanations panel.

6. Autonomous agent flow: creates branch/worktree, applies changes, commits, pushes, opens draft PR, streams events live.
Screenshot: AI Agent panel with event stream + PR link.

7. PR review has AI checklist + human controls + merge policy gates + audit trail.
Screenshot: PR Review tab + Merge controls + Audit tab.

8. Everything is local and hackable. Core stack: Tauri + Rust + SolidJS + SQLite.
Code:

```rust
candidate.result.score =
  ((candidate.result.lexical_score * 0.65) + (semantic_score * 0.35)).clamp(0.0, 1.0);
candidate.result.score = (candidate.result.score + proximity_boost).clamp(0.0, 1.0);
```

Optional extra code tweet:

```rust
// agent pipeline: branch -> worktree -> implement -> commit -> push -> PR
set_step!("generating implementation");
// ...
set_step!("committing changes");
// ...
set_step!("creating pull request");
```
