import type * as Monaco from "monaco-editor";
import { fsApi } from "@/api/fs";
import { editorOptions, inferLanguage, loadMonaco, modelOptions } from "./monaco";
import { applyVoidlinkTheme, monacoThemeName } from "./monacoTheme";
import { registerEditorActions } from "./editorActions";
import { applySaveTransforms } from "./saveTransforms";
import { disableVim, enableVim } from "./vimMode";
import type { ThemeMode } from "@/store/theme";
import { DEFAULT_SETTINGS, type EditorSettings } from "@/store/settings";

type EditorModel = {
  path: string;
  model: Monaco.editor.ITextModel;
  dirty: boolean;
  /// A write is in flight. Distinct from `dirty`, which stays true throughout:
  /// the dot never disappears while the buffer differs from disk (MASTER
  /// §7.5.3), it just enters its pending form (§7.6).
  saving: boolean;
};
type OpenFilesMeta = { path: string; dirty: boolean; saving: boolean };
type ChangeListener = (files: OpenFilesMeta[], activePath: string | null) => void;

/// Monaco's side of the editor window: the model cache, the dirty bookkeeping,
/// and the single `IStandaloneCodeEditor` every file tab shares.
///
/// None of this state crosses windows. The *list* of open files is owned by the
/// workbench and arrives as a broadcast snapshot (see `api/windows.ts`), which
/// `reconcile` folds into the model cache; everything else here — which model is
/// attached, what is unsaved, where the cursor sits — is local by design,
/// because it is meaningless in a window where Monaco isn't running.
class EditorController {
  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private models = new Map<string, EditorModel>();
  private openOrder: string[] = [];
  private activePath: string | null = null;
  private listeners = new Set<ChangeListener>();
  private disposeMap = new Map<string, Monaco.IDisposable>();

  /// The last editor settings pushed in from the store, kept as a plain
  /// snapshot so `init` and `ensureModel` — neither of which runs inside a
  /// tracking scope — can seed a new editor or model without importing the
  /// store's reactivity into a class that has none. `EditorHost` owns the
  /// subscription and calls `applyEditorSettings`.
  private settings: EditorSettings = DEFAULT_SETTINGS.editor;

  // Resolved once init() completes — openFile() awaits this so rapid clicks work.
  private _initResolve!: () => void;
  private _initPromise: Promise<void> = new Promise(r => { this._initResolve = r; });

  async init(container: HTMLElement, mode: ThemeMode = "dark") {
    if (this.editor) return; // already initialised

    // MonacoEnvironment is configured inside loadMonaco(), before Monaco can
    // touch a worker — see `monaco.ts` for why that lives in exactly one place.
    const monaco = await loadMonaco();
    this.monaco = monaco;

    // Define the VoidLink themes before the first `create`, so the editor never
    // paints a frame of stock `vs-dark` on top of a solarized shell.
    applyVoidlinkTheme(monaco, mode);

    this.editor = monaco.editor.create(container, {
      ...editorOptions(this.settings),
      model: null,
      theme: monacoThemeName(mode),
    });

    this.editor.onDidBlurEditorWidget(() => this.saveOnFocusChange());
    registerEditorActions(this.editor);

    this._initResolve();
  }

  /// Tear the editor down and forget every model, leaving the controller ready
  /// to `init` again into a new container.
  ///
  /// Needed because the host can genuinely unmount: in stacked mode the editor
  /// is a view, and turning the mode off removes it from the tree. `init`
  /// early-returns when an editor already exists, so without this the next mount
  /// would attach nothing and show a permanently blank editor. Unsaved buffers
  /// are dropped along with the models — the same as closing the editor window,
  /// which is the operation this mirrors.
  dispose() {
    disableVim();
    for (const path of [...this.autoSaveTimers.keys()]) this.cancelAutoSave(path);
    for (const path of [...this.models.keys()]) this.disposeModel(path);
    this.editor?.dispose();
    this.editor = null;
    this.activePath = null;
    this.openOrder = [];
    // A fresh gate, so anything awaiting readiness waits for the *next* init
    // rather than sailing through against a disposed editor.
    this._initPromise = new Promise((r) => {
      this._initResolve = r;
    });
    this.notify();
  }

