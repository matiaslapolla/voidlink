/// The editor window's status bar: what the buffer in front actually is.
///
/// Same row, same chips as the workbench's `StatusBar` — `STATUS_BAR_ROW` and
/// `StatusChip` come from that module rather than being re-typed here, because
/// two status bars that drift apart is the Monaco-drift failure MASTER §11.5
/// names for this module, expressed in 1px of padding.
///
/// Nothing here animates. Every value in it changes on a keystroke or a tab
/// switch, which MASTER §7.1 budgets at 0ms; the single exception is the LSP
/// LED's pulse while a server is starting, which is a functional loop over work
/// genuinely in flight (§7.3.9) and is not the only channel separating that
/// state from its neighbours (see `lspStatus.ts`).

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { GitCommitHorizontal } from "lucide-solid";
import type * as Monaco from "monaco-editor";
import { STATUS_BAR_ROW, StatusChip } from "@/components/layout/StatusBar";
import { StatusLed } from "@/components/layout/StatusLed";
import { editorController } from "./editorController";
import {
  ENCODING_LABEL,
  NO_CURSOR,
  cursorLabel,
  eolLabel,
  indentLabel,
  languageLabel,
  readCursor,
  type CursorState,
} from "./editorStatus";
import { lspSegment, lspStatus } from "./lspStatus";
import { vimInNormalMode, vimStatusLabel } from "./vimMode";
import {
  blameAuthor,
  blameEnabled,
  blameErrorFor,
  blameLineFor,
  blameRevision,
  blameStatusFor,
  relTime,
} from "./blameOverlay";

export interface EditorStatusBarProps {
  /// Absolute path of the file in front, or `null` when nothing is.
  path: () => string | null;
  /// Open the go-to-line prompt. What the line:column chip does.
  onGoToLine?: () => void;
  /// Show a commit. The blame chip's click target — the caret line's commit.
  /// Absent means the chip reads but does not link.
  onRevealCommit?: (oid: string) => void;
  /// Open the language server's output log. Wave 5 supplies it; until then the
  /// segment is absent anyway, so `undefined` is the normal state.
  onShowLspLog?: () => void;
  /// Restart a crashed language server. Same.
  onRestartLsp?: () => void;
}

