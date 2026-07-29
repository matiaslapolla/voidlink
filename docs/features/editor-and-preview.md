# Editor and markdown preview

## What it does

A Monaco editor instance hosting every open file tab, plus a separate
markdown preview tab kind that renders a `.md` file to sanitised HTML.

Monaco is **bundled**, not loaded from a CDN — `editorController.ts` does a
dynamic `import("monaco-editor")` that Vite resolves into a `vendor-monaco`
chunk. Language workers (`json`, `css`, `html`, `typescript`, and the generic
editor worker) are wired through `window.MonacoEnvironment.getWorker` before
that import runs.

There is exactly **one** editor instance. It is mounted at app start and hidden
with `display: none` rather than unmounted, so opening your first file doesn't
pay Monaco's init cost.

## When you'd use it

For reading and light editing next to the git suite, with as much language
intelligence as your machine already has installed. If `rust-analyzer` or
`typescript-language-server` is on your `PATH`, VoidLink starts it and you get
completions, hover, signature help, go-to-definition, references, real symbols,
diagnostics and formatting. If neither is installed, none of that appears and
nothing breaks — no error, no blocked editor, and no status chip. Formatting
then falls back to whatever Monaco's bundled workers provide
(TypeScript/JavaScript, JSON, CSS, HTML), and for every other language
`Format document` stays a no-op.

It is still not a full IDE: there is no debugger, no rename, no refactoring, no
quick fixes and no extension API.

## How to use it

### Editing

1. Open a file from the file tree, the file finder (`Mod+P`), or a
   `path:line` link in a terminal. The tree hides gitignored files by default;
   the `Ignored` toggle above it lists them, dimmed, so a repo's `.env` can be
   edited. (`.git` is never listed either way.)
2. Edit. A dirty tab shows a small filled dot in the tab strip. The dot pulses
   while a write is in flight and clears when it lands — including under
   autosave, which never hides it.
3. `Mod+S` saves. Writes go through an atomic temp-file-plus-rename on the Rust
   side. A failed write leaves the tab dirty and raises a toast with `Retry`.

Save can also run format-on-save, trailing-whitespace trimming and
final-newline insertion, in that order, and can fire on a delay or on blur
instead of only on `Mod+S`. All four are off by default — see Settings below.

### Splitting the view