  /// Load `path` into a model (reusing the cached one) without touching which
  /// model is attached to the editor. A read failure falls back to an empty
  /// buffer on purpose: a file that vanished between the click and the read
  /// should leave an editable empty tab, not a dead one.
  private async ensureModel(path: string): Promise<EditorModel | null> {
    const cached = this.models.get(path);
    if (cached) return cached;
    if (!this.monaco) return null;

    let content = "";
    try { content = await fsApi.readFile(path); }
    catch (e) { console.warn("EditorController: failed to read", path, e); }

    // Another caller may have created the model while we were awaiting the read.
    const raced = this.models.get(path);
    if (raced) return raced;

    const uri = this.monaco.Uri.file(path);
    const model = this.monaco.editor.createModel(content, inferLanguage(path), uri);
    // Indentation is a model option, so a freshly-created model does not
    // inherit it from the editor it is about to be attached to.
    model.updateOptions(modelOptions(this.settings));
    const meta: EditorModel = { path, model, dirty: false, saving: false };
    this.models.set(path, meta);

    let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
    const disposable = model.onDidChangeContent(() => {
      if (dirtyTimer) clearTimeout(dirtyTimer);
      dirtyTimer = setTimeout(() => {
        const m = this.models.get(path);
        if (m && !m.dirty) { m.dirty = true; this.notify(); }
        dirtyTimer = null;
      }, 100);
      // Autosave is scheduled off the raw change, not off the debounced dirty
      // flag: the delay the user configured should start at their last
      // keystroke, not 100ms after it.
      this.scheduleAutoSave(path);
    });
    this.disposeMap.set(path, disposable);
    return meta;
  }

  async openFile(path: string) {
    await this._initPromise;
    if (!this.monaco || !this.editor) return;
    const meta = await this.ensureModel(path);
    if (!meta) return;

    if (!this.openOrder.includes(path)) this.openOrder.push(path);
    this.activePath = path;
    this.editor.setModel(meta.model);
    requestAnimationFrame(() => this.editor?.layout());
    this.editor.focus();
    this.notify();
  }

  /// Fold a broadcast tab list into the model cache: open what is new, dispose
  /// what is gone, attach whatever the workbench says is in front.
  ///
  /// This is the editor window's only entry point for *which* files are open.
  /// Dropping a model here also drops its unsaved edits, which is correct: the
  /// tab is already gone from the window that owns the tab list, and a detached
  /// model would leak one buffer per closed tab with no surface to show it.
  async reconcile(paths: string[], activePath: string | null) {
    await this._initPromise;
    if (!this.editor) return;

    const wanted = new Set(paths);
    for (const path of [...this.models.keys()]) {
      if (!wanted.has(path)) this.disposeModel(path);
    }
    // Mirror the incoming order so tab order and `getOpenFiles()` agree.
    this.openOrder = [...wanted];
    await Promise.all(paths.map((p) => this.ensureModel(p)));

    const next = activePath && wanted.has(activePath) ? activePath : null;
    // `getModel() === null` catches the first reconcile after init, where the
    // active path already matches but nothing is attached yet.
    if (next !== this.activePath || this.editor.getModel() === null) {
      this.activePath = next;
      this.editor.setModel(next ? (this.models.get(next)?.model ?? null) : null);
      requestAnimationFrame(() => this.editor?.layout());
    }
    this.notify();
  }

  async saveActive() { if (this.activePath) await this.save(this.activePath); }

