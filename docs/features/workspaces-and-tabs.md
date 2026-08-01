# Workspaces, worktrees, panes and tabs

## What it does

Nested containers. Everything else in VoidLink hangs off one of them, and almost
every "where did my state go?" question is answered by knowing which one a thing
belongs to.

```
workspace            a folder you opened — usually a git repo
└── worktree         one checkout of that repo (the main one, plus any `git worktree add`)
    └── pane group   one tab strip and the area under it; 1–8 per worktree, in a split tree
        └── tab group   an optional named, coloured, collapsible set of tabs in that strip
            └── tab      a terminal, a compare, a stack, the commit graph, a browser page…
```

Tab groups are the one optional level. A tab in no tab group renders exactly as
it did before they existed, which is why the diagram above is still the same
model it was — with one axis added rather than one level inserted.

## The levels

### Workspace

A folder, opened from the workspace rail. It carries a name (renameable by
double-click), a repo root when the folder is a git repository, and a list of
worktrees. Workspaces persist across restarts; there is no limit on how many
you keep open, and `Mod+1` … `Mod+9` jump to the first nine.

Every workspace's header row in the rail carries three actions, hidden until you
hover it: **open folder** (the folder icon), **new worktree** (`+`) and **close
workspace** (`×`). Open folder is the way a workspace acquires — or changes — its
root, and it works on any workspace in the rail without making it active first:
cancel the dialog and nothing moves, complete it and that workspace becomes the
active one so you land in front of what you just opened. The files sidebar's
header runs the same pick for the *active* workspace, so a subdirectory pick
resolves to the same repository root from either entry point.

A workspace that is not a git repository still opens — you just get no
worktrees, no git sidebar content, and an empty state saying so.

### Worktree

One checkout. Every workspace has at least the main worktree; `git worktree
add` checkouts appear alongside it (see [worktrees](./worktrees.md)).

**The worktree is the scoping unit for essentially all tab state.** Open tabs,
pinned tabs, the active tab, pane geometry, MRU order, navigation history and
closed-tab history are all keyed by worktree id. Switch worktrees and the whole
surface changes; switch back and it is exactly as you left it.

What is *not* per worktree: the UI preferences — sidebar collapse, sidebar
widths, diff mode, git section order and collapse. Collapsing the git sidebar
in one worktree and having it spring back when you switch is the behaviour
nobody wants, so those live once, at the top of the store.

### Pane group

A tab strip and the area under it. One group is the default and looks exactly
like the workbench did before groups existed — **with a single group there is
no group header at all.**

With two or more:

- The focused group's strip takes a 2px `--primary` rule along its top; the
  others take `--border`. Same 2px either way, so focus moving between groups
  reflows nothing.
