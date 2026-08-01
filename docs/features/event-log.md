# Event log

## What it does

One durable, append-only record of things that happened across every repository
you have open: an agent turn ran, a long command finished in a terminal, a
commit appeared, a branch was switched, a rebase started and ended.

Rust owns it (`src-tauri/src/journal/mod.rs`). Records are JSON Lines in
`<app data>/journal/events.jsonl`, rotated at 4 MiB with one previous
generation kept, and retained for **six weeks** — one Basecamp cycle, which is
the longest window any planned reader looks at.

The most recent 2000 events are held in memory and answer the common query
without touching disk. A query that reaches past the ring falls back to reading
both generations, so the ring is a cache and not a horizon: a hill chart asking
for a cycle gets a cycle, not the last 2000 events.

## When you'd use it

Open the **Timeline** tab (command palette → "Open the timeline", or the `+` tab
menu). It shows one repository's events newest-first, grouped by day, filtered
by who did them.

It exists because the things that read it could not be built without it.
[Mission Control](./mission-control.md) — the Lineup, automatic check-ins, hill
charts — and the `run.*` and `trigger.*` records behind
[agent orchestration](./agent-orchestration.md) are all views over this one
table, and "what did the agent do while I was asleep" is a query against it.

The immediately useful property is that it records work done outside VoidLink's
own buttons. A commit made by `git commit` in VoidLink's terminal, by an agent,
or in another application entirely still lands in the log, because the source
for git events is the filesystem watcher rather than the UI.

## What gets recorded

| Kind | Source | Actor |
| --- | --- | --- |
| `git.commit` | watcher | `agent` or `system` |
| `git.head.moved` | watcher | `agent` or `system` |
| `git.branch.switched` | watcher | `agent` or `system` |
| `git.operation.started` / `.ended` | watcher | `agent` or `system` |
| `agent.turn.finished` / `.cancelled` / `.failed` | `commands/agent.ts` | `agent` |
| `terminal.command.finished` / `.failed` | `store/terminalWatch.ts` | `user` |
| `review.note.added` / `.resolved` / `.reopened` | `store/reviewNotes.ts` | `user` |
| `hill.scope.added` / `.finished` / `.reopened` / `.removed` | `store/hills.ts` | `user` |
| `hill.position.moved` | `store/hills.ts` | `user` |
| `run.started` / `run.adopted` | `store/fanout.ts` | `user` |
| `run.leg.finished` / `.failed` / `.cancelled` / `.discarded` | `store/fanout.ts` | `agent` |
| `trigger.fired` | `store/triggers.ts` | `system` |
| `trigger.armed` / `.disarmed` / `.rule.enabled` / `.rule.disabled` | `store/triggers.ts` | `user` |

The list grows; readers do not have to. `kind` is an open string and `summary`
is mandatory precisely so a build that has never heard of `run.leg.discarded`
still renders it — there is a test that mounts an invented kind to keep it that
way.

### The workspace field

Every event carries an optional `workspace` alongside `repo`. `repo` alone is
enough to *group* and not enough to ask a Basecamp-shaped question: "everything
on the API project" spans a main checkout and four worktrees, which are five
`repo` values and one workspace.

Rust resolves it at append time from a registry the workbench publishes
(`journal_register_repos`) whenever the workspace model changes — so a caller
that knows the repository does not also have to know which workspace owns it,
and cannot stamp one that disagrees. It is denormalised onto each event rather
than joined at read time because the join table lives in `localStorage`, and a
workspace you have since deleted still has history worth reading.

Lines written before the field existed parse as `null`. That is the same
durability contract the open `kind` string buys, and it is what let the field
land on a log that was already accumulating.

### Turns in flight are not in the log

An agent turn is recorded on its **end**, never its start: a
started-and-never-ended turn would need a reaper (the window can be shut
mid-turn), and a log with dangling open intervals is one every reader has to
special-case. The duration carries the "it was running" fact instead.

Which means the log cannot tell you what is running *now*. That question is
answered by `journal_active_agents`, which reads Rust's own in-flight registry —
the same map that attributes git events, so the two can never disagree. Turns
inside their post-exit grace window are excluded there, because "still
attributable" and "still running" are different questions.

### Who gets the credit

Git events are never attributed to *you*. The watcher saw a ref move; it does
not know whether you, a script, or another application moved it, and a guess
would become a false line in every standup that reads the log.

They **are** attributed to an agent, when one was demonstrably working in that
repository at the time. Rust registers an agent-active window for the life of a
turn's child process, and it stays open for five seconds after the child exits —
because a turn whose last act is a commit exits *before* the watcher's 250ms
debounce elapses, so closing the window on exit would miss exactly the events
worth attributing.

That credit is a heuristic over overlapping time, never an observation, and the
record says so: `data.attribution === "inferred"`, which the timeline renders as
an `inferred` chip. A reader that cannot tell a guess from a fact will
eventually act on one as the other.

`git.commit` is distinguished from `git.head.moved` by whether the new commit
lists the old one as a parent. A reset, an amend, a rebase or a force-move is
therefore never reported as a commit — reporting a `git reset` as work done is
worse than reporting nothing.

