# Mission Control

One tab, five sections, all of them views over the event log. `Mod+K` →
**Open Mission Control**, or the `+` menu on the tab strip.

It is the first surface in the app that is **not scoped to the active
worktree**. The Lineup and the check-in span every workspace you have, open or
not. That is the gap it exists to close: nothing here could previously answer
*what is happening across all my work* — the worktree rail answers it for the
workspace you were already looking at, which is the one case you did not need
help with.

## Why one tab and not five

They are answers to one question separated by time horizon. The Lineup is now,
the check-in is the last day or week, Hills are the cycle, Runs are work you
started deliberately, and Triggers are the same question asked in advance. Five
singleton tab kinds would be five palette entries, five rows in every snapshot,
and a decision to make before you know which one answers your question.

Only the selected section is mounted. Each one polls or subscribes, and three
live subscriptions where you can read one is a cost that never shows up until
somebody profiles it.

---

## The Lineup

One row per checkout, grouped by workspace, busiest first.

Three sources feed a row and they differ in kind:

| Source | What it says | Freshness |
| --- | --- | --- |
| The repository registry | Which checkouts exist | Published by the workbench on every workspace change |
| The event log | What last happened here | Durable, possibly weeks old |
| `journal_active_agents` | What is happening **right now** | Polled every 4s |

That third row is the subtle one. Agent turns are recorded on their *end* —
see the comment at `recordTurn` in `frontend/src/commands/agent.ts` — so the log
has no open intervals to read and cannot tell you a turn is in flight. Liveness
therefore comes from Rust's own in-flight registry, the same map that attributes
git events, so Mission Control and the attribution can never disagree about who
is working where.

**Ordering is the surface.** Busy workspaces first, whatever they are called;
inside a workspace, busy checkouts, then the main checkout, then most recently
active. A busy workspace scrolled below the fold is the one failure this view
exists to prevent.

Clicking a row selects that worktree — switching workspaces if needed.

### Gotchas

- **A checkout with no history still gets a row.** "Nothing recorded" is an
  answer; a missing row reads as a missing worktree.
- **Events from a repository that is no longer registered are dropped here.**
  They stay in the timeline. Synthesising a Lineup row for a directory nobody has
  open would invite a click that goes nowhere.
- **Counts are for the last 24 hours**, not for all time. "3 commits ever" is
  trivia.
- The registry is published by the **workbench only**. The editor and git
  windows see a narrower model, and letting them publish would mean the
  satellites racing to overwrite it.

---

## The check-in

What happened, in a window, across every repository — grouped by repo, then by
who did it.

Windows are **Today**, **Since yesterday**, **Last 7 days** and **This cycle**
(six weeks). Nothing longer is offered, because the log retains six weeks and a
window longer than retention returns a partial answer that looks complete.

The day windows snap to local midnight rather than subtracting 24 hours: "today"
at 9am must not mean "since 9am yesterday", which would file last night's work
under today.

**It reports, it does not summarise.** Every line is a count of recorded things,
and every commit subject is quoted verbatim — a check-in that paraphrased what
was committed would be inventing history. **Copy** puts the whole thing on the
clipboard as Markdown, which is the intended path to a standup, an issue
comment, or an agent that you have explicitly asked to summarise it.

Two agents in one repository stay two lines. Collapsing them would report "the
agent made 9 commits" when two agents made 4 and 5 — which is exactly the
question a per-agent audit trail exists to answer.

### Gotchas

- **Unknown event kinds land in "other events"** rather than being dropped, so
  the totals keep adding up as new kinds appear.
- **Events with no repository** are grouped under "Elsewhere". A total that
  disagreed with the timeline's for the same window would read as a bug in one of
  the two surfaces.
- "Nothing was recorded in this window" is an answer, and says so.

---

## Runs — fan-out

One prompt, N agents, N worktrees, N diffs to compare. See
[agent orchestration](./agent-orchestration.md).

---

## Triggers

"When X happens, run agent Y." See
[agent orchestration](./agent-orchestration.md).

---

## Hill charts

A named piece of work with a position on a curve. Left half is *figuring it
out*; right half is *making it happen*; the crest is the moment nothing is left
to discover.

Every other progress indicator in this app is binary — running or not, dirty or
not, ahead or behind. None of them can express the difference between "two days
in and I still do not know how this works" and "I know exactly what to do and
there are four hours of typing left". Those look identical on a percentage bar
and are opposite in every way that affects a decision.

**The dot is moved by hand, and this is not a limitation.** It is the one number
here that cannot be derived. Commits, diffs and turn counts measure activity, and
activity is exactly what a hill chart refuses to measure — a day spent reading
code and moving nothing is often the day that gets you over the crest. Inferring
the position from the log would rebuild the percentage bar the hill replaces.

Every move is still **recorded** (`hill.position.moved`), so the history is
durable and a check-in can say a scope went over the crest last Tuesday.
Judgement is the input; the record is automatic.

- **Drag the dot, or focus it and use the arrow keys** (`Home`/`End` jump to the
  ends). It is a real ARIA slider — a hill you can only move by dragging is a
  hill a keyboard or trackpad user cannot move, and "cannot record progress" is a
  worse failure than a chart that looks wrong.
- **Scopes are per workspace**, not per worktree. A scope routinely spans a main
  checkout and a worktree; keying it by checkout would show one piece of work as
  two dots that disagree.
- **Finishing does not move the dot to the end.** Where the work actually was
  when it shipped is information.
- A scope nobody has moved in a day or more is marked `Nd still`. That mark is
  the point: it is how "we are stuck" becomes visible without anyone having to say
  it out loud.
- The list sorts **uphill first**, not most-complete-first. The work that needs
  attention is the work still being figured out.

### Limits

- Positions live in `localStorage` (`voidlink-hills`) and are workbench-only.
  Losing that key costs the dots but not the recorded history of how they moved.
- There is no hill *chart over time* yet — the events to draw one exist, but
  nothing plots them.
- Nothing proposes a move. Agent-proposed positions are an idea, not a feature.

## Where this lives

| Piece | File |
| --- | --- |
| Shell and section switch | `frontend/src/components/mission/MissionSurface.tsx` |
| Lineup rows and ordering | `frontend/src/components/mission/lineupModel.ts` |
| Check-in digest and prose | `frontend/src/components/mission/checkinModel.ts` |
| Hill maths | `frontend/src/components/mission/hillModel.ts` |
| Hill state and recording | `frontend/src/store/hills.ts` |
| Live agents, registry | `src-tauri/src/journal/mod.rs` |
