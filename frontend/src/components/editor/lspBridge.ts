/// The language-server bridge: sessions, document sync, status.
///
/// One instance per editor window, started by `EditorApp` and stopped with it.
/// It is the only module that knows a language server is a *process*; the
/// providers see a `resolve()`, the client sees a transport, and the status
/// segment sees `setLspStatus`.
///
/// ## Degradation is the design, not a fallback
///
/// Every path through this file has an answer for "there is no server":
///
///   - `lspApi.locate` returns `null` → no session is ever started, the status
///     stays `absent`, and `lspSegment` renders **nothing**. Not a grey chip.
///     A user who has not installed rust-analyzer must not be nagged forever
///     (`<design>`).
///   - A session that dies → its providers' `resolve()` returns `null`, so
///     every provider answers "nothing" and Monaco falls back to its own
///     TypeScript worker and the regex outline. The editor does not notice.
///   - A crash → `--destructive` in the status segment until acknowledged, and
///     a bounded restart with backoff. `shouldToastCrash` decides the single
///     toast at three consecutive crashes; there is none before that, because a
///     server that crash-restarts once is noise.
///
/// ## Document sync is full-text, on purpose
///
/// Both servers advertise incremental sync, and both accept a change event with
/// no `range`, which the specification defines as "the new full content" — that
/// is the escape hatch every client uses for a paste or an external reload.
/// Incremental sync would mean turning Monaco's `IModelContentChangedEvent`
/// into LSP ranges and keeping a version count that must never diverge from the
/// server's idea of the buffer; when it does diverge the symptom is completions
/// computed against text that no longer exists, which is worse than the
/// bandwidth. Source files are small and this is a local pipe.

import type * as Monaco from "monaco-editor";
import { fsApi } from "@/api/fs";
import { lspApi, type LspExitEvent, type LspLogEvent, type LspMessageEvent } from "@/api/lsp";
import type { EditorSettings } from "@/store/settings";
import { editorController } from "./editorController";
import { LspClient } from "./lspClient";
import { applyDiagnostics, registerLspProviders, type LspSessionHandle } from "./lspProviders";
import { pathFromUri, toLspPosition, type LspDiagnostic, type LspLocation, type LspLocationLink, toTargets } from "./lspProtocol";
import {
  LSP_SERVERS,
  lspLanguageId,
  serverCommand,
  serverForPath,
  tsserverLibCandidates,
  type LspServerSpec,
} from "./lspServers";
import { acknowledgeLspCrash, lspStatus, setLspStatus, shouldToastCrash, type LspState } from "./lspStatus";

/// Content changes are coalesced for this long. Long enough that a fast typist
/// produces one notification per word rather than per key, short enough that
/// the completion request fired on the next keystroke sees current text.
const SYNC_DEBOUNCE_MS = 250;

/// Restart backoff, indexed by consecutive crash count. Flat after the third,
/// which is also where the toast fires — past that the user has been told and
/// hammering the binary helps nobody.
const RESTART_BACKOFF_MS = [500, 2_000, 10_000];

/// Consecutive crashes after which the bridge stops restarting. The status
/// segment stays `crashed` until the user clicks it, which restarts and resets.
const MAX_RESTARTS = 5;

/// Log lines kept per server, for the output-log surface.
const LOG_LIMIT = 500;

type SessionState = "starting" | "ready" | "degraded" | "crashed" | "stopped";

interface OpenDocument {
  model: Monaco.editor.ITextModel;
  uri: string;
  version: number;
  languageId: string;
  /// Pending debounced sync.
  timer: ReturnType<typeof setTimeout> | null;
  listener: Monaco.IDisposable;
}

interface Session {
  spec: LspServerSpec;
  id: string;
  client: LspClient;
  state: SessionState;
  /// What the server said it can do, from the `initialize` result.
  capabilities: Record<string, unknown>;
  completionTriggers: string[];
  signatureTriggers: string[];
  /// Consecutive crashes. Reset on a successful `initialize`, which is what
  /// makes "three crashes in a row" mean a crash *loop* rather than three
  /// crashes over a working afternoon.
  crashes: number;
  /// Documents the server has been told about.
  docs: Map<string, OpenDocument>;
  /// Buffers opened before `initialize` returned, replayed after it does.
  queued: Monaco.editor.ITextModel[];
  /// Recent failures, for the `degraded` state. A single failed hover is not
  /// degradation; a run of them is.
  consecutiveFailures: number;
  binary: string;
  log: string[];
  restartTimer: ReturnType<typeof setTimeout> | null;
  /// What `initialize` sends. Resolved per session rather than read off the
  /// spec because `typescript-language-server`'s has to be discovered on disk;
  /// see `resolveInitializationOptions`.
  initializationOptions: unknown;
  /// The file whose opening started this session. Kept so a restart can
  /// rediscover the same options without waiting for the user to click a tab.
  hintPath: string | null;
}