`terminal.command.finished` uses the same gate as the terminal activity badge,
and there are two of them because there are two sources.

In a shell **without** [shell integration](../../shell-integration/README.md) it
is `completionIsNews`: two consecutive busy samples with the same pid, and never
a full-screen app. Sub-second commands and quitting `vim` are not events. The
poll cannot see an exit status, so the summary says a command *finished*, never
that it succeeded.

In a shell **with** it, the shell's own `OSC 133 ; D ; <code>` is the source and
`commandIsNews` is the gate: a real C→D span of a second or more, a `D` we saw
the matching `C` for, and never a full-screen app. That path emits
`terminal.command.failed` for a non-zero status, carries `exitCode` and a real
`durationMs` in `data`, and tags `data.source: "osc133"` so a reader can tell a
measured span from the poll's `approxMs` lower bound. A shell that emits marks
takes the event over completely — the poll stands down rather than recording the
same command twice with two different kinds.

An exit status the shell did not report (a bare `D`) stays
`terminal.command.finished`. "It ended" and "it succeeded" are different claims,
and the log never makes the second one on evidence for the first.

## The record

```ts
{
  id: string;            // uuid, stamped by Rust
  at: number;            // unix millis, Rust's clock — one clock for all windows
  kind: string;          // dotted, e.g. "git.commit"
  actor: "user" | "agent" | "system";
  actorName: string | null;   // the agent's roster name
  repo: string | null;        // repository root — the cross-repo join key
  subject: string | null;     // branch, file, commit summary, question
  summary: string;            // one human-readable line, always present
  data: unknown;              // kind-specific, free to drift
}
```

Two of those fields carry design decisions worth knowing before you add a kind.

**`kind` is a string, not a union.** A build must be able to read a log written
by a build that knew kinds it does not. Narrow with `startsWith` at the point of
use; never `switch` exhaustively without a default.

**`summary` is mandatory and written at record time**, by whoever knew what
happened while they still knew. It is what makes an unknown `kind` displayable,
what a standup can be assembled from without a renderer per kind, and what keeps
a two-year-old event legible after `data` has changed shape twice. `data` is the
machine half and nothing may depend on it being well-formed.

## Recording from the frontend

```ts
import { record } from "@/store/journal";

record({ kind: "terminal.command.finished", summary: "npm finished" });
```

`record()` returns `void`, never throws and never rejects. A failed append is
warned about and dropped. That is the whole point: it can be added to an
existing handler without re-reasoning about that handler's error path.

Bursts are batched into one IPC round trip on a 250ms trailing window, flushed
on `pagehide`. `repo` defaults to the workbench's active worktree — a window
shows exactly one at a time — and a caller that passes `repo` always wins.

## Reading it

```ts
import { journalApi } from "@/api/journal";

// Every git event in one repo, most recent 50.
await journalApi.query({ repo, kinds: ["git."], limit: 50 });

// Everything the agents did since midnight, across every repo.
await journalApi.query({ actors: ["agent"], since: midnight });
```

`kinds` matches as a **prefix**, because the kinds are a dotted hierarchy and a
view almost always wants a subtree of one. Filters intersect. `limit` means the
most recent N, returned oldest-first.

`onJournalAppended` in `store/journal.ts` delivers new events to every window as
they land, carrying the batch rather than a "something changed" ping.

## Why Rust owns it

The full argument is in the module header; the short version is that three
windows write. The workbench, the editor window and the git window are separate
webviews sharing one `localStorage` origin, and appending to a shared array from
three of them is a read-modify-write race whose loser's events vanish. An
append-only log with a lost-write mode is not an append-only log.

Beyond that: only Rust sees the filesystem events, which is exactly the
"while I was asleep" case; `localStorage` is a ~5MB budget already shared with
every layout key; and Mission Control joins across repositories, which a
per-worktree blob in the layout store is the wrong shape for.

## What is deliberately not in it yet

- **Git mutations made through VoidLink's own buttons** are recorded by the
  watcher observing their effect, not by the ~40 call sites that cause them. The
  effect is what is true; instrumenting the call sites would catch only the
  quarter of cases that go through a button, and would drift the first time
  somebody added a forty-first.
- **Terminal bells and notifications.** `noteBell` knows a program asked for
  attention but not which program, and an event whose summary can only be
  "something wanted attention" is not worth a row.
- **Anything the agent read or wrote.** Turn events record which context sources
  fed the prompt (`data.sources`), not their contents — the audit trail with the
  full text stays in the thread. Copying diffs into the log would make it the
  largest file in the app inside a week.
- **Cross-repository views in the *timeline*.** The timeline still shows the
  repository its tab lives in. Joining across repos is
  [Mission Control](./mission-control.md), which now exists and reads the same
  table through `repos`/`workspace` filters.
- **Attribution for anything but agents.** A commit made by you and a commit
  made by a script both read as `system`. Distinguishing them would need to
  observe the act rather than its effect.