  /// Write a buffer to disk, running the configured save-time transforms first.
  ///
  /// Order is format → trim → final newline (see `saveTransforms.ts`). The
  /// transforms go through `pushEditOperations` rather than `setValue` so the
  /// undo stack and the cursor survive a save, which is the difference between
  /// trim-on-save being usable and being infuriating.
  ///
  /// Throws on a write failure, leaving the buffer dirty. That is deliberate:
  /// MASTER §7.5.6 forbids leaving an optimistic clean state standing, and the
  /// caller is the layer that owns the retry toast.
  async save(path: string) {
    const meta = this.models.get(path);
    if (!meta) return;
    this.cancelAutoSave(path);

    meta.saving = true;
    this.notify();
    try {
      if (this.settings.formatOnSave) await this.formatDocument(path);
      this.applyTextTransforms(meta);
      await fsApi.writeFile(path, meta.model.getValue());
      meta.dirty = false;
    } finally {
      meta.saving = false;
      this.notify();
    }
  }

  /// Run the registered document-formatting provider over a model.
  ///
  /// Monaco's `formatDocument` action operates on whatever the *editor* has
  /// attached, so a background autosave of a file that is not in front must not
  /// call it — it would reformat the wrong buffer. With no provider registered
  /// (which is every language until Wave 5's LSP lands) the action is absent
  /// and this is a no-op, which is the correct degradation.
  private async formatDocument(path: string) {
    if (!this.editor || this.activePath !== path) return;
    const action = this.editor.getAction("editor.action.formatDocument");
    if (!action) return;
    try {
      await action.run();
    } catch (e) {
      // A formatter that throws must not block the write.
      console.warn("EditorController: format on save failed", path, e);
    }
  }

  /// Apply the pure text transforms in place. No-op when the text is unchanged,
  /// so a save of an already-clean buffer does not push an empty undo stop.
  private applyTextTransforms(meta: EditorModel) {
    const opts = {
      trimTrailingWhitespace: this.settings.trimTrailingWhitespaceOnSave,
      insertFinalNewline: this.settings.insertFinalNewlineOnSave,
    };
    if (!opts.trimTrailingWhitespace && !opts.insertFinalNewline) return;
    const before = meta.model.getValue();
    const after = applySaveTransforms(before, opts);
    if (after === before) return;
    meta.model.pushEditOperations(
      [],
      [{ range: meta.model.getFullModelRange(), text: after }],
      () => null,
    );
  }

  // ── Auto-save ────────────────────────────────────────────────────────────
  //
  // The dirty dot is never suppressed by any of this (MASTER §7.5.3): it
  // appears on the first edit and clears on the write, so a pending autosave is
  // something the user can see rather than something they have to trust.

  private autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private cancelAutoSave(path: string) {
    const t = this.autoSaveTimers.get(path);
    if (t === undefined) return;
    clearTimeout(t);
    this.autoSaveTimers.delete(path);
  }

  private scheduleAutoSave(path: string) {
    if (this.settings.autoSave !== "afterDelay") return;
    this.cancelAutoSave(path);
    const timer = setTimeout(() => {
      this.autoSaveTimers.delete(path);
      void this.save(path).catch((e) => {
        // An autosave failure is reported by the same path as a manual one —
        // the controller has no toast of its own, by design.
        this.autoSaveFailed?.(path, e);
      });
    }, Math.max(100, this.settings.autoSaveDelayMs));
    this.autoSaveTimers.set(path, timer);
  }

  /// Called when a *background* write fails. Set by whoever owns the toast
  /// surface; a manual save reports through its own rejected promise instead.
  autoSaveFailed: ((path: string, error: unknown) => void) | null = null;

  /// `autoSave: onFocusChange`. Wired to the editor's blur event in `init`, and
  /// also the right place for a future window-blur hook.
  private saveOnFocusChange() {
    if (this.settings.autoSave !== "onFocusChange") return;
    const path = this.activePath;
    const meta = path ? this.models.get(path) : null;
    if (!path || !meta?.dirty || meta.saving) return;
    void this.save(path).catch((e) => this.autoSaveFailed?.(path, e));
  }

