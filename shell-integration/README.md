# Shell integration

Two files that make one signal reachable: **`failed`, from a command that failed
inside a live shell.**

## The problem they solve

VoidLink watches a terminal by polling its PTY for the foreground process. That
observable answers "is something running" and cannot answer "how did it end" —
the poll sees a process vanish, and vanishing carries no status. So a
`cargo build` that failed in an open shell raised `finished`, the same mark as
one that succeeded, and `failed` — the top of the activity precedence chain, the
only signal that must be *acknowledged* rather than dismissed by looking — was
unreachable from the surface you spend the most time in.

Only the shell knows `$?`. These snippets are how it tells us.

## Setup

Add one line to the end of your rc file:

```zsh
# ~/.zshrc
source /path/to/voidlink/shell-integration/voidlink.zsh
```

```bash
# ~/.bashrc
source /path/to/voidlink/shell-integration/voidlink.bash
```

Open a new terminal in VoidLink. **Settings → Terminal → Shell integration**
says whether any live shell is actually emitting — it reports what was observed,
not what was configured, because there is no way to ask a shell what it sourced.

## What it does, and what it does not

It installs `precmd`/`preexec` hooks (zsh) or a `PROMPT_COMMAND` + `DEBUG` trap
(bash) that print [OSC 133 semantic prompt
sequences](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/prompts.md)
— the same ones iTerm2, VS Code, WezTerm and kitty consume:

| Sequence | Meaning | Used by VoidLink |
| --- | --- | --- |
| `OSC 133 ; A ST` | a prompt is about to be drawn | as evidence integration is live |
| `OSC 133 ; B ST` | prompt drawn, command line follows | parsed, never emitted — see below |
| `OSC 133 ; C ST` | a command is about to run | starts the span |
| `OSC 133 ; D ; <code> ST` | it ended, with this status | **the exit status** |

It does **not** touch `PS1`, `PATH`, or anything else you own, and it is a no-op
in every terminal that is not VoidLink — guarded on `VOIDLINK_SHELL_INTEGRATION`,
which the app exports when it spawns the PTY.

`B` is deliberately not emitted. The only place to put it is inside `PS1`, which
belongs to your prompt framework; powerlevel10k, starship and oh-my-zsh all
rebuild it on their own schedule, so the append is either clobbered or
duplicated. VoidLink reads only `C` and `D`, so the one sequence that carries
that risk buys nothing.

## Why you have to source it yourself

VS Code and Kitty inject their integration automatically, by pointing `ZDOTDIR`
at a generated directory that re-sources your real config. VoidLink does not,
and the reasoning is written down where the PTY is spawned
(`src-tauri/src/lib.rs`, `create_pty`). In short: that code goes out of its way
to make the shell's environment identical to how Terminal.app spawns one, a
mis-ordered `ZDOTDIR` breaks your prompt and your plugin manager to earn a
badge, and it could not be done for fish or nushell at all — so "automatic"
would have meant "automatic for two shells, silent for the rest".

## If you do not set it up

Nothing changes and nothing degrades. The poll keeps reporting `finished` for a
command it watched go idle, exactly as it did before this existed, and never
claims a status nobody gave it. Shell integration only ever *adds* a signal.

## Other shells

fish, nushell and friends are not covered. Both files above are ~40 lines of
prompt-hook plumbing around four `printf`s; the sequences are a published
standard and porting one is small. VoidLink's parser does not care which shell
emitted them.