The editor area holds one or two groups. `Mod+Alt+\` (or the columns button in
the header, or `Split editor right` / `Split editor down` in `Mod+K`) opens a
second group beside or below the first, showing whatever the first was showing;
`Close the other editor group` returns to one. The seam drags, nudges with the
arrow keys when focused, and double-clicks back to an even split.

The two groups share one buffer per file — editing on the left updates the right
— and only the focused group follows the tab strip. The split is local to the
window; the tab list is still owned by the workbench.

### Breadcrumbs and go-to-symbol

Above each group is a breadcrumb row: the file's path relative to the repository
root, then the chain of symbols the cursor is inside. Clicking a symbol jumps to
it; clicking the file name opens the symbol picker (`Mod+Shift+O`), which lists
every symbol in the file with fuzzy filtering.

Symbols come from Monaco's document-symbol contract. A running language server
is preferred automatically; without one, VoidLink falls back to its own
regex-and-indentation outline for TypeScript, JavaScript, Rust, Go, Python and
Markdown, and other languages show the path and nothing after it. The fallback
parser is deliberately approximate — a symbol's range ends where the next
same-or-shallower one begins — and a server that answers with symbols replaces
it for that language without either knowing about the other. A server that is
still indexing answers with nothing, and the regex outline covers the gap
rather than the breadcrumb emptying itself for ten seconds on every file open.

### The status bar

Along the bottom of the editor window: the Vim mode when Vim mode is on, then
the language, the cursor position (click it for go-to-line), the indentation,
the line endings and the encoding — all describing whichever editor group has
focus. `UTF-8` is a statement of fact rather than a detected value; VoidLink
reads and writes UTF-8 and nothing else.

The right edge is reserved for the language server. It has five states — absent,
starting, ready, degraded, stopped — and *absent means absent*: with no server
installed, there is no segment, not a permanent grey warning. A stopped server
shows a `--destructive` LED that persists until you click it to restart, because
a crash is not something a focus change should clear. Clicking a healthy
segment opens that server's output log — its stderr, plus the absolute path of
the binary that produced it, which is the first thing worth knowing when
completions look wrong.

The segment reports on the server for the file in front, not on every server
running: opening a `.ts` tab next to a `.rs` one swaps which server the chip
describes.

### Session restore

Cursor position, scroll offset and folded regions are remembered per file and
restored when you reopen it, via Monaco's own view state. Storage is
localStorage, per repository, capped at the 200 most recently touched files, and
any corruption degrades to "the file opens at line 1".

### Finding across files

`Mod+Alt+F` opens the search panel in the left rail (⌘⇧F is already git fetch).
Traversal is gitignore-aware by default, using the same `ignore`-crate walk as
the file tree, with an `Ignored` toggle for the same escape hatch. Matching is
plain substring with optional case-sensitivity and whole-word — not regex.

Results stream in as the walk runs rather than appearing at the end, and the
match count updates live. Starting a new query cancels the in-flight one, and
the superseded walk's results never render. When the result cap is reached the
panel says so with the real number and offers to keep going. Binary and
non-UTF-8 files are skipped; files over 4 MB are skipped.

`Replace with` + `All` rewrites every match on disk. A match whose recorded
position no longer holds the searched text is skipped rather than replaced —
the file may have changed since the walk — and the count of skips is reported.

### External changes

Open files are re-stat'd when the window regains focus and after every git ref
change. A clean buffer reloads from disk silently, keeping its scroll position,
and its tab wears a green mark until you next look at it. A buffer with unsaved
edits is left alone and gets an inline bar above the editor —
`Keep mine` / `Take theirs` / `Show diff` — per buffer, never a modal. A
checkout touching 200 files produces 200 silent reloads and no interruptions.

### Settings

`Settings → Editor` configures the editor surface across thirteen sections:
font, indentation, wrapping, display, scrolling, folding, cursor, suggestions,
highlighting, editing, save, keybindings and language servers. It has a search
box, a `Modified (n)` filter, a per-setting reset, per-language overrides and a
JSON view — see [settings](./settings.md#editor) for all of it.

Every setting applies to the running editor — there is no "restart to apply"
row. The diff and merge panes read the same settings, so all three surfaces
share one typeface and rhythm.

**Per-language overrides** are keyed by Monaco language id: `[rust]
editor.tabSize = 4` makes Rust buffers use four-space tabs while a TypeScript
buffer beside them keeps two. They resolve in exactly two places —
`editorController.applyEditorSettings` for the file tabs and
`useEditorOptionsSync` for the diff and merge panes — which is what keeps the
"applies live" rule enforceable. A buffer whose language changes re-resolves
without being closed.

**Indentation detection** (`editor.detectIndentation`, on by default) guesses
tab size and spaces-vs-tabs from the file's own contents when it opens, and is
re-run on every open buffer when the setting changes — Monaco only applies it at
model creation, so VoidLink calls `model.detectIndentation` itself.

**Vim mode** is off by default and loads `monaco-vim` on demand, so leaving it
off costs nothing. With it on, the current mode (`NORMAL`, `INSERT`,
`VISUAL LINE`…) shows in the editor window's title bar.

**Theming.** Monaco runs on `voidlink-dark` / `voidlink-light`, derived at
runtime from VoidLink's own CSS custom properties rather than from stock
`vs` / `vs-dark`. All ten themes work with two theme definitions, because
switching theme re-reads the tokens and redefines them.

### Previewing markdown

1. Open a `.md`, `.markdown`, `.mdown`, `.mkdn`, or `.mkd` file.
2. An eye button appears in the tab bar — `Preview markdown`.
3. Click it. A separate preview tab opens, labelled `previewing <filename>`.

The preview attaches to the **in-memory Monaco model** when one exists, so it
re-renders on every keystroke and shows unsaved edits. If the file isn't open in
the editor, it reads once from disk and then polls every 500 ms until a model
appears.

Preview tabs are deduplicated by file path — asking to preview the same file
twice re-activates the existing tab.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+P` | Open a file |
| `Mod+Alt+N` | New file (not `Mod+N` — that makes a workspace) |
| `Mod+S` | Save the active file |
| `Mod+W` | Close the active tab |
| `Mod+Alt+→` / `Mod+Alt+←` | Cycle tabs |
| `Mod+Alt+B` | Toggle [inline blame](./blame.md) |
| `Mod+Shift+D` | Toggle inline / split diff (affects diff panes, not the editor) |
| `Mod+Shift+I` | Format document |
| `Mod+Alt+F` | Find in files |
| `Mod+Shift+O` | Go to symbol in the active file |
| `Mod+Alt+\` | Split the editor side by side |

Fifteen editing commands — format, duplicate/move line, toggle comment,
transform case, sort lines, jump to matching bracket, and the three
multi-cursor commands — are registered as VoidLink actions, so `Mod+K` finds
them by name and they appear in Monaco's right-click menu. Each one delegates
to the Monaco built-in rather than reimplementing it, so Monaco's own chords
keep working unchanged: `Mod+F` find, `Mod+Alt+F` replace, `Mod+D`
add-selection-to-next-match, `Mod+/` toggle comment, `Alt+↑`/`Alt+↓` move line,
and `F1` quick command all behave as shipped. Only `Format document` takes a
global chord; binding the rest would shadow Monaco's with identical behaviour
and take the key away from the terminal for nothing.

## Language detection

Extension lookup only, falling back to `plaintext`. A few mappings worth
knowing:

| Extension | Language |
|---|---|
| `.tsx` | typescript |
| `.jsx` | javascript |
| `.svg` | xml |
| `.h`, `.hpp` | cpp |
| `.toml` | ini (Monaco has no TOML tokenizer) |

There is no shebang sniffing and no filename matching, so `Dockerfile`,
`Makefile`, `.gitignore`, and any extensionless file open as plain text.

## Markdown pipeline

```ts
const raw = marked.parse(source, { async: false, breaks: false, gfm: true });
return DOMPurify.sanitize(raw);
```

That is the entire pipeline. GFM is on, hard line breaks are off, and the output
is sanitised before it reaches `innerHTML`. No syntax highlighting in fenced
blocks, no mermaid, no math, and no relative-image resolution.

## Gotchas and limits

- **Closing a dirty tab discards the changes with no prompt.** Tab close,
  middle-click close, and close-all-unpinned all dispose the model immediately.
- **Files over 2 MB refuse to open.** The Rust reader returns
  `File too large to open (N bytes > 2 MB)`.
- **Binary and non-UTF-8 files fail to read.** The backend uses
  `read_to_string`.
- **A failed read looks like an empty file.** `openFile` catches the error,
  logs a warning to the console, and creates the model with empty content — so
  saving that tab would truncate the real file. There is no guard.
- **External changes are polled, not watched.** Detection happens on window
  focus and on git ref changes, not the instant a file is written. A watcher
  would mean a new dependency and an OS handle per open file for information
  only ever acted on at those two moments.
- **A deleted file leaves its buffer as it was.** Truncating an open tab
  because the file vanished loses more than it fixes.
- **Autosave is off by default.** With it off, `Mod+S` is the only way to
  write — there is no save button.
- **Format-on-save needs a provider.** A language server supplies one; without
  one (and outside the languages Monaco's own workers cover) it silently does
  nothing, which is the intended degradation, not a failure.
- **Dirty tracking is debounced 100 ms** and only clears on a successful save.
- **Two editor groups maximum, and no scroll sync** between a file and its
  preview — preview is a sibling full-width tab, not a pane.
- **Directory segments in the breadcrumb are labels, not buttons.** This window
  has no folder view to navigate to, so there is nothing for them to do yet.
- **The fallback outline is regex-based.** With no language server for the
  language it misses declarations split across lines and does not understand
  macros. A running server replaces it.
- **Language servers are yours, not ours.** Nothing is bundled or downloaded.
  Two are supported — `rust-analyzer` for `.rs` and `typescript-language-server`
  for TS/JS — found on `PATH` or pointed at explicitly in Settings → Editor →
  Language servers. `PATH` is augmented with the usual install directories
  (`~/.cargo/bin`, `~/.local/bin`, Homebrew, a few version managers) because a
  Finder-launched macOS app inherits almost none of your shell's.
- **Adding a third server is a code change**, not a config file. There is no
  plugin API and none is planned.
- **Document sync is full-text, debounced 250 ms.** Every edit sends the whole
  buffer rather than a range diff — simpler and impossible to desynchronise,
  but it would matter on a very large file.
- **A crashed server restarts up to five times** with a backoff, and toasts once
  at three consecutive crashes, never on each cycle. Past that the status chip
  stays `stopped` until you click it. The editor is never affected: a dead
  server just means every provider answers "nothing".
- **The bridge implements eight features and declines the rest.** Completion,
  hover, signature help, definition, references, document symbols, diagnostics
  and formatting. No rename, no code actions, no inlay hints, no semantic
  tokens, no call hierarchy — and no `workspace/applyEdit`, so a server can
  never write a file you did not ask it to.
- **`Go to definition` across files goes through the command palette.** Monaco's
  own F12 can only navigate inside a file that is already open, because this
  window does not own the tab list; the palette entry asks the server and opens
  the target through the workbench.
- **A mounted preview ignores a changed `filePath` prop.** It is mounted per
  tab, so this is currently unreachable, but the effect that would handle it is
  a documented no-op.
- **The preview's 500 ms attach poll never stops** if the file is never opened
  in the editor; it runs for the lifetime of the tab.