export interface LspBridgeOptions {
  /// Absolute path of the workspace root. `null` disables the bridge — a
  /// language server with no project to index is worse than none.
  workspaceRoot: () => string | null;
  settings: () => EditorSettings;
  /// One toast, at the third consecutive crash. Not on every cycle.
  onToast: (message: string) => void;
}

export interface LspBridge {
  /// Reconcile running sessions against the current settings and root. Cheap
  /// and idempotent; called from an effect.
  refresh(): void;
  /// The segment's `restart` click. Acknowledges the crash and starts over.
  restartActive(): void;
  /// The segment's `log` click. Lines for whichever server the buffer in front
  /// belongs to, newest last.
  activeLog(): { server: string; binary: string; lines: string[] } | null;
  /// Definition of the symbol under the cursor, as a path and 1-based position.
  ///
  /// Monaco's own go-to-definition can only navigate to a model that already
  /// exists, and VoidLink's tab list lives in another window — so cross-file
  /// navigation has to go through the workbench's open-file request, which is
  /// what this exists to feed.
  definitionAtCursor(): Promise<{ path: string; line: number; column: number } | null>;
  /// A buffer reached disk. rust-analyzer defers its `cargo check` to this, so
  /// without it Rust diagnostics only catch up on the next edit.
  notifySaved(path: string): void;
  dispose(): void;
}

/// A bridge that does nothing, for a window with no workspace. Keeps the
/// caller free of `?.` on every call.
const INERT: LspBridge = {
  refresh() {},
  restartActive() {},
  activeLog: () => null,
  definitionAtCursor: () => Promise.resolve(null),
  notifySaved() {},
  dispose() {},
};