- Each strip's right edge reserves a slot for the group's aggregate activity
  mark (see [Activity and escalation](#activity-and-escalation)).

Groups live in a **recursive split tree**: any group can be split horizontally
or vertically, and the tree caps at **eight** groups. Splits, their orientation
and their flex ratios persist per worktree.

Eight is a number, not a principle. The reducer was always recursive; what sets
the ceiling is what stays usable. No pane is ever narrower than `MIN_RATIO`
(10%) of the content area, so the narrowest possible pane on a 1200px window is
120px — enough for a strip, and enough for the 24px edge zones a split drop
needs to stay hittable.

Create one by dragging a tab into the outer 20% of another group's body — the
prospective new group fills with `bg-primary/15` **at the exact geometry it
would occupy**, so you see the resulting layout before releasing. At the
cap the edge zones stop responding, take `cursor: no-drop`, and say why in the
drag ghost — quoting the cap itself, so raising it cannot leave the refusal
citing a number that is no longer true.

Drop a tab on a group's *body* (the middle 60%) to move it into that group
without splitting; drop it on a strip to place it between two specific tabs,
marked by a 2px insertion caret.

#### Why panes are not rendered inside their groups

The surface renders in two layers: the split tree draws the strips and an
*empty* measuring box per group, and every tab's actual content lives in one
flat, absolutely-positioned layer above it.

Rendering each pane inside its group would cost a DOM reparent every time a tab
moved between groups — and a reparent is a remount. xterm would lose its
scrollback and a browser pane would tear down and re-create its child webview.
Dragging a terminal into the pane beside it would wipe the output you dragged
it there to read. So the pane list stays flat and only its
`left/top/width/height` change.

### Tab group

A **named, coloured, collapsible set of tabs inside one pane group's strip**.
Optional, and orthogonal to everything above it: the pane tree answers "which
rectangle is this tab in", a tab group answers "how are that rectangle's tabs
arranged". A tab in no group renders exactly as it does without groups at all.

A group shows as a chip at the left of the strip: a colour dot, a disclosure
triangle, and the label. Double-click the label to rename it inline. Click the
chip to collapse — collapsed, it shows the member count instead of its members,
and nothing else in the strip moves.

| Want | Do |
|---|---|
| Make a group | Right-click a tab → *New tab group* |
| Rename it | Double-click the chip's label |
| Recolour it | Right-click the chip → one of the five swatches |
| Collapse / expand | Click the chip |
| Add a tab | Drag it onto the chip, or onto any tab already inside the group |
| Remove a tab | Drag it onto the strip's empty space, or right-click → *Remove from group* |
| Reorder groups | Drag one chip onto another |
| Move the whole group to another pane | Drag its chip into that pane |
| Dissolve it | Right-click the chip → *Dissolve group* |

Three rules are load-bearing:

- **A tab is in at most one group**, and a group never spans two pane groups —
  a group whose members were split across two strips would have no strip to
  render in.
- **Moving a group between panes re-claims each member through the pane
  reducer**, never by writing the pane's claim list directly, so the two models
  cannot disagree about who owns what.
- **A collapsed group is not a place activity goes to die.** A signal on a
  hidden member surfaces on the chip — the same escalation rule that carries a
  hidden pane's signal to the status bar. See
  [Activity and escalation](#activity-and-escalation).

Groups render at the left of the strip in their own order, then the ungrouped
tabs in the order they already had. Position is taken from the group list rather
than from where the first member happens to sit, because otherwise reordering
groups would be a gesture with no visible effect.

Colours come from the five `--chart-*` tokens every theme already defines. There
is no group palette.

#### Auto-grouping

A worktree can derive its groups instead of being told them, from
`Mod+K → Tab groups`:

| Mode | Groups by |
|---|---|
| `manual` (default) | nothing — you assign tabs by hand |
| `by kind` | the tab's kind, read from the tab registry |
| `by worktree` | the tab's originating worktree |

Derived groups are **read-only**, and the way that is enforced is the point:
renaming, recolouring, collapsing, dissolving or hand-editing one *materialises*
the current derivation as ordinary manual groups and drops the worktree back to
`manual`. Your edit lands, and the rule that would have undone it stops
applying. Nothing silently fights you.

Buckets of one tab are left ungrouped — a chip around a single tab is more
chrome than the tab it wraps.

**Known limit:** every workbench tab collection is keyed by worktree id, so
every tab in a worktree *is* from that worktree, and `by worktree` currently
yields one bucket. The axis only earns its keep once a pane can show another
worktree's tab.

### Tab

Ten kinds, each declared once in the tab registry (`store/layout/tabs.ts`) with
its storage key, serializer, closed-tab shape, equality function, label and
`restore()`. Adding a kind costs one spec entry.

| Kind | Window | Pinnable | Reorderable |
|---|---|---|---|
| `terminal` | workbench | no (the PTY can't be reopened) | yes |
| `compare` | workbench | yes | yes |
| `stack` | workbench | yes | yes |
| `history` (commit graph) | workbench | no (one per worktree) | no |
| `browser` | workbench | no | no (the page is a child webview keyed by tab id) |
| `file` | editor | yes | yes |
| `diff` | editor | yes | yes |
| `conflict` | editor | yes | — |
| `preview` | editor | yes | yes |

`brain` was an eleventh kind until cut C2 of the 2026-07-29 workbench audit. It
is now a
palette-invoked overlay — see [project brain](./project-brain.md) for why a surface
that reports no state does not earn a strip slot.

The workbench and the standalone editor window show different kinds out of
different state, but through the *same* `TabStrip` component: callers flatten
whatever they have into `TabDescriptor`s and the strip owns every pixel from
there down. That is why the strip takes no store — it has to look identical in
a window that can write state and one that can't.

## Navigating

| Want | Do |
|---|---|
| The tab you were just on | `Ctrl+Tab` — most-recently-used order, per group, with a held-modifier overlay listing candidates. Commits on release. |
| The tab beside this one | `Mod+Alt+←` / `→` — document order, unchanged from before |
| A specific tab in this group | `Mod+Alt+1` … `Mod+Alt+9`, `Mod+Alt+0` for the last |
| A tab by name | `Mod+Shift+E` |
| Where you just came from | `Mod+Alt+[` / `]`, or the two title-bar arrows |
| A different worktree, anywhere | The worktree switcher, with each entry's dirty / ahead / behind badges |

The MRU overlay does not animate in or out. It is held-modifier UI shown dozens
of times a session, and a 150ms fade makes `Ctrl+Tab` feel broken. Same for
jump-to-N, back/forward, zen and maximize: per the design system's frequency
gate, **anything keyboard-initiated is 0ms**.

## Focus modes

- **`Mod+Alt+M` — maximize.** The focused group fills the main area; its
  siblings are not rendered.
- **`Mod+Alt+Z` — zen.** The rail, both sidebars and every tab strip are
  hidden. The status bar stays.

Neither touches the pane tree. They are render filters, which is what makes
"restores the exact prior geometry on exit" true by construction rather than by
remembering a snapshot — nothing was changed, so there is nothing to restore.

Neither is persisted. Quitting in zen and reopening to a chromeless window with
no memory of how you got there is a trap, so the mode lasts as long as the
session that asked for it.

The way out is always visible: the status bar carries a chip naming the mode
**and its chord** (`Zen · ⌥⌘Z`), because a user who hit the chord by accident
has just lost every other affordance. Clicking the chip is the fallback, not
the affordance.

A browser tab in a hidden group **explicitly hides its webview** rather than
merely being covered — the page paints above the DOM, so nothing in the DOM can
hide it (see [embedded browser](./browser.md)).

## Activity and escalation

Tabs report what is happening in them, and a report is never allowed to be
invisible. The signal set is closed — dirty, running, finished, failed, bell,
stale — and a tab carrying several shows exactly one mark, the highest, in
precedence order `failed > running > bell > finished > dirty`.

The mark's slot is reserved at rest, so its arrival reflows nothing, and it
**replaces** the close affordance rather than sitting beside it. Hovering the
tab swaps the mark for the ×.

Escalation, in order:

1. A signal on a tab in a group you are looking at shows on the tab.
2. A signal on a tab hidden inside a **collapsed tab group** shows on that
   group's chip. Collapsing hides the tabs, so it would otherwise hide their
   marks with them.
3. A signal on a tab in a **background pane group** also shows on that group's
   header slot.
4. A signal in a pane group that is **not on screen at all** — maximized away,
   or every group under zen — shows in the **status bar**, as a
   `n hidden panes` segment carrying the mark.
5. A signal on a tab belonging to a **different worktree** shows on that
   worktree's row in the rail. Under zen, where the rail is hidden, it moves to
   a status-bar segment naming the worktrees instead.
6. In **stacked mode**, a signal belonging to a view that is not the one in
   front shows on that view's segment of the title-bar switcher
   (`Workbench | Editor | Git`). Detached mode has no step 6: the satellites
   are windows, each with its own status bar to escalate to.

The steps compose rather than replace each other: a failure on a tab inside a
collapsed group inside a maximized-away pane still reaches the status bar,
because the chip is off screen too.

So: run a failing build in a terminal in group B, focus group A, and the failure
is visible from A without opening B. Maximize A and it moves to the status bar.
Enter zen and it stays there.

**Step 5 was missing until 2026-07-31, and the failure mode was not "the mark
went to the wrong place" — it was that the mark went nowhere.** `escalate()` had
no concept of a worktree, and the pane tree it reasons over only exists for the
worktree on screen, so a signal raised anywhere else matched no group, fell out
of every branch and reached no surface at all. It went unnoticed for as long as
it did because until agents ran in several worktrees at once, nothing ever
signalled outside the one being looked at; fan-out ended that.

The active worktree never gets a rail mark. Its signals are already resolved by
steps 1–4, and a dot repeating them would be a fifth surface saying what four
already say. The view in front never gets a segment mark, for the same reason.

**Step 6 exists because a covered view hides every earlier stop at once.** A
stacked view that is not in front is `visibility: hidden` over a workbench that
stays mounted and keeps running — so its panes, its strips, its rail *and* its
status bar are all covered, and steps 1–5 have nowhere left to land. Worse, the
workbench went on reporting its front tabs as *seen*: a command that finished
while you were reading a diff in the editor view counted as watched, and raised
no mark at all. A covered workbench now sees nothing, which is what turns that
event back into a signal for step 6 to carry.

Today only the workbench raises signals — terminals, agent runs, compares and
stacks all live there — so it is the only segment that lights up in practice.
The routing is per tab, so an editor or git signal would land on its own
segment the day something raises one.

`failed` never clears on focus alone — glancing at a pane is not the same as
having read the error in it. `bell` and `finished` do clear when the tab comes
to the front.

Where the terminal's events come from:

| Event | Source | Signal |
|---|---|---|
| Bell (`BEL`) | xterm's `onBell` | `bell` |
| A foreground command started | the PTY process poll going busy | `running` |
| A foreground command ended | the poll going idle | `finished`, and only if you were looking elsewhere |
| A command ended **with a status** | `OSC 133 ; D ; <code>` from the shell | `failed` on non-zero, otherwise `finished` |

The poll is refcounted in `store/terminalWatch.ts` and shared between the tab
strip and the pane layer. It used to live in the strip; it had to move, because
zen renders no strips and a shell watched only while its strip is mounted
reports nothing exactly when you have the least chance of noticing.

### `failed`, from a command inside a live shell

The last row is [shell integration](../../shell-integration/README.md), and it
closed the oldest hole in this vocabulary. The poll can see *that* a foreground
process went away and never *how* — so `noteFinished(tabId, true)` was
hardcoded, and `failed`, the top of the precedence chain, was unreachable from
the surface you spend the most time in. A `cargo build` that failed in an open
shell raised the same mark as one that succeeded.

Only the shell knows `$?`. So it says so, in the OSC 133 semantic prompt
sequences every terminal that solved this consumes: `C` before a command runs,
`D ; <exit-code>` after. `store/semanticPrompt.ts` parses them,
`store/terminalWatch.ts` turns them into the same `noteFinished` call the poll
makes — with the truth for its `ok` argument instead of an assumption.

Three rules keep the red mark meaning something, all of them pure and tested:

* **Under a second is not news.** Unlike the poll, integration sees *every*
  command. `grep` finding nothing exits 1, and so does half of what a shell
  script does. A failure gets no easier a gate than a success here, deliberately:
  `failed` is the only signal that must be acknowledged rather than dismissed by
  looking, so a spurious one costs strictly more.
* **A `D` with no `C` is not news.** We attached mid-command and know only that
  something ended.
* **The alternate screen is not news.** `:cq` exits non-zero; leaving vim the
  deliberate way is not a build failing. Same rule the poll already had.

**One command, one source.** A shell that has proved it emits marks takes the
completion event over entirely and the poll stands down — it keeps only the job
the marks cannot do, turning `working` back off. Two sources would put a
`terminal.command.failed` *and* a `terminal.command.finished` in the log for one
build, and fire two OS banners saying opposite things.

**You have to set it up, and that is a decision rather than an omission.** VS
Code and Kitty inject their integration by pointing `ZDOTDIR` at a generated
directory. VoidLink does not: `create_pty` goes out of its way to make the
shell's environment identical to how Terminal.app spawns one, a mis-ordered
`ZDOTDIR` breaks your prompt and your plugin manager to earn a badge, and it
could not be done for fish or nushell at all. The reasoning is written where the
PTY is spawned. What the app *does* export is a marker,
`VOIDLINK_SHELL_INTEGRATION`, which is what makes the snippet a no-op in every
other terminal.

**It only ever adds.** A shell without integration behaves exactly as it did
before this existed — poll-inferred `finished`, never a claimed status. Settings
→ Terminal → Shell integration reports how many open shells are actually
emitting, which is the only honest thing that surface can say: there is no way
to ask a shell what it sourced.

**Escalation is in-app only.** For work you are not at the machine for, the
same signals also drive OS notifications — as a separate policy over the event
log, not as a second copy of this one. See
[Notifications and sound](./notifications.md).

**What remains uncovered**, now that shell integration closed the main gap: a
shell whose rc has not been set up, and any shell there is no snippet for (fish,
nushell). Both fall back to poll-inferred `finished`, which is what this app did
for everything until 2026-08-01 — a smaller silence than "`failed` is
unreachable", and one the user can end in one line.

## Layout presets

A **named arrangement**, recalled from the palette. It captures the pane tree,
the tab-group structure, each pane group's front tab and the three panel widths
— and **no tab contents at all**.

| Want | Do |
|---|---|
| Save the current arrangement | `Mod+K → Layout: save arrangement as…` |
| Recall one | `Mod+K → Layout: apply "<name>"` |
| Rename / delete one | `Mod+K → Layout: rename/delete "<name>"` |

Presets are stored per workspace and applied to the active worktree.

**This is not a snapshot.** A [snapshot](./snapshots.md) is a whole *session*:
restoring one closes every tab, reopens the ones it recorded, respawns the
terminals and restores the sidebar prefs — which is why it addresses everything
by content key. A preset opens nothing, closes nothing and spawns nothing. It
rearranges whatever happens to be open right now, which is why it addresses tabs
by id.

**It degrades, it never fails.** Apply a preset whose groups name tabs this
worktree does not have and it places the ones that exist and leaves the rest of
the geometry empty, where the pane's own empty state already says what to do
about it. An arrangement that half-fits is still an arrangement.

*Reset layout* does not delete presets, for the same reason it does not delete
snapshots: they are documents you named and saved.

## The status bar

The bar is a **registry of segments**, not a fixed row. Each segment declares an
id, a resting priority, which side of the spacer it sits on, what it renders and
what clicking it does; features contribute segments rather than editing a
component.

Two rules make it work on a narrow window:

- **A segment carrying a live activity signal jumps to the front of the
  priority order**, and returns to its resting priority when the signal
  clears. The status bar is escalation's last stop, so the one thing it must
  never do is push that signal off the end.
- **Overflow collapses lowest-priority-first into a `⋯` popover.** Text is
  never truncated to unreadability and the bar never wraps to a second line. On
  a window too narrow for even the top-priority chip, the bar overflows by a
  few pixels rather than showing nothing but a `⋯`.

Resting priorities, highest first: background activity, worktree activity, focus
mode (zen / maximized), branch, ahead/behind, dirty, stack, AI draft.

Two of those numbers are argued rather than assumed:

- **AI draft sits below the standing facts, not above them.** Drafting a commit
  message is a transient operation; ahead/behind and dirty are things that are
  *true about the repository*. A resting rank above them meant a transient
  outranked a fact for the whole life of the process. The draft segment carries
  a live signal, so the first rule above already pulls it to the front while it
  is happening — the signal does the work, and the resting rank goes last.
- **There is no workspace-count chip any more.** It had the lowest priority, so
  it was the first thing overflow collapsed into `⋯` and was almost never on
  screen; and what it reported is in the rail, which is visible everywhere
  except zen. Usually hidden and always redundant is a dead affordance.

The bar also carries an off-screen `aria-live="polite"` region announcing
escalated activity, because a badge that only exists visually is not proactive
for a screen-reader user.

## Persistence

Everything is `localStorage`, written through one debounced path in
`store/layout/persistence.ts`. No other module touches storage.

| What | Scope |
|---|---|
| Workspaces and worktrees, active workspace | global |
| Open tabs (per kind), pins, active tab | per worktree |
| Pane geometry, tab groups, MRU order, navigation history | per worktree |
| Closed-tab history | per worktree |
| Sidebar collapse/widths, diff mode, git section order and collapse | global |
| Snapshots | per workspace ([snapshots](./snapshots.md)) |
| Layout presets | per workspace |

Writes go to a temp key and are then committed, and a corrupt or
partially-written blob degrades **that one key** to defaults with a toast —
never a white screen. Settings → UI → *Reset layout* clears tabs, panes and panel
widths without touching settings, provider keys or saved snapshots.

Every tab kind restores on boot. Terminals come back as a **fresh PTY** in the
saved cwd under the saved label, and the UI says so rather than implying
scrollback survived: the tab's tooltip reads
`new shell in <cwd>; scrollback was not restored`.

## Density

`Settings → UI → Spacing` (Compact / Normal / Comfortable) sets
`data-density` on `<html>`, and every row-shaped surface opts in through
`.density-row` / `.density-section` / `.density-gap`.

Four surfaces are deliberately excluded:

- the **tab strip** and the git sidebar's **column headers** (`h-9`, load-bearing
  cross-column alignment),
- the **status bar** (`h-6`),
- the **file tree's** rows and the git sidebar's **virtualized change rows**
  (fixed 24px) — the height *is* the virtualizer's `estimateSize`, and a height
  that moves with a setting desyncs the estimate from reality.

## Gotchas and limits

- **Eight pane groups is the cap.** A free-form grid is still a different
  feature.
- **Tab groups live inside one pane group.** There is no group that spans two
  panes, because there would be no strip to draw it in.
- **Pane geometry is per worktree, not per window.** Two windows on the same
  worktree do not sync their splits.
- **Activity is session state and is never persisted.** A bell that rang
  yesterday is not news today.
- **Zen and maximize are per window and not persisted**, deliberately.
- **The editor window has no groups.** It renders the same strip with none of
  the group props, which is exactly the pre-groups behaviour.
- **A tab opened while a background group has focus lands in that group.**
  Without that rule every new terminal would fall into the first group, because
  an unclaimed tab falls there by definition — which would make splitting a
  one-way trip.

## See also

- [Keyboard shortcuts](./keyboard-shortcuts.md) — the full keymap
- [Workspace snapshots](./snapshots.md) — saving and restoring a whole session
  (a different thing from a layout preset, above)
- [Terminal](./terminal.md), [Embedded browser](./browser.md),
  [Branch compare](./branch-compare.md) — what individual tab kinds do
