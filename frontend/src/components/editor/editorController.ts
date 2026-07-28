import type * as Monaco from "monaco-editor";
import { fsApi } from "@/api/fs";
import { editorOptions, inferLanguage, loadMonaco, modelOptions } from "./monaco";
import { applyVoidlinkTheme, monacoThemeName } from "./monacoTheme";
import { registerEditorActions } from "./editorActions";
import { applySaveTransforms } from "./saveTransforms";
import { disableVim, enableVim } from "./vimMode";
import { changedPaths, planForChanges, toStampMap, type StampMap } from "./externalChanges";
import { EditorSessionStore } from "./sessionRestore";
import type { GroupId } from "./editorGroups";
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
type OpenFilesMeta = {
  path: string;
  dirty: boolean;
  saving: boolean;
  /// Reloaded from disk while the user was elsewhere. Clears on activation —
  /// the §7.5.3 *finished* signal.
  reloaded: boolean;
  /// Changed on disk while dirty. Waiting on the inline bar.
  conflicted: boolean;
};

/// What each live editor group is showing, for the surface that draws them.
/// Read-only projection — the controller owns the editors themselves.
export type GroupSnapshot = { id: GroupId; activePath: string | null; focused: boolean };

type ChangeListener = (
  files: OpenFilesMeta[],
  activePath: string | null,
  groups: GroupSnapshot[],
) => void;

/// One editor group: a Monaco instance, the file it currently shows, and the
/// listeners hung off it. There are at most two (see `editorGroups.ts`), keyed
/// by `GroupId`, and a layout with one group holds exactly the `primary` entry
/// this class used to keep in a bare `this.editor` field.
type EditorGroup = {
  id: GroupId;
  editor: Monaco.editor.IStandaloneCodeEditor;
  activePath: string | null;
  disposables: Monaco.IDisposable[];
};

/// Monaco's side of the editor window: the model cache, the dirty bookkeeping,
/// and the one or two `IStandaloneCodeEditor`s the file tabs share.
///
/// The model cache is deliberately *not* per group. Two groups showing the same
/// file share one `ITextModel`, which is what makes an edit in the left pane
/// appear in the right one — the alternative (a model per group) is two buffers
/// of the same file that can silently diverge and then race each other to disk.
///
/// None of this state crosses windows. The *list* of open files is owned by the
/// workbench and arrives as a broadcast snapshot (see `api/windows.ts`), which
/// `reconcile` folds into the model cache; everything else here — which model is
/// attached where, what is unsaved, where the cursor sits — is local by design,
/// because it is meaningless in a window where Monaco isn't running.
class EditorController {
  private monaco: typeof Monaco | null = null;
  private groups = new Map<GroupId, EditorGroup>();
  /// Which group takes `openFile`, `save`, the reveal ping and the reconcile's
  /// active path. Always a key of `groups` while any group exists.
  private focusedId: GroupId = "primary";
  private models = new Map<string, EditorModel>();
  private openOrder: string[] = [];
  private listeners = new Set<ChangeListener>();
  private disposeMap = new Map<string, Monaco.IDisposable>();
  /// Whether Vim bindings should be attached. Kept here rather than read from
  /// the store because the adapter follows *focus*: splitting or switching
  /// groups has to move it, and the store has no opinion about groups.
  private vimEnabled = false;

  /// The last editor settings pushed in from the store, kept as a plain
  /// snapshot so `init` and `ensureModel` — neither of which runs inside a
  /// tracking scope — can seed a new editor or model without importing the
  /// store's reactivity into a class that has none. `EditorHost` owns the
  /// subscription and calls `applyEditorSettings`.
  private settings: EditorSettings = DEFAULT_SETTINGS.editor;

  // Resolved once the first group's init() completes — openFile() awaits this
  // so rapid clicks work.
  private _initResolve!: () => void;
  private _initPromise: Promise<void> = new Promise(r => { this._initResolve = r; });

