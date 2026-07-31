# Agent orchestration — annotated diffs, fan-out, triggers

Three ways of putting an agent to work that are not "type into a chat box".
Annotated diffs live on the diff viewer; fan-out and triggers live in
[Mission Control](./mission-control.md).

---

## Annotated diffs

Comment on a hunk the way you would mark up someone else's pull request. The
next agent turn in that repository reads your comments **as instructions**.

Hover a hunk header in a working-tree diff → **Comment**. `Enter` submits,
`Shift+Enter` is a newline, `Escape` closes. Existing comments render under the
hunk header without hovering, with a count on the header itself — a review you
left yesterday has to be visible today.

**Resolve** stops a comment reaching the agent and keeps it. Deleting on resolve
would make "what have I already said about this file" unanswerable halfway
through a review.

### The anchor problem, stated rather than hidden

A comment is written against a hunk, and hunks are not stable objects — they are
*computed*, not stored. Edit three lines above and every header below shifts;
stage the hunk and it leaves the unstaged diff entirely. There is no id to hold.

So a note anchors on `(filePath, hunkHeader)`, and when that header is no longer
in the file's diff the note becomes **detached**: still the file's, still shown
(against the first hunk), still sent to the agent, and marked `moved` so nobody
reads it as being about the lines beneath it.

The two alternative designs both fail worse. Dropping the note silently destroys
your work. Pinning by hunk *index* re-points the note at a **different** hunk,
which is worse than losing it, because it looks correct.

Two hunks with identical `@@` lines — which generated files really do produce —
both show the note. Showing it twice is a smaller lie than picking one of two
identical anchors and pretending it was the one you meant.

### Gotchas

- **Only working-tree diffs.** The compare view diffs two refs, where a comment
  would have no working tree to land in; passing no repository is how a caller
  opts out.
- Comments are keyed by **repository path**, not worktree id — a note is about
  the code, and it is equally true whichever checkout you have open.
- They reach the agent through `assembleContext`, listed in the answer's audit
  disclosure as "Review comments" so you can see exactly what the model saw.

---

## Fan-out

One prompt, several agents, one worktree each — then read the diffs and merge
one. Mission Control → **Runs**.

Type a prompt, pick two or three agents from the roster, **Fan out**. Each leg:

1. gets a fresh branch `fanout/<prompt-slug>-<runid>/<agent>` and a worktree
   *beside* the repository (a worktree inside it is one git then tries to track);
2. runs its agent there, told to **make the change**, not describe it — that
   instruction is the whole difference between a fan-out and asking the same
   question three times;
3. is measured the same way as every other leg once it finishes.

Legs are **independent**. One failing to get a worktree, or dying mid-stream,
does not stop the others — not knowing which approach works is the entire
premise. **Stop** kills one leg's process group and leaves the rest running.

### Reading and adopting

Legs are ordered finished-first, largest-change-first. That is a **reading
order, not a ranking**: nothing here scores an answer. **Read** opens a compare
tab against the branch's merge base.

**Adopt** merges one leg's branch into the current branch. It can only happen
once per run — two competing answers to one question merged on top of each other
is painful to unpick — and it **does not touch the other worktrees**. Those
branches are somebody's four minutes of work, and removing them is an explicit
per-leg act, never a side effect of picking a winner. **Forget this run** drops
the record and leaves every worktree and branch in place.

### The limit that matters

**A run does not survive closing the window.** A leg is a child process whose
output streams over a `tauri::ipc::Channel` owned by that webview; close the
window and the channel dies with it. A run reloads as a *record*, with its legs
marked `interrupted` — in those words, because nobody chose it and nothing went
wrong.

Making fan-out outlive its window means moving the orchestration into Rust. That
is real work, not a flag. Pretending otherwise would produce the worst possible
outcome: someone believing an overnight run is progressing when nothing is
running at all.

Other limits:

- A stat that could not be taken renders as **"not measured"**, never as zero.
  Reporting "0 files changed" for the leg that did the most work would be the most
  misleading thing this surface could say.
- Runs are trimmed to the most recent 20 per repository. The durable record is
  the `run.*` events in the log.
- Nothing cleans up worktrees on its own. That is deliberate; it is also why a
  busy week leaves directories around.

---

## Triggers

"When X happens, run agent Y." Mission Control → **Triggers**.

This is the most dangerous thing in the app, so the surface is built around the
two affordances that make it safe rather than the two that make it quick.

### The kill switch

First thing on the screen, not buried in settings. Off by default; nothing
starts a process on your behalf until you say so once. It is stored under its
own one-byte key (`voidlink-triggers-armed`) rather than inside the rules blob,
so turning everything off cannot fail because the rules are large or malformed.

### Dry run

Every rule offers **try it** — replay against the last week of log and report
what *would* have fired, without running anything. The log makes this free, and
it is the only honest way to write a rule; the alternative is enabling it and
finding out. It honours the rate limit while replaying, so the number is turns
that would really have started, not matching events. More than five in a week
gets called out.

### The re-entrancy cutoff

A fired turn writes events; those events can match rules; those rules fire
turns. Four guards, because no one of them is enough:

1. A rule **never fires on an event carrying its own id** (`data.triggeredBy`),
   at any depth.
2. Nothing fires past **two generations** of lineage (`data.triggerDepth`).
3. Rules **exclude agent-caused events by default**. This is the load-bearing
   one: the git events Rust derives from the filesystem watcher *cannot* carry
   lineage — the watcher sees a ref move, not a provenance — and a cutoff that
   only works for events we happen to tag is not a cutoff. Opting in is possible
   and deliberate.
4. A **per-rule rate limit**, floor 5 seconds. Twenty files saved in one second
   is one intention, not twenty. A rule fires at most once per broadcast batch.

### Writing a rule

Pick a name, an event kind (presets: any commit, any git change, a command
finishing, a review comment), an agent, and a prompt. `{{summary}}`, `{{kind}}`,
`{{subject}}` and `{{repo}}` are filled from the event that fired it; an unknown
placeholder is left verbatim rather than blanked, so a typo is visible instead of
producing a prompt with a hole in it.

**New rules land disabled.** Enabling is a separate act.

A firing opens a real agent tab and runs the turn there. A process started on
your behalf that leaves no window behind is one you cannot read, cancel, or learn
from.

### Gotchas

- Rules are **per repository**. "Run the test agent on every commit" means
  something different in a scratch repo than in the one that deploys.
- Triggers are armed by the **workbench only**. Three windows listening to the
  same broadcast would run every firing three times.
- A rule read off disk with no kinds, or no prompt, is **dropped** rather than
  repaired — a rule with no kinds matches every event, which is the most
  dangerous shape this can take.
- A rule read off disk comes back **disabled** unless the file explicitly said
  `true`.

## Where this lives

| Piece | File |
| --- | --- |
| Review notes, anchoring, prompt block | `frontend/src/store/reviewNotes.ts` |
| The comment affordance | `frontend/src/components/git/shared/SplitDiffRenderer.tsx` |
| Runs, legs, adopt, discard | `frontend/src/store/fanout.ts` |
| Runs surface | `frontend/src/components/mission/RunsSection.tsx` |
| Rules, matching, dry run, cutoff | `frontend/src/store/triggers.ts` |
| Triggers surface | `frontend/src/components/mission/TriggersSection.tsx` |
| Runner wiring | `frontend/src/App.tsx` |