export function EditorStatusBar(props: EditorStatusBarProps) {
  const [cursor, setCursor] = createSignal<CursorState>(NO_CURSOR);
  const [model, setModel] = createSignal<Monaco.editor.ITextModel | null>(null);
  /// Bumped by the model's own option / content events so the derived chips
  /// re-read it. The model is not a Solid store; without this an indent change
  /// would leave the chip showing the old number until the next tab switch.
  const [revision, setRevision] = createSignal(0);

  let boundEditor: Monaco.editor.IStandaloneCodeEditor | null = null;
  let boundModel: Monaco.editor.ITextModel | null = null;
  let listeners: Monaco.IDisposable[] = [];

  function unbind() {
    for (const d of listeners) d.dispose();
    listeners = [];
  }

  /// Follow the focused group. Driven by the controller's notifications, not by
  /// props, because the editor instance itself appears asynchronously (Monaco
  /// is a dynamic import) and moves when the split focus moves.
  function sync() {
    const editor = editorController.getEditor();
    const nextModel = editor?.getModel() ?? null;
    if (editor === boundEditor && nextModel === boundModel) return;
    unbind();
    boundEditor = editor;
    boundModel = nextModel;
    setModel(nextModel);
    setCursor(editor ? readCursor(editor) : NO_CURSOR);
    setRevision((r) => r + 1);
    if (!editor) return;
    const refresh = () => setCursor(readCursor(editor));
    listeners.push(editor.onDidChangeCursorPosition(refresh));
    listeners.push(editor.onDidChangeCursorSelection(refresh));
    if (nextModel) {
      listeners.push(nextModel.onDidChangeOptions(() => setRevision((r) => r + 1)));
      // EOL is a model property that only changes on an explicit conversion or
      // a reload from disk, both of which surface as a content change.
      listeners.push(nextModel.onDidChangeContent(() => setRevision((r) => r + 1)));
    }
  }

  onMount(() => {
    sync();
    const unsub = editorController.subscribe(() => sync());
    onCleanup(() => {
      unsub();
      unbind();
    });
  });

  const language = () => {
    revision();
    const m = model();
    return m ? languageLabel(m.getLanguageId()) : null;
  };

  const indent = () => {
    revision();
    const m = model();
    if (!m) return null;
    const opts = m.getOptions();
    return indentLabel({ insertSpaces: opts.insertSpaces, tabSize: opts.tabSize });
  };

  const eol = () => {
    revision();
    const m = model();
    return m ? eolLabel(m.getEOL()) : null;
  };

  const segment = () => lspSegment(lspStatus());

  /// What the caret line is blamed on.
  ///
  /// This is the blame surface. It used to be a chip in the *workbench's* status
  /// bar which received no blame data at all — and in the default detached mode
  /// the workbench hosts no Monaco, so it could not have. Here it sits next to
  /// the buffer it is about, and it rides the cursor subscription `sync()`
  /// already installed for the line:column chip rather than adding a second
  /// listener.
  ///
  /// `blameRevision()` is what makes a fetch landing visible: the cache is a
  /// plain map, so without tracking it the chip would only catch up on the next
  /// cursor move.
  const blame = () => {
    if (!blameEnabled()) return null;
    blameRevision();
    const path = props.path();
    if (!path) return null;
    const status = blameStatusFor(path);
    if (status === "off" || status === "unknown") return null;
    if (status === "loading") {
      return { text: "Blame…", title: "Reading git blame", oid: null, tone: "muted" as const };
    }
    if (status === "unavailable") {
      // Named, not blank. "No blame for this file" and "blame is switched off"
      // were previously the same empty space.
      const why = blameErrorFor(path);
      return {
        text: "No blame",
        title: why
          ? `git could not blame this file: ${why}`
          : "No blame for this file — not committed, ignored, or outside the repo",
        oid: null,
        tone: "muted" as const,
      };
    }
    const line = blameLineFor(path, cursor().line);
    if (!line) return null;
    if (line.uncommitted) {
      return {
        text: `${blameAuthor(line)} · Uncommitted`,
        title: "This line is not committed yet",
        oid: null,
        tone: "muted" as const,
      };
    }
    return {
      text: `${blameAuthor(line)} · ${relTime(line.time)} · ${line.shortOid}`,
      title: `${line.summary}\n${blameAuthor(line)} <${line.authorEmail}>\n${line.commitOid}\nClick to open this commit`,
      // `commitOid` was fetched and typed and read by nothing. This is what
      // makes it worth carrying.
      oid: line.commitOid,
      tone: "muted" as const,
    };
  };

  // The workbench's status bar is its own island and needs no top rule; this
  // one sits *inside* the editor island, below the buffer, so it keeps a
  // hairline to separate it from the code above. One border inside one island
  // is not card-in-card.
  return (
    <div
      class={`${STATUS_BAR_ROW} border-t border-border/60`}
      role="status"
      aria-label="Editor status"
    >
      {/* Vim's mode. A modal editor whose mode is invisible is unusable, so it
          leads the bar rather than sitting behind an overflow. `--primary`
          tint in normal mode is the app's "this one is active" idiom
          (§11.5.3); absent entirely when Vim mode is off. */}
      <Show when={vimStatusLabel()}>
        {(label) => (
          <span
            aria-live="polite"
            class="shrink-0 font-mono text-[10px] uppercase tracking-wider px-1.5 rounded border"
            classList={{
              "bg-primary/15 border-primary/40 text-primary": vimInNormalMode(),
              "bg-transparent border-border text-muted-foreground": !vimInNormalMode(),
            }}
          >
            {label()}
          </span>
        )}
      </Show>

      {/* "No editor buffer", not "no file open": a diff, a merge or a markdown
          preview can be in front, in which case there is plenty open and none
          of these chips has anything true to say about it. */}
      <Show when={props.path()} fallback={<span class="opacity-60">No editor buffer</span>}>
        <Show when={language()}>
          {(lang) => <StatusChip title="Language mode">{lang()}</StatusChip>}
        </Show>

        <StatusChip
          title={props.onGoToLine ? "Go to line" : "Cursor position"}
          label={`Cursor at line ${cursor().line}, column ${cursor().column}`}
          onClick={props.onGoToLine}
        >
          <span class="font-mono tabular-nums">{cursorLabel(cursor())}</span>
        </StatusChip>

        <Show when={indent()}>
          {(text) => (
            <StatusChip title="Indentation, from Settings → Editor">{text()}</StatusChip>
          )}
        </Show>

        <Show when={eol()}>
          {(text) => <StatusChip title="Line endings">{text()}</StatusChip>}
        </Show>

        <StatusChip title="VoidLink reads and writes UTF-8">{ENCODING_LABEL}</StatusChip>

        {/* Blame for the caret line. Absent — not greyed — when blame is off,
            which is what makes "off" and "unavailable" distinguishable: off has
            no chip, unavailable says so. Clicking opens the commit. */}
        <Show when={blame()}>
          {(b) => (
            <StatusChip
              title={b().title}
              label={`Blame: ${b().text}`}
              tone={b().tone}
              onClick={
                b().oid && props.onRevealCommit
                  ? () => props.onRevealCommit?.(b().oid!)
                  : undefined
              }
            >
              <GitCommitHorizontal class="w-3 h-3 shrink-0 opacity-70" />
              <span class="truncate max-w-[220px]">{b().text}</span>
            </StatusChip>
          )}
        </Show>
      </Show>

      <span class="flex-1" />

      {/* The language server. Absent — not grey, not disabled, absent — when
          there is none, so a user who does not want one is never nagged. */}
      <Show when={segment()}>
        {(seg) => (
          <StatusChip
            title={seg().title}
            label={seg().text}
            tone={seg().signal === "failed" ? "destructive" : "muted"}
            onClick={
              seg().action === "restart" ? props.onRestartLsp : props.onShowLspLog
            }
          >
            <StatusLed signal={seg().signal} pending={seg().pending} silent />
            <span>{seg().text}</span>
          </StatusChip>
        )}
      </Show>
    </div>
  );
}