export function createLspBridge(monaco: typeof Monaco, options: LspBridgeOptions): LspBridge {
  const sessions = new Map<string, Session>();
  /// Server ids whose binary is not installed. Cached so a locate call does
  /// not run on every model open for a language nobody has a server for.
  const missing = new Set<string>();
  const locating = new Set<string>();
  const disposables: Array<{ dispose(): void }> = [];
  let unlisten: Array<() => void> = [];
  let stopped = false;
  let sessionSeq = 0;

  // ── Providers, registered once and for good ─────────────────────────────
  //
  // See `lspProviders.ts`: the registration outlives every session, and a dead
  // session simply makes `resolve()` answer `null`.
  for (const spec of LSP_SERVERS) {
    disposables.push(
      registerLspProviders(monaco, spec, () => {
        const session = sessions.get(spec.id);
        return session && session.state !== "crashed" && session.state !== "stopped"
          ? handleFor(session)
          : null;
      }),
    );
  }

  function handleFor(session: Session): LspSessionHandle {
    return {
      request: (method, params, signal) => session.client.request(method, params, { signal }),
      documentUri: (model) => model.uri.toString(),
      supports: (capability) => session.capabilities[capability] !== undefined,
      completionTriggers: session.completionTriggers,
      signatureTriggers: session.signatureTriggers,
    };
  }

  // ── Status ───────────────────────────────────────────────────────────────

  /// The server the *buffer in front* belongs to. The status segment reports on
  /// one thing, and that thing is the file the user is looking at — a bar
  /// listing every running server would be a process monitor, not a status bar.
  function activeSpec(): LspServerSpec | null {
    const path = editorController.getActivePath();
    return path ? serverForPath(path) : null;
  }

  function refreshStatus() {
    const spec = activeSpec();
    if (!spec || !options.settings().lspEnabled || missing.has(spec.id)) {
      setLspStatus({ state: "absent" });
      return;
    }
    const session = sessions.get(spec.id);
    if (!session || session.state === "stopped") {
      // `starting` only while a `locate` is genuinely in flight. Before that we
      // do not yet know the binary exists, and showing a chip for a server the
      // user has not installed — even for the few milliseconds `locate` takes —
      // is the nag the `absent` state exists to prevent.
      setLspStatus(locating.has(spec.id) ? { state: "starting", server: spec.id } : { state: "absent" });
      return;
    }
    const state: LspState =
      session.state === "ready"
        ? "ready"
        : session.state === "degraded"
          ? "degraded"
          : session.state === "crashed"
            ? "crashed"
            : "starting";
    // The status signal's own crash counter would mix two servers together
    // when the user switches between a `.rs` and a `.ts` tab mid-loop, so the
    // authoritative count is the session's and this call only drives the LED.
    if (state !== "crashed" || lspStatus().state !== "crashed") {
      setLspStatus({ state, server: spec.id });
    }
  }

  function setState(session: Session, next: SessionState) {
    if (session.state === next) return;
    session.state = next;
    refreshStatus();
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  /// What to send as `initializationOptions` for a session about to start.
  ///
  /// Only `typescript-language-server` needs anything discovered: it bundles a
  /// TypeScript and, given no path, looks for one relative to the workspace
  /// root — which in a repo whose root is a git root rather than a package root
  /// finds nothing, leaving every buffer analysed by a TypeScript that is not
  /// the project's. `tsserverLibCandidates` lists the plausible installs
  /// nearest-first and this picks the first that is really there, in one stat
  /// round trip rather than one per level.
  ///
  /// Finding none is not a failure: the server's bundled copy is a perfectly
  /// good fallback and is exactly what it would have used anyway.
  async function resolveInitializationOptions(
    spec: LspServerSpec,
    hintPath: string | null,
  ): Promise<unknown> {
    const root = options.workspaceRoot();
    if (spec.id !== "typescript-language-server" || !hintPath || !root) {
      return spec.initializationOptions;
    }
    const candidates = tsserverLibCandidates(hintPath, root);
    if (candidates.length === 0) return spec.initializationOptions;
    try {
      const stamps = await fsApi.statFiles(candidates.map((lib) => `${lib}/tsserver.js`));
      const found = candidates.find((_, i) => stamps[i]?.exists);
      return found ? { tsserver: { path: found } } : spec.initializationOptions;
    } catch {
      // A failed stat is not worth blocking a language server over.
      return spec.initializationOptions;
    }
  }

  async function ensureSession(
    spec: LspServerSpec,
    hintPath: string | null = null,
  ): Promise<Session | null> {
    if (stopped || !options.settings().lspEnabled) return null;
    if (!options.workspaceRoot()) return null;
    const existing = sessions.get(spec.id);
    if (existing && existing.state !== "stopped") return existing;
    if (missing.has(spec.id) || locating.has(spec.id)) return null;

    locating.add(spec.id);
    refreshStatus();
    try {
      const command = serverCommand(spec, options.settings());
      const binary = await lspApi.locate(command);
      if (!binary) {
        // The whole "absent" path. Remembered, so this costs one call per
        // server per window rather than one per file opened.
        missing.add(spec.id);
        refreshStatus();
        return null;
      }
      if (stopped) return null;
      return await startSession(
        spec,
        command,
        binary,
        existing?.crashes ?? 0,
        hintPath ?? existing?.hintPath ?? null,
      );
    } catch (e) {
      console.warn("[lsp] could not start", spec.id, e);
      return null;
    } finally {
      locating.delete(spec.id);
      refreshStatus();
    }
  }

  async function startSession(
    spec: LspServerSpec,
    command: string,
    binary: string,
    crashes: number,
    hintPath: string | null,
  ): Promise<Session | null> {
    const id = `${spec.id}-${++sessionSeq}`;
    const session: Session = {
      spec,
      id,
      state: "starting",
      capabilities: {},
      completionTriggers: [],
      signatureTriggers: [],
      crashes,
      docs: new Map(),
      queued: [],
      consecutiveFailures: 0,
      binary,
      log: [],
      restartTimer: null,
      initializationOptions: spec.initializationOptions,
      hintPath,
      client: null as unknown as LspClient,
    };
    session.client = new LspClient(
      { send: (text) => lspApi.send(id, text) },
      {
        onNotification: (method, params) => onNotification(session, method, params),
        onRequest: (method, params) => onServerRequest(session, method, params),
        onOutcome: (ok) => onOutcome(session, ok),
      },
    );
    sessions.set(spec.id, session);
    refreshStatus();

    session.initializationOptions = await resolveInitializationOptions(spec, hintPath);
    if (stopped || sessions.get(spec.id) !== session) return null;

    try {
      await lspApi.start(id, command, [...spec.args], options.workspaceRoot());
    } catch (e) {
      note(session, `failed to start: ${e instanceof Error ? e.message : String(e)}`);
      onDead(session, /* requested */ false);
      return null;
    }
    if (stopped) {
      void lspApi.stop(id);
      return null;
    }

    await initialize(session);
    return session;
  }

  async function initialize(session: Session) {
    const root = options.workspaceRoot();
    if (!root) return;
    const rootUri = monaco.Uri.file(root).toString();
    try {
      const result = await session.client.request<{ capabilities?: Record<string, unknown> }>(
        "initialize",
        {
          // `null` rather than a real pid: the frontend has none, and a server
          // that is told a pid will exit when that process disappears.
          processId: null,
          rootUri,
          rootPath: root,
          workspaceFolders: [{ uri: rootUri, name: root.split("/").pop() ?? root }],
          initializationOptions: session.initializationOptions,
          capabilities: CLIENT_CAPABILITIES,
        },
        // The one request with a long budget: rust-analyzer's `initialize`
        // waits on `cargo metadata`, which on a cold target directory is
        // genuinely slow.
        { timeoutMs: 120_000 },
      );
      if (stopped || sessions.get(session.spec.id) !== session) return;

      session.capabilities = result?.capabilities ?? {};
      const completion = session.capabilities.completionProvider as
        | { triggerCharacters?: string[] }
        | undefined;
      const signature = session.capabilities.signatureHelpProvider as
        | { triggerCharacters?: string[] }
        | undefined;
      session.completionTriggers = completion?.triggerCharacters ?? [".", ":"];
      session.signatureTriggers = signature?.triggerCharacters ?? ["(", ","];

      session.client.notify("initialized", {});
      // Sent unconditionally: rust-analyzer treats the absence of this as
      // "configuration not yet known" and defers some work indefinitely.
      session.client.notify("workspace/didChangeConfiguration", { settings: {} });

      // A successful handshake is what resets the crash counter — see the
      // field comment.
      session.crashes = 0;
      setState(session, "ready");

      const queued = session.queued.splice(0);
      for (const model of queued) openDocument(session, model);
      // Anything opened before the bridge existed at all.
      for (const model of monaco.editor.getModels()) trackModel(model);
    } catch (e) {
      note(session, `initialize failed: ${e instanceof Error ? e.message : String(e)}`);
      // A server that cannot initialise is not usable, but it is also still
      // running — stopping it is what turns this into the clean absent-ish
      // state rather than a wedged session answering nothing.
      void lspApi.stop(session.id);
      setState(session, "degraded");
    }
  }

  /// A session's process ended. Decides crash vs. clean stop, and restarts.
  function onDead(session: Session, requested: boolean) {
    for (const doc of session.docs.values()) {
      if (doc.timer) clearTimeout(doc.timer);
      doc.listener.dispose();
      // Markers from a dead server are stale claims about the buffer.
      monaco.editor.setModelMarkers(doc.model, session.spec.id, []);
    }
    session.docs.clear();
    session.queued = [];
    session.client.dispose("language server exited");

    if (requested || stopped) {
      setState(session, "stopped");
      sessions.delete(session.spec.id);
      refreshStatus();
      return;
    }

    session.crashes += 1;
    setState(session, "crashed");
    // Deliberately *after* setState, and using the session's own count: the
    // policy lives in `lspStatus.ts` and this is its one caller.
    if (shouldToastCrash({ state: "crashed", server: session.spec.id, crashes: session.crashes })) {
      options.onToast(
        `${session.spec.id} has stopped three times in a row. Language features are off for now — click the status chip to try again.`,
      );
    }
    if (session.crashes > MAX_RESTARTS) {
      note(session, "giving up after too many crashes; click the status chip to retry");
      return;
    }
    const delay = RESTART_BACKOFF_MS[Math.min(session.crashes - 1, RESTART_BACKOFF_MS.length - 1)];
    session.restartTimer = setTimeout(() => {
      session.restartTimer = null;
      if (stopped || sessions.get(session.spec.id) !== session) return;
      sessions.delete(session.spec.id);
      void ensureSession(session.spec, session.hintPath).then(() => {
        // Carry the count across the restart so three *consecutive* crashes
        // are still three.
        const next = sessions.get(session.spec.id);
        if (next && next !== session) next.crashes = session.crashes;
      });
    }, delay);
  }

  function onOutcome(session: Session, ok: boolean) {
    if (ok) {
      session.consecutiveFailures = 0;
      if (session.state === "degraded") setState(session, "ready");
      return;
    }
    session.consecutiveFailures += 1;
    // Three in a row, not one: a single timed-out hover during indexing is
    // normal and reporting it as degradation would make the chip flicker.
    if (session.consecutiveFailures >= 3 && session.state === "ready") {
      setState(session, "degraded");
    }
  }

  function onServerRequest(_session: Session, method: string, params: unknown): unknown {
    switch (method) {
      // Answered, not ignored: rust-analyzer blocks its own startup waiting for
      // these two.
      case "client/registerCapability":
      case "client/unregisterCapability":
        return null;
      case "window/workDoneProgress/create":
        return null;
      case "workspace/workspaceFolders": {
        // The other half of declaring `workspace.workspaceFolders`. A server
        // that asks and is declined would fall back to `rootUri` anyway, but
        // MethodNotFound against a capability we advertised is the kind of
        // inconsistency that makes a server log look like a client bug.
        const root = options.workspaceRoot();
        if (!root) return null;
        return [{ uri: monaco.Uri.file(root).toString(), name: root.split("/").pop() ?? root }];
      }
      case "workspace/configuration": {
        // One `null` per requested section — "no configuration for that", which
        // makes every server fall back to its defaults.
        const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
        return items.map(() => null);
      }
      case "workspace/applyEdit":
        // Declining rather than silently accepting: applying a server-driven
        // workspace edit means writing files the user did not ask to change,
        // and no feature shipped here requests one.
        return { applied: false, failureReason: "not supported" };
      default:
        // `undefined` makes the client answer MethodNotFound, which is the
        // specified way to decline.
        return undefined;
    }
  }

  function onNotification(session: Session, method: string, params: unknown) {
    switch (method) {
      case "textDocument/publishDiagnostics": {
        const payload = params as { uri: string; diagnostics: LspDiagnostic[] };
        const path = pathFromUri(payload.uri);
        if (!path) return;
        const model = monaco.editor.getModel(monaco.Uri.file(path));
        // Diagnostics for a file that is not open are not an error — servers
        // publish for the whole crate — they are simply nothing to draw.
        if (!model || model.isDisposed()) return;
        applyDiagnostics(monaco, model, session.spec.id, payload.diagnostics ?? []);
        return;
      }
      case "window/logMessage":
      case "window/showMessage": {
        const payload = params as { message?: string };
        if (payload?.message) note(session, payload.message);
        return;
      }
      default:
        // `$/progress`, `telemetry/event` and everything else: ignored on
        // purpose. A notification needs no answer, and nothing here renders
        // progress.
        return;
    }
  }

  function note(session: Session, line: string) {
    session.log.push(line);
    if (session.log.length > LOG_LIMIT) session.log.splice(0, session.log.length - LOG_LIMIT);
  }

  // ── Document sync ────────────────────────────────────────────────────────

  const tracked = new WeakSet<Monaco.editor.ITextModel>();

  /// Hook a model up to whichever server claims its extension.
  function trackModel(model: Monaco.editor.ITextModel) {
    if (stopped || model.isDisposed()) return;
    // Diff and merge surfaces use the `scratchUri` scheme so their models do
    // not collide with the code editor's; they are also not files the server
    // should be told about.
    if (model.uri.scheme !== "file") return;
    const path = model.uri.path;
    const spec = serverForPath(path);
    if (!spec || missing.has(spec.id)) return;
    if (tracked.has(model)) return;

    const session = sessions.get(spec.id);
    if (!session || session.state === "stopped") {
      // Start on first sight of a file that needs it, rather than starting
      // both servers on window open: a repo with no Rust in it should never
      // spawn rust-analyzer.
      void ensureSession(spec, path).then((s) => {
        if (s) trackModel(model);
      });
      return;
    }
    if (session.state === "starting") {
      if (!session.queued.includes(model)) session.queued.push(model);
      return;
    }
    tracked.add(model);
    openDocument(session, model);
  }

  function openDocument(session: Session, model: Monaco.editor.ITextModel) {
    if (model.isDisposed()) return;
    const uri = model.uri.toString();
    if (session.docs.has(uri)) return;

    const doc: OpenDocument = {
      model,
      uri,
      version: 1,
      languageId: lspLanguageId(model.uri.path),
      timer: null,
      listener: { dispose() {} },
    };
    session.docs.set(uri, doc);
    session.client.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: doc.languageId,
        version: doc.version,
        text: model.getValue(),
      },
    });

    const changed = model.onDidChangeContent(() => {
      if (doc.timer) clearTimeout(doc.timer);
      doc.timer = setTimeout(() => {
        doc.timer = null;
        if (model.isDisposed()) return;
        doc.version += 1;
        session.client.notify("textDocument/didChange", {
          textDocument: { uri, version: doc.version },
          // No `range` means "this is the whole document" — see the module
          // comment for why that is the deliberate choice here.
          contentChanges: [{ text: model.getValue() }],
        });
      }, SYNC_DEBOUNCE_MS);
    });
    const disposing = model.onWillDispose(() => closeDocument(session, uri));
    doc.listener = {
      dispose() {
        changed.dispose();
        disposing.dispose();
      },
    };
  }

  function closeDocument(session: Session, uri: string) {
    const doc = session.docs.get(uri);
    if (!doc) return;
    if (doc.timer) clearTimeout(doc.timer);
    doc.listener.dispose();
    session.docs.delete(uri);
    session.client.notify("textDocument/didClose", { textDocument: { uri } });
  }

  // ── Event wiring ─────────────────────────────────────────────────────────

  function sessionById(id: string): Session | null {
    for (const session of sessions.values()) if (session.id === id) return session;
    return null;
  }

  void (async () => {
    const handlers = await Promise.all([
      lspApi.onMessage((e: LspMessageEvent) => sessionById(e.sessionId)?.client.receive(e.message)),
      lspApi.onLog((e: LspLogEvent) => {
        const session = sessionById(e.sessionId);
        if (session) note(session, e.line);
      }),
      lspApi.onExit((e: LspExitEvent) => {
        const session = sessionById(e.sessionId);
        if (!session) return;
        note(session, `exited (${e.code ?? "signal"}): ${e.reason}`);
        onDead(session, e.requested);
      }),
    ]);
    if (stopped) {
      for (const off of handlers) off();
      return;
    }
    unlisten = handlers;
  })();

  disposables.push(monaco.editor.onDidCreateModel((model) => trackModel(model)));
  // The status segment follows the focused group's file.
  disposables.push({ dispose: editorController.subscribe(() => refreshStatus()) });

  // Models that already exist when the bridge starts.
  for (const model of monaco.editor.getModels()) trackModel(model);
  refreshStatus();

  // ── The public surface ───────────────────────────────────────────────────

  function stopAll(reason: SessionState) {
    for (const session of [...sessions.values()]) {
      if (session.restartTimer) clearTimeout(session.restartTimer);
      for (const doc of session.docs.values()) {
        if (doc.timer) clearTimeout(doc.timer);
        doc.listener.dispose();
        monaco.editor.setModelMarkers(doc.model, session.spec.id, []);
      }
      session.docs.clear();
      session.client.dispose("language server stopped");
      session.state = reason;
      void lspApi.stop(session.id);
      sessions.delete(session.spec.id);
    }
  }

  return {
    refresh() {
      if (stopped) return;
      if (!options.settings().lspEnabled || !options.workspaceRoot()) {
        stopAll("stopped");
        refreshStatus();
        return;
      }
      // A changed override path means the cached "not installed" answer is
      // stale. Re-locating is one cheap call and only happens on a settings
      // edit.
      missing.clear();
      const spec = activeSpec();
      if (spec) void ensureSession(spec, editorController.getActivePath());
      refreshStatus();
    },

    restartActive() {
      const spec = activeSpec();
      if (!spec) return;
      acknowledgeLspCrash();
      const session = sessions.get(spec.id);
      if (session) {
        if (session.restartTimer) clearTimeout(session.restartTimer);
        session.client.dispose("restarting");
        void lspApi.stop(session.id);
        sessions.delete(spec.id);
      }
      missing.delete(spec.id);
      void ensureSession(spec, editorController.getActivePath()).then(() => {
        for (const model of monaco.editor.getModels()) trackModel(model);
      });
    },

    activeLog() {
      const spec = activeSpec();
      if (!spec) return null;
      const session = sessions.get(spec.id);
      if (!session) return null;
      return { server: spec.id, binary: session.binary, lines: [...session.log] };
    },

    async definitionAtCursor() {
      const editor = editorController.getEditor();
      const model = editor?.getModel();
      const position = editor?.getPosition();
      if (!model || !position || model.uri.scheme !== "file") return null;
      const spec = serverForPath(model.uri.path);
      const session = spec ? sessions.get(spec.id) : null;
      if (!session || session.state === "crashed" || session.state === "stopped") return null;
      try {
        const result = await session.client.request<
          LspLocation | LspLocation[] | LspLocationLink[] | null
        >("textDocument/definition", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
        });
        const target = toTargets(result)[0];
        if (!target) return null;
        return {
          path: target.path,
          line: target.range.startLineNumber,
          column: target.range.startColumn,
        };
      } catch {
        return null;
      }
    },

    notifySaved(path) {
      const spec = serverForPath(path);
      const session = spec ? sessions.get(spec.id) : null;
      if (!session || session.state !== "ready") return;
      const uri = monaco.Uri.file(path).toString();
      const doc = session.docs.get(uri);
      // Only for a document the server has actually been told about — a save of
      // a file it never saw would be a notification about nothing.
      if (!doc) return;
      // A pending debounced `didChange` still holds the newest text. Flushing it
      // first is what stops the server checking the buffer as it was a moment
      // ago and reporting diagnostics for text that is no longer on disk.
      if (doc.timer) {
        clearTimeout(doc.timer);
        doc.timer = null;
        doc.version += 1;
        session.client.notify("textDocument/didChange", {
          textDocument: { uri, version: doc.version },
          contentChanges: [{ text: doc.model.getValue() }],
        });
      }
      session.client.notify("textDocument/didSave", { textDocument: { uri } });
    },

    dispose() {
      stopped = true;
      for (const off of unlisten) off();
      unlisten = [];
      stopAll("stopped");
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      setLspStatus({ state: "absent" });
    },
  };
}