  /// Drop a model and its change listener. Leaves `openOrder` and the active
  /// pointer alone — the callers own those.
  private disposeModel(path: string) {
    const meta = this.models.get(path);
    if (!meta) return;
    this.cancelAutoSave(path);
    this.disposeMap.get(path)?.dispose();
    this.disposeMap.delete(path);
    meta.model.dispose();
    this.models.delete(path);
  }

  closeFile(path: string) {
    if (!this.models.has(path)) return;
    this.disposeModel(path);
    this.openOrder = this.openOrder.filter(p => p !== path);
    if (this.activePath === path) {
      this.activePath = this.openOrder[this.openOrder.length - 1] ?? null;
      if (this.editor) {
        this.editor.setModel(this.activePath ? (this.models.get(this.activePath)?.model ?? null) : null);
      }
    }
    this.notify();
  }

  setActive(path: string) {
    if (!this.editor || !this.models.has(path)) return;
    this.activePath = path;
    this.editor.setModel(this.models.get(path)!.model);
    requestAnimationFrame(() => this.editor?.layout());
    this.editor.focus();
    this.notify();
  }

  /// Reveal a 1-based (line, col) in the currently-active editor and
  /// place the cursor there. No-op if no model is active. Used by the
  /// terminal deep-link provider to jump from `path:42` in scrollback
  /// to that exact line in Monaco.
  revealPosition(line: number, column = 1) {
    if (!this.editor) return;
    const safeLine = Math.max(1, line);
    const safeCol = Math.max(1, column);
    this.editor.revealLineInCenter(safeLine);
    this.editor.setPosition({ lineNumber: safeLine, column: safeCol });
    this.editor.focus();
  }

  getOpenFiles(): OpenFilesMeta[] {
    return this.openOrder.map((p) => {
      const meta = this.models.get(p);
      return { path: p, dirty: meta?.dirty ?? false, saving: meta?.saving ?? false };
    });
  }

  /// Expose the underlying Monaco objects so external overlays (inline
  /// blame, search-result highlights, future linter squiggles) can hook
  /// into the editor without us replicating Monaco's decoration API.
  getMonaco() { return this.monaco; }
  getEditor() { return this.editor; }
  getModel(path: string) { return this.models.get(path)?.model ?? null; }

  getActivePath() { return this.activePath; }
  layout() { this.editor?.layout(); }

  /// Take a new editor-settings snapshot and push it into the live editor and
  /// every cached model. Idempotent, and safe before `init` — the snapshot is
  /// what the next `create` will be built from.
  ///
  /// This is what makes "a setting that only takes effect on reload is a bug"
  /// true: there is no second path by which options reach Monaco.
  applyEditorSettings(next: EditorSettings) {
    this.settings = next;
    this.editor?.updateOptions(editorOptions(next));
    const mOpts = modelOptions(next);
    for (const meta of this.models.values()) meta.model.updateOptions(mOpts);
  }

  /// Turn Vim bindings on or off against the shared editor.
  ///
  /// Waits for `init` so a settings effect that runs before the editor exists
  /// still lands. Off is synchronous — detaching must not depend on a chunk
  /// that may never have loaded.
  async setVimMode(enabled: boolean) {
    if (!enabled) {
      disableVim();
      return;
    }
    await this._initPromise;
    if (this.editor) await enableVim(this.editor);
  }

  /// Re-derive the VoidLink Monaco themes from the current cascade and apply
  /// the one for `mode`. Takes the app's mode rather than a Monaco theme name
  /// because the mapping — and the token re-read a named-theme switch needs —
  /// belongs in `monacoTheme.ts`, not in every caller.
  setThemeMode(mode: ThemeMode) {
    if (this.monaco) applyVoidlinkTheme(this.monaco, mode);
  }

  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    const files = this.getOpenFiles();
    const active = this.activePath;
    for (const fn of this.listeners) fn(files, active);
  }
}

export const editorController = new EditorController();
