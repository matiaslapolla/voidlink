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

For reading and light editing next to the git suite. It is a code editor, not an
IDE — there is no language server, no formatter, and no find-in-files.

## How to use it

### Editing

1. Open a file from the file tree, the file finder (`Mod+P`), or a
   `path:line` link in a terminal. The tree hides gitignored files by default;
   the `Ignored` toggle above it lists them, dimmed, so a repo's `.env` can be
   edited. (`.git` is never listed either way.)
2. Edit. A dirty tab shows a small filled dot in the tab strip.
3. `Mod+S` saves. Writes go through an atomic temp-file-plus-rename on the Rust
   side.

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
| `Mod+S` | Save the active file |
| `Mod+W` | Close the active tab |
| `Mod+Alt+→` / `Mod+Alt+←` | Cycle tabs |
| `Mod+Alt+B` | Toggle [inline blame](./blame.md) |
| `Mod+Shift+D` | Toggle inline / split diff (affects diff panes, not the editor) |

Everything else in the editor is Monaco's stock 0.55 keymap — VoidLink registers
no Monaco commands or actions of its own. That means `Mod+F` find, `Mod+Alt+F`
replace, `Mod+D` add-selection-to-next-match, `Mod+/` toggle comment,
`Alt+↑`/`Alt+↓` move line, and `F1` quick command all work as shipped.

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
- **Models are never re-read from disk.** After a checkout, rebase, or an
  external edit, open tabs still show the content loaded when you first opened
  them. Close and reopen the tab to refresh.
- **No autosave**, no save-on-blur, no save button. `Mod+S` only.
- **Dirty tracking is debounced 100 ms** and only clears on save.
- **No split editor and no scroll sync** between a file and its preview — they
  are sibling full-width tabs.
- **A mounted preview ignores a changed `filePath` prop.** It is mounted per
  tab, so this is currently unreachable, but the effect that would handle it is
  a documented no-op.
- **The preview's 500 ms attach poll never stops** if the file is never opened
  in the editor; it runs for the lifetime of the tab.