  /// Bring up the editor for `groupId` inside `container`.
  ///
  /// Early-returns while that group already has an editor — the same contract
  /// the single-editor version had, now per group, because `EditorHost` can
  /// re-run `onMount` against a group that was never torn down.
  async init(container: HTMLElement, mode: ThemeMode = "dark", groupId: GroupId = "primary") {
    if (this.groups.has(groupId)) return;

    // MonacoEnvironment is configured inside loadMonaco(), before Monaco can
    // touch a worker — see `monaco.ts` for why that lives in exactly one place.
    const monaco = await loadMonaco();
    this.monaco = monaco;

    // A second await-crossing guard: two hosts mounting in the same tick both
    // reach here, and the second must not create a duplicate editor into the
    // first one's slot.
    if (this.groups.has(groupId)) return;

    // Define the VoidLink themes before the first `create`, so the editor never
    // paints a frame of stock `vs-dark` on top of a solarized shell.
    applyVoidlinkTheme(monaco, mode);

    const editor = monaco.editor.create(container, {
      ...editorOptions(this.settings),
      model: null,
      theme: monacoThemeName(mode),
    });

    const group: EditorGroup = { id: groupId, editor, activePath: null, disposables: [] };
    group.disposables.push(editor.onDidBlurEditorWidget(() => this.saveOnFocusChange(group)));
    // Clicking into a pane is the other way focus moves between groups; the
    // surface handles the pointer case, this covers a focus that arrives from
    // Monaco itself (a find-widget close, a peek, a command).
    group.disposables.push(editor.onDidFocusEditorText(() => this.focusGroup(groupId)));
    this.groups.set(groupId, group);
    registerEditorActions(editor);

    if (!this.groups.has(this.focusedId)) this.focusedId = groupId;
    if (this.vimEnabled && this.focusedId === groupId) void enableVim(editor);

    this._initResolve();
    this.notify();
  }

  /// Tear down one group's editor, and — when it was the last one — forget
  /// every model, leaving the controller ready to `init` again into a new
  /// container.
  ///
  /// The full teardown is needed because the host can genuinely unmount: in
  /// stacked mode the editor is a view, and turning the mode off removes it from
  /// the tree. `init` early-returns when that group already has an editor, so
  /// without this the next mount would attach nothing and show a permanently
  /// blank editor. Unsaved buffers are dropped along with the models — the same
  /// as closing the editor window, which is the operation this mirrors.
  ///
  /// Closing *one* of two groups is not that operation, so it keeps the models:
  /// the files are still open, they are just no longer shown twice.
  disposeGroup(groupId: GroupId) {
    const group = this.groups.get(groupId);
    if (!group) return;
    this.captureViewState(group);
    for (const d of group.disposables) d.dispose();
    group.editor.dispose();
    this.groups.delete(groupId);

    if (this.groups.size > 0) {
      if (this.focusedId === groupId) {
        this.focusedId = [...this.groups.keys()][0];
        if (this.vimEnabled) void enableVim(this.groups.get(this.focusedId)!.editor);
      }
      this.notify();
      return;
    }

    // Last group gone: the editor surface no longer exists.
    this.session?.flush();
    disableVim();
    for (const path of [...this.autoSaveTimers.keys()]) this.cancelAutoSave(path);
    for (const path of [...this.models.keys()]) this.disposeModel(path);
    this.focusedId = "primary";
    this.openOrder = [];
    // A fresh gate, so anything awaiting readiness waits for the *next* init
    // rather than sailing through against a disposed editor.
    this._initPromise = new Promise((r) => {
      this._initResolve = r;
    });
    this.notify();
  }

