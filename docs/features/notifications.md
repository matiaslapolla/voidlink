# Notifications and sound

OS banners and sound cues, dispatched by Rust as a **policy over the event log**.

## What it does

When something finishes, fails, or needs you while you are not looking, VoidLink
tells the operating system. That is the whole feature, and it exists because
Track B changed the premise of the app: one prompt now runs N agents in N
worktrees, and the entire value of that is that you are *not* watching.

## When you'd reach for it

You don't reach for it. There is no "notify me about this" button anywhere, and
adding one would be a bug. See below.

## The one structural decision

**Rust dispatches. Not the webviews.**

Three windows share one origin. Three webviews reacting to one
`journal-appended` broadcast produce three OS banners for one commit. Rust holds
the log, Rust knows which windows have focus, and Rust is the only place where
"notify once" is even expressible.

The consequence is worth stating plainly, because it is what makes the feature
maintainable: **no feature calls `notify()`**. The notifier subscribes to
`journal::append` and decides. A new feature that records an event gets
notifications for free, and cannot forget to — there is nothing to remember.

This is also why none of the three capability files
(`default.json`, `editor-window.json`, `git-window.json`) grants a
`notification:*` permission. That absence *is* the enforcement, and each file
says so in its `description`.

## The four rules

All four are pure functions of `(event, state, config)` in
`src-tauri/src/notify/mod.rs`, with unit tests beside them. The interesting
failures here are all "it notified when it shouldn't have", and those are only
cheap to test when the decision needs no windowing system.

### 1. Match, by prefix

Rules are `kind` **prefixes**, matched with `starts_with`, and the **longest
match wins** — so `agent.turn.failed` overrides `agent.` regardless of where
either sits in the list. A matrix whose behaviour changes when you reorder rows
is one nobody can reason about.

Prefixes rather than an enumeration for the same reason the timeline renders
`summary` and never switches on `kind`: Track B keeps adding families (`run.`,
`review.`, `hill.`), and a closed set would silently stop covering them.

### 2. Suppress what you are already watching

A banner for something on screen in a focused window is noise. The frontend
publishes what is visible through `notify_visible`, fed from the *same* effect
that drives activity escalation — two notions of "visible" that can disagree is
how you get an event suppressed in one place and shown in the other.

"On screen" and "being looked at" are different: a window you have alt-tabbed
away from suppresses nothing, which is the case the whole escalation model
exists for. In stacked mode a *covered view* is the same case one level down —
the workbench stays mounted under the editor or git view, so it is on screen in
every sense the DOM knows about and in none the user does. It reports nothing
visible while it is covered, which is what lets a banner through for a command
that finished behind another view.

### 3. Coalesce

Five events inside the window (2s by default) are one notification, and the body
says how many it stands for. Keyed on (kind **family**, repo), because a burst is
usually one operation producing neighbouring kinds — four `run.leg.finished` and
one `run.finished` is one piece of news.

Nothing is dropped silently. The swallowed count is carried into the next
notification's body.

### 4. Quiet hours and mute

Both plain config. Mute is first on the settings screen and unmissable: the
control that stops the interruptions must not be something you go looking for.

## The defaults, and the one deliberate omission

| Event | Level |
| --- | --- |
| `agent.turn.failed` | Banner + sound |
| `agent.turn.finished` | Banner |
| `run.leg.failed` | Banner + sound |
| `run.finished` | Banner |
| `trigger.fired` | Sound |
| `git.conflict` | Banner + sound |
| `git.operation` | Banner |
| `terminal.command.failed` | Banner + sound |

**Commits are absent on purpose.** A notification per commit is how a person
turns notifications off entirely — and then misses the agent that failed
overnight, which is the reason this feature exists. Everything in the default set
is either an unattended outcome or a state you have to resolve before work
continues.

## Sound

Semantic cues, never filenames: `sound::play(pack, Cue::TurnFinished, volume)`.
A call site naming a `.wav` is a call site with an opinion about the theme.

| Cue | Raised by | What it is |
| --- | --- | --- |
| `TurnFinished` | `*.finished` | Rising major third — resolved, quiet, unremarkable |
| `TurnFailed` | `*.failed` | Falling minor second — unresolved, but not louder |
| `Attention` | anything else | One note. The most-played cue, so the least eventful |
| `Conflict` | any kind containing `conflict` | Two low notes a tritone apart |
| `RunAdopted` | `run.adopted` | A major arpeggio. The one moment worth a small fanfare |

An unknown kind still makes a noise (`Attention`) rather than being silent —
same forward-compatibility argument as rule 1.

Two packs ship: `default` and `silent`. Silent is an empty map, not a directory
of silent files, so it cannot drift out of sync when a cue is added. An unknown
pack name falls back to `default` rather than to silence: a typo in a settings
file should not quietly disable a feature.

Assets are generated by `src-tauri/tools/gen-sounds.py` and are original to this
repository — provenance is recorded in `src-tauri/resources/sounds/LICENSE.md`,
because a bundled sound with an unclear origin is a shipping problem, not a
nicety.

## Permission

Requested **lazily**, the first time a rule would actually fire. Never at launch:
a permission prompt before you have done anything that could produce a
notification is a prompt with no context, and the honest answer to it is "no".

If it is denied, we degrade to the in-app activity mark and never ask again this
session.

## Settings

**Settings → Notifications.** One screen: the mute switch, the matrix, the sound
pack and volume with a Test button, quiet hours, and the coalescing window.

The matrix is rows of event-kind prefixes × {Off, Sound, Banner, Both}. It stays
the same size as the app grows, because a new family either fits an existing
prefix or is one row you can add.

## Gotchas and limits

- **Quiet hours are UTC**, not local. Converting properly means a timezone
  dependency for one integer, and that trade has not been made. The settings
  screen says so rather than letting you find out at 22:00.
- **Do Not Disturb is honoured for banners, not for cues.** A banner's sound is
  the platform's, so Focus modes apply for free. There is no cross-platform way
  to read the OS focus state from Rust without another dependency per platform,
  so the `rodio` path cannot check it. This is the strongest argument for routing
  anything user-visible through the banner channel; quiet hours are the in-app
  substitute.
- **A cue is never played on top of a banner.** `Both` means banner + cue only
  for rows where the platform would not already make a sound; the dispatcher
  plays ours only when there is no banner. Doubling the sound would also mean
  ignoring Do Not Disturb for half of it.
- **No audio device is not an error.** A headless session logs once and disables
  cues; the banner and the in-app mark still work.
- **Suppression is per repository, not per tab.** An event carries a repo, so
  having *any* tab of that repo on screen in a focused window suppresses the
  banner. Watching a terminal in a repo while an agent works on it in another
  pane will suppress that agent's banner.
- **The audio device is opened once and kept.** Opening per cue costs tens of
  milliseconds on macOS and briefly takes audio focus, which is audible as a
  stutter in whatever else is playing.

## Related

- [Event log](./event-log.md) — the record everything here is a policy over
- [Agent orchestration](./agent-orchestration.md) — fan-out and triggers, the
  reason this exists
- [Workspaces, worktrees, panes and tabs](./workspaces-and-tabs.md) — in-app
  activity escalation, which is the channel this degrades to