export { INERT as INERT_LSP_BRIDGE };

/// What this client tells a server it can do.
///
/// Understated on purpose: every `true` here is a promise, and a client that
/// announces a capability it does not implement gets sent messages it will drop
/// — `workspace/applyEdit` after a rename being the classic way to lose an
/// edit. Everything declared below has a provider in `lspProviders.ts`.
const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
      // `true` because `notifySaved` sends it. rust-analyzer gates its flycheck
      // on this notification, so declaring it false is what left Rust
      // diagnostics a save behind.
      didSave: true,
    },
    completion: {
      dynamicRegistration: false,
      completionItem: {
        // Monaco applies snippets natively, so this one is honest.
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
        preselectSupport: true,
        insertReplaceSupport: true,
        labelDetailsSupport: true,
        tagSupport: { valueSet: [1] },
      },
      contextSupport: false,
    },
    hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
    signatureHelp: {
      dynamicRegistration: false,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: { labelOffsetSupport: true },
        activeParameterSupport: true,
      },
    },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentSymbol: {
      dynamicRegistration: false,
      hierarchicalDocumentSymbolSupport: true,
    },
    formatting: { dynamicRegistration: false },
    rangeFormatting: { dynamicRegistration: false },
    publishDiagnostics: {
      relatedInformation: false,
      tagSupport: { valueSet: [1, 2] },
      versionSupport: false,
    },
  },
  workspace: {
    // `true` because `onServerRequest` answers it — with a list of `null`s,
    // which is a valid answer meaning "use your defaults".
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: false },
    // `true`, matching the `workspaceFolders` array `initialize` actually
    // sends. Declaring it false told servers to ignore that array and fall back
    // to `rootUri` — the same directory here, but a contradiction that would
    // quietly become a bug the day a second folder is supported.
    workspaceFolders: true,
    applyEdit: false,
  },
  window: { workDoneProgress: true },
} as const;