  /// Tear down every group. Kept as the whole-surface teardown; a host unmount
  /// disposes only its own group.
  dispose() {
    for (const id of [...this.groups.keys()]) this.disposeGroup(id);
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  /// The group commands act on. Falls back to any live group when the focused
  /// id has been disposed out from under a caller mid-await.
  private focused(): EditorGroup | null {
    return this.groups.get(this.focusedId) ?? [...this.groups.values()][0] ?? null;
  }

  /// Make `groupId` the target of the next open, save or reveal. Moves the Vim
  /// adapter with it — a modal editor attached to the pane you are not typing in
  /// is worse than no Vim mode at all.
  focusGroup(groupId: GroupId) {
    if (!this.groups.has(groupId) || this.focusedId === groupId) return;
    this.focusedId = groupId;
    if (this.vimEnabled) void enableVim(this.groups.get(groupId)!.editor);
    this.notify();
  }

  /// Focus a group *and* put the caret in it. Separate from `focusGroup`
  /// because the DOM focus call must not run when the reason focus moved was
  /// Monaco telling us it already had it.
  focusGroupEditor(groupId: GroupId) {
    this.focusGroup(groupId);
    this.groups.get(groupId)?.editor.focus();
  }

  getFocusedGroup(): GroupId {
    return this.focusedId;
  }

  getGroups(): GroupSnapshot[] {
    return [...this.groups.values()].map((g) => ({
      id: g.id,
      activePath: g.activePath,
      focused: g.id === this.focusedId,
    }));
  }

  /// Show `path` in a specific group without moving focus. Used when a split is
  /// created: the new pane opens on whatever the old one was showing, which is
  /// the only starting point that isn't a blank editor.
  async showInGroup(groupId: GroupId, path: string | null) {
    await this._initPromise;
    const group = this.groups.get(groupId);
    if (!group) return;
    if (path && !this.models.has(path)) {
      const meta = await this.ensureModel(path);
      if (!meta) return;
    }
    this.attach(group, path);
    this.notify();
  }

  /// Point a group's editor at a path's model, saving the outgoing view state
  /// and restoring the incoming one. Every model swap goes through here.
  private attach(group: EditorGroup, path: string | null) {
    this.captureViewState(group);
    const model = path ? (this.models.get(path)?.model ?? null) : null;
    group.activePath = model ? path : null;
    group.editor.setModel(model);
    if (group.activePath) this.restoreViewState(group, group.activePath);
    requestAnimationFrame(() => group.editor.layout());
  }

  // ── Session restore ──────────────────────────────────────────────────────
  //
  // Cursor, scroll and folds, per file, per workspace. Every model swap in this
  // class goes through `attach`, so these two are the only places view state is
  // read or written — there is no second path a position can leak out of.

  private session: EditorSessionStore | null = null;
  /// Session state saved *before* the editor had a workspace to file it under
  /// would be filed under the wrong one; `setSessionKey` is called by the
  /// surface as soon as the repo is known, which in practice is before the
  /// first file opens.
  private sessionKey: string | null = null;

  /// Point session restore at a workspace. Flushes the outgoing store first, so
  /// switching repositories cannot drop the positions from the one being left.
  setSessionKey(workspaceKey: string | null) {
    if (workspaceKey === this.sessionKey) return;
    for (const g of this.groups.values()) this.captureViewState(g);
    this.session?.flush();
    this.sessionKey = workspaceKey;
    this.session = workspaceKey ? new EditorSessionStore(workspaceKey) : null;
  }

  /// Write every visible group's position out now. The surface calls this on
  /// unload, where the store's coalescing timer would never fire.
  persistSession() {
    for (const g of this.groups.values()) this.captureViewState(g);
    this.session?.flush();
  }

  private captureViewState(group: EditorGroup) {
    if (!this.session || !group.activePath) return;
    if (!group.editor.getModel()) return;
    this.session.save(group.activePath, group.editor.saveViewState());
  }

  private restoreViewState(group: EditorGroup, path: string) {
    const state = this.session?.restore(path);
    if (!state) return;
    // Opaque by construction (see `sessionRestore.ts`): this is the one call
    // allowed to assert what is inside it. A stale or foreign shape makes
    // Monaco ignore it, which is the same outcome as having no session.
    group.editor.restoreViewState(state as Monaco.editor.ICodeEditorViewState);
  }

  /// Load `path` into a model (reusing the cached one) without touching which
  /// model is attached to any editor. A read failure falls back to an empty
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
    const group = this.focused();
    if (!this.monaco || !group) return;
    const meta = await this.ensureModel(path);
    if (!meta) return;

    if (!this.openOrder.includes(path)) this.openOrder.push(path);
    this.attach(group, path);
    group.editor.focus();
    this.notify();
  }

  /// Fold a broadcast tab list into the model cache: open what is new, dispose
  /// what is gone, attach whatever the workbench says is in front.
  ///
  /// This is the editor window's only entry point for *which* files are open.
  /// Dropping a model here also drops its unsaved edits, which is correct: the
  /// tab is already gone from the window that owns the tab list, and a detached
  /// model would leak one buffer per closed tab with no surface to show it.
  ///
  /// Only the focused group follows the broadcast's active tab. A second group
  /// keeps showing what it was showing — that is the entire point of splitting —
  /// and is only touched when the file under it closes.
  async reconcile(paths: string[], activePath: string | null) {
    await this._initPromise;
    const group = this.focused();
    if (!group) return;

    const wanted = new Set(paths);
    for (const path of [...this.models.keys()]) {
      if (!wanted.has(path)) this.disposeModel(path);
    }
    // Mirror the incoming order so tab order and `getOpenFiles()` agree.
    this.openOrder = [...wanted];
    await Promise.all(paths.map((p) => this.ensureModel(p)));

    for (const g of this.groups.values()) {
      if (g.activePath && !wanted.has(g.activePath)) this.attach(g, null);
    }

    const next = activePath && wanted.has(activePath) ? activePath : null;
    // `getModel() === null` catches the first reconcile after init, where the
    // active path already matches but nothing is attached yet.
    if (next) this.reloaded.delete(next);
    if (next !== group.activePath || group.editor.getModel() === null) {
      this.attach(group, next);
    }
    this.notify();
  }

  async saveActive() {
    const path = this.focused()?.activePath;
    if (path) await this.save(path);
  }

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
  /// attached, so this has to find the group actually showing `path`; a
  /// background autosave of a file that is in no group must not call it — it
  /// would reformat the wrong buffer. With no provider registered (which is
  /// every language until Wave 5's LSP lands) the action is absent and this is
  /// a no-op, which is the correct degradation.
  private async formatDocument(path: string) {
    const group = [...this.groups.values()].find((g) => g.activePath === path);
    if (!group) return;
    const action = group.editor.getAction("editor.action.formatDocument");
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

  /// `autoSave: onFocusChange`. Wired to each group's blur event in `init`, and
  /// also the right place for a future window-blur hook. Saves the file that
  /// group was showing, not the focused group's — blur means *that* pane lost
  /// the caret.
  private saveOnFocusChange(group: EditorGroup) {
    if (this.settings.autoSave !== "onFocusChange") return;
    const path = group.activePath;
    const meta = path ? this.models.get(path) : null;
    if (!path || !meta?.dirty || meta.saving) return;
    void this.save(path).catch((e) => this.autoSaveFailed?.(path, e));
  }

  /// Drop a model and its change listener. Leaves `openOrder` and the groups'
  /// active pointers alone — the callers own those.
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
    const fallback = this.openOrder[this.openOrder.length - 1] ?? null;
    for (const g of this.groups.values()) {
      if (g.activePath === path) this.attach(g, fallback);
    }
    this.notify();
  }

  setActive(path: string) {
    const group = this.focused();
    if (!group || !this.models.has(path)) return;
    // Seeing the tab is what the "reloaded while you were away" mark was for.
    this.reloaded.delete(path);
    this.attach(group, path);
    group.editor.focus();
    this.notify();
  }

  /// Reveal a 1-based (line, col) in the focused group and place the cursor
  /// there. No-op if no model is active. Used by the terminal deep-link
  /// provider to jump from `path:42` in scrollback to that exact line in Monaco.
  revealPosition(line: number, column = 1) {
    const editor = this.focused()?.editor;
    if (!editor) return;
    const safeLine = Math.max(1, line);
    const safeCol = Math.max(1, column);
    editor.revealLineInCenter(safeLine);
    editor.setPosition({ lineNumber: safeLine, column: safeCol });
    editor.focus();
  }

  getOpenFiles(): OpenFilesMeta[] {
    return this.openOrder.map((p) => {
      const meta = this.models.get(p);
      return {
        path: p,
        dirty: meta?.dirty ?? false,
        saving: meta?.saving ?? false,
        reloaded: this.reloaded.has(p),
        conflicted: this.conflicted.has(p),
      };
    });
  }

  /// Expose the underlying Monaco objects so external overlays (inline
  /// blame, search-result highlights, future linter squiggles) can hook
  /// into the editor without us replicating Monaco's decoration API.
  ///
  /// `getEditor()` with no argument means the focused group — which is what
  /// every existing caller meant when there was only one editor.
  getMonaco() { return this.monaco; }
  getEditor(groupId?: GroupId) {
    if (groupId) return this.groups.get(groupId)?.editor ?? null;
    return this.focused()?.editor ?? null;
  }
  getModel(path: string) { return this.models.get(path)?.model ?? null; }

  getActivePath(groupId?: GroupId): string | null {
    if (groupId) return this.groups.get(groupId)?.activePath ?? null;
    return this.focused()?.activePath ?? null;
  }

  layout() {
    for (const g of this.groups.values()) g.editor.layout();
  }

  /// Take a new editor-settings snapshot and push it into every live editor and
  /// every cached model. Idempotent, and safe before `init` — the snapshot is
  /// what the next `create` will be built from.
  ///
  /// This is what makes "a setting that only takes effect on reload is a bug"
  /// true: there is no second path by which options reach Monaco.
  applyEditorSettings(next: EditorSettings) {
    this.settings = next;
    const eOpts = editorOptions(next);
    for (const g of this.groups.values()) g.editor.updateOptions(eOpts);
    const mOpts = modelOptions(next);
    for (const meta of this.models.values()) meta.model.updateOptions(mOpts);
  }

  // ── External changes ─────────────────────────────────────────────────────

  private stamps: StampMap = {};
  /// Buffers whose disk content moved while they had unsaved edits. The editor
  /// surface renders an inline bar for whichever of these is in front — one
  /// bar, per buffer, never a modal and never a queue of them.
  private conflicted = new Set<string>();
  /// Buffers reloaded from disk while the user was looking elsewhere. Cleared
  /// when the tab is next activated (§7.5.3, the *finished* signal).
  private reloaded = new Set<string>();

  /// Re-stat every open file and reconcile.
  ///
  /// Clean buffers are reloaded silently; dirty ones are left alone and flagged
  /// so the surface can offer the choice. Returns how many of each, so a caller
  /// that wants one aggregated notice for a 200-file checkout has the number
  /// without having to count events.
  async checkExternalChanges(): Promise<{ reloaded: number; conflicted: number }> {
    const paths = [...this.models.keys()];
    if (paths.length === 0) return { reloaded: 0, conflicted: 0 };

    const stamps = await fsApi.statFiles(paths);
    const changed = changedPaths(this.stamps, stamps);
    this.stamps = toStampMap(stamps);
    if (changed.length === 0) return { reloaded: 0, conflicted: 0 };

    const plan = planForChanges(changed, (p) => this.models.get(p)?.dirty ?? false);
    for (const path of plan.reload) await this.reloadFromDisk(path);
    for (const path of plan.conflicted) this.conflicted.add(path);
    if (plan.reload.length || plan.conflicted.length) this.notify();
    return { reloaded: plan.reload.length, conflicted: plan.conflicted.length };
  }

  /// True when any group is showing `path`. A silent reload the user watched
  /// happen needs no "finished" mark.
  private isVisible(path: string): boolean {
    for (const g of this.groups.values()) if (g.activePath === path) return true;
    return false;
  }

  /// Replace a buffer's text with what is on disk, keeping the viewport.
  ///
  /// `pushEditOperations` rather than `setValue` so the scroll position and
  /// folds survive — a silent reload that jumps the user to line 1 is not
  /// silent.
  private async reloadFromDisk(path: string) {
    const meta = this.models.get(path);
    if (!meta) return;
    let content: string;
    try {
      content = await fsApi.readFile(path);
    } catch {
      // A file that vanished stays as it was in the buffer. Truncating the
      // user's open tab because the file was deleted would lose more than it
      // fixes.
      return;
    }
    if (meta.model.getValue() === content) return;
    meta.model.pushEditOperations(
      [],
      [{ range: meta.model.getFullModelRange(), text: content }],
      () => null,
    );
    meta.dirty = false;
    this.conflicted.delete(path);
    // Only worth signalling if the user was not watching it happen.
    if (!this.isVisible(path)) this.reloaded.add(path);
  }

  /// Resolve an inline-bar conflict by taking what is on disk.
  async takeTheirs(path: string) {
    const meta = this.models.get(path);
    if (!meta) return;
    meta.dirty = false;
    await this.reloadFromDisk(path);
    this.conflicted.delete(path);
    this.reloaded.delete(path);
    this.notify();
  }

  /// Resolve an inline-bar conflict by keeping the buffer. The next save
  /// overwrites the on-disk version, which is what the user just asked for.
  keepMine(path: string) {
    this.conflicted.delete(path);
    this.notify();
  }

  hasExternalConflict(path: string | null): boolean {
    return !!path && this.conflicted.has(path);
  }

  /// Turn Vim bindings on or off against the focused group's editor.
  ///
  /// Waits for `init` so a settings effect that runs before the editor exists
  /// still lands. Off is synchronous — detaching must not depend on a chunk
  /// that may never have loaded.
  async setVimMode(enabled: boolean) {
    this.vimEnabled = enabled;
    if (!enabled) {
      disableVim();
      return;
    }
    await this._initPromise;
    const editor = this.focused()?.editor;
    if (editor) await enableVim(editor);
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
    const active = this.focused()?.activePath ?? null;
    const groups = this.getGroups();
    for (const fn of this.listeners) fn(files, active, groups);
  }
}

export const editorController = new EditorController();
