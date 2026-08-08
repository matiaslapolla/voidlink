/// One fake for the whole Tauri boundary, so a render test declares **data**
/// rather than module mocks.
///
/// ## Why this exists
///
/// The first render tests in this repo each mocked their way to the boundary
/// module by module — `vi.mock("@/api/journal")`, then `vi.mock("@/store/journal")`,
/// then the next surface's two. That works for one surface and collapses at
/// twenty, for three reasons worth naming because they are what this file is
/// designed against:
///
///   1. **It tests the mock.** A test that replaces `journalApi.query` proves
///      the component calls *something*; it cannot notice that `query` now
///      sends `{ query }` where Rust reads `{ q }`. The seam moved above the
///      thing most likely to be wrong.
///   2. **It does not compose.** Mounting Mission Control means faking the
///      journal, the git API, the agent transport and the worktree list. Four
///      `vi.mock` factories per file, each with its own idea of the shape.
///   3. **It rots.** A factory is a hand-written copy of a module's exports.
///      Add an export and every factory that forgot it fails at import time
///      with an error naming the wrong file.
///
/// Faking `invoke` instead puts the seam exactly where the process boundary
/// really is. Every `@/api/*` module runs **unchanged** — its argument shaping,
/// its return typing, its error translation are all under test — and the test
/// says what Rust would have answered.
///
/// ## Using it
///
/// `setup.ts` installs the module mocks for the whole render project, so a test
/// file needs no `vi.mock` at all:
///
/// ```ts
/// import { mockTauri, tauriCalls, emitTauriEvent } from "@/test/tauri";
///
/// const tauri = mockTauri({
///   journal_query: [event({ id: "1", summary: "committed" })],
///   journal_repos: [],
///   git_status: ({ repoPath }) => statusFor(repoPath),
/// });
///
/// // …mount, interact…
///
/// expect(tauriCalls("journal_query")).toHaveLength(1);
/// expect(tauriCalls("journal_query")[0].args.query).toMatchObject({ limit: 200 });
/// emitTauriEvent("voidlink://journal-appended", [event({ id: "2" })]);
/// ```
///
/// A handler is either a **value** (returned as-is, the common case) or a
/// **function** of the command's arguments. Functions may be async, may throw
/// to exercise an error path, and receive exactly the object `invoke` was
/// called with.
///
/// ## The deliberate strictness
///
/// An `invoke` for a command with no handler **rejects**, naming the command.
/// It would be easy to resolve `undefined` instead and let tests pass; that is
/// how you end up asserting against a component rendering an empty state it
/// reached by accident. The failure message is written to be the fix: it tells
/// you which key to add.
///
/// `resetTauri()` runs from `setup.ts` after every test, so state never leaks
/// between files.

import { vi } from "vitest";

/// A recorded crossing of the boundary.
export interface InvokeCall {
  command: string;
  /// Exactly what the call site passed. `{}` when it passed nothing —
  /// normalised so an assertion never has to check for `undefined` first.
  args: Record<string, unknown>;
}

/// What a command answers with: a value, or a function of the arguments.
/// `unknown` rather than a generic because the whole point is that the test
/// supplies a Rust-shaped payload, and Rust's shape is what the `@/api/*`
/// module is being tested to parse.
export type InvokeHandler =
  | unknown
  | ((args: Record<string, unknown>) => unknown | Promise<unknown>);

export type InvokeHandlers = Record<string, InvokeHandler>;

/// A listener registered through `listen()` or a window's `listen()`.
type EventHandler = (event: { event: string; id: number; payload: unknown }) => void;

interface TauriState {
  handlers: Map<string, InvokeHandler>;
  calls: InvokeCall[];
  listeners: Map<string, Set<EventHandler>>;
  /// Every `Channel` the code under test constructed, newest last. A streaming
  /// command's handler reaches for this to push messages back.
  channels: MockChannel[];
  nextEventId: number;
  windowLabel: string;
}

const state: TauriState = {
  handlers: new Map(),
  calls: [],
  listeners: new Map(),
  channels: [],
  nextEventId: 1,
  windowLabel: "main",
};

/// Stand-in for `@tauri-apps/api/core`'s `Channel`.
///
/// The real one is a handle Rust writes into; here a test writes into it. It is
/// registered on construction so a handler can find it without the test having
/// to thread it anywhere — `tauriChannel()` returns the most recent, which is
/// the one the command being handled just created.
export class MockChannel<T = unknown> {
  onmessage: ((message: T) => void) | null = null;
  /// Everything sent through it, for assertions.
  readonly sent: T[] = [];

  constructor() {
    state.channels.push(this as MockChannel);
  }

  /// Deliver one message, as Rust would.
  send(message: T): void {
    this.sent.push(message);
    this.onmessage?.(message);
  }

  toJSON(): string {
    return "__CHANNEL__";
  }
}

/// The channel the code under test most recently constructed.
///
/// Streaming commands (`agent_stream_query`, the PTY reader) build a `Channel`,
/// hand it to `invoke`, and read the answers off it. A handler drives one like
/// this:
///
/// ```ts
/// mockTauri({
///   agent_stream_query: async () => {
///     tauriChannel()!.send({ kind: "delta", text: "hello" });
///     return { output: "hello", exitCode: 0 };
///   },
/// });
/// ```
export function tauriChannel<T = unknown>(): MockChannel<T> | undefined {
  return state.channels.at(-1) as MockChannel<T> | undefined;
}

/// Every channel constructed since the last reset, oldest first.
export function tauriChannels<T = unknown>(): readonly MockChannel<T>[] {
  return state.channels as readonly MockChannel<T>[];
}

/// The controller `mockTauri` returns. Everything on it is also available as a
/// free function; the object exists so a test that wants one name for its fake
/// can have one.
export interface TauriMock {
  /// Add or replace handlers mid-test — for "the second call answers
  /// differently" without restructuring the first.
  set(handlers: InvokeHandlers): void;
  calls(command?: string): readonly InvokeCall[];
  emit(event: string, payload?: unknown): void;
  reset(): void;
}

/// Install handlers. Merges into whatever is already registered, so a `beforeEach`
/// can set the common ones and a test can override the one it cares about.
export function mockTauri(handlers: InvokeHandlers = {}): TauriMock {
  for (const [command, handler] of Object.entries(handlers)) {
    state.handlers.set(command, handler);
  }
  return {
    set: (more) => mockTauri(more),
    calls: tauriCalls,
    emit: emitTauriEvent,
    reset: resetTauri,
  };
}

/// What crossed the boundary, in order. With no argument, every call — which is
/// the assertion for "and nothing else was invoked".
export function tauriCalls(command?: string): readonly InvokeCall[] {
  return command === undefined ? state.calls : state.calls.filter((c) => c.command === command);
}

/// The arguments of the most recent call to `command`, or `undefined` if it was
/// never invoked. The common assertion, spelled once.
export function lastInvokeArgs(command: string): Record<string, unknown> | undefined {
  return tauriCalls(command).at(-1)?.args;
}

/// Push an event as Rust's broadcast would, to every listener registered for it
/// — through `listen()`, through a window's `listen()`, or through
/// `getCurrentWebview().listen()`. They share one registry because they share
/// one bus in the real runtime.
///
/// Synchronous on purpose: `listen` is async, so a test must `await` the mount
/// before emitting, and making the emit itself async as well would hide that
/// ordering requirement behind a second await.
export function emitTauriEvent(event: string, payload?: unknown): void {
  const handlers = state.listeners.get(event);
  if (!handlers) return;
  const id = state.nextEventId++;
  // Copied before iterating: a handler that unsubscribes itself mid-broadcast
  // is a normal thing for a component to do while unmounting.
  for (const handler of [...handlers]) handler({ event, id, payload });
}

/// Whether anything is listening for `event`. The honest way to assert "the
/// component subscribed", rather than reaching into a mocked module.
export function tauriListenerCount(event: string): number {
  return state.listeners.get(event)?.size ?? 0;
}

/// What `getCurrentWindow().label` answers. The workbench, the editor window
/// and the git window take different paths off it.
export function setTauriWindowLabel(label: string): void {
  state.windowLabel = label;
}

/// Drop every handler, call, listener and channel. Called from `setup.ts` after
/// each test.
export function resetTauri(): void {
  state.handlers.clear();
  state.calls.length = 0;
  state.listeners.clear();
  state.channels.length = 0;
  closeHandlers.length = 0;
  state.nextEventId = 1;
  state.windowLabel = "main";
}

// ─── The module fakes ────────────────────────────────────────────────────
//
// `setup.ts` points `vi.mock` at these. They are exported rather than defined
// inline in the setup file because a `vi.mock` factory is hoisted above every
// import in its module, so anything it references has to arrive through a
// dynamic import — and that reads far better pointing at named functions here.

/// `@tauri-apps/api/core`'s `invoke`.
export async function fakeInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const call: InvokeCall = { command, args: args ?? {} };
  state.calls.push(call);

  if (!state.handlers.has(command)) {
    // Naming the command and the fix, because the alternative — resolving
    // `undefined` — turns a missing stub into a component quietly rendering an
    // empty state, and the test passes for the wrong reason.
    throw new Error(
      `[mockTauri] no handler for invoke("${command}").\n` +
        `Add it: mockTauri({ ${command}: <value or (args) => value> }).\n` +
        `Args were: ${safeJson(call.args)}`,
    );
  }

  const handler = state.handlers.get(command);
  const result = typeof handler === "function" ? await handler(call.args) : handler;
  return result as T;
}

/// `@tauri-apps/api/event`'s `listen`, and the same implementation behind a
/// window's or webview's `listen`.
export async function fakeListen(
  event: string,
  handler: EventHandler,
): Promise<() => void> {
  let handlers = state.listeners.get(event);
  if (!handlers) {
    handlers = new Set();
    state.listeners.set(event, handlers);
  }
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) state.listeners.delete(event);
  };
}

/// `@tauri-apps/api/event`'s `emit`. Code under test emitting an event is
/// *also* delivered to listeners here — in the real runtime an emit goes to
/// Rust and comes back to every window including the sender, and a test that
/// did not model that would miss the loops that behaviour causes.
export async function fakeEmit(event: string, payload?: unknown): Promise<void> {
  state.calls.push({ command: `emit:${event}`, args: { payload } });
  emitTauriEvent(event, payload);
}

/// `convertFileSrc()`. The real one hands back an `asset://` (or
/// `http://asset.localhost/`) URL the webview's asset protocol can fetch; there
/// is no protocol handler in a test browser, so this returns a URL of the same
/// *shape* rather than one that resolves. Callers assert on the mapping, never
/// on the bytes.
///
/// It has to be here, and in both setup files' `@tauri-apps/api/core` factory,
/// because a `vi.mock` factory *replaces* the module: an export the factory
/// omits does not fall through to the real one. Under jsdom that surfaces as
/// `undefined` at call time, but the browser project resolves the mock as real
/// ESM, where a missing named export is a parse error that fails the whole file
/// on import — which is how this was found.
export function fakeConvertFileSrc(filePath: string, protocol = "asset"): string {
  return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
}

/// Every `onCloseRequested` handler registered in this window, newest last.
/// `closeCurrentWindow()` is what runs them.
const closeHandlers: ((evt: CloseRequestedEventLike) => void | Promise<void>)[] = [];

interface CloseRequestedEventLike {
  preventDefault(): void;
}

/// `getCurrentWindow()` / `getCurrentWebview()`. One object: the two differ in
/// the real API by methods nothing in this app calls on both.
export function fakeCurrentWindow() {
  return {
    get label() {
      return state.windowLabel;
    },
    listen: fakeListen,
    emit: fakeEmit,
    startResizeDragging: vi.fn(async () => {}),
    startDragging: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
    isFocused: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    /// Recorded as an `invoke`-shaped call so `tauriCalls("destroy")` can
    /// assert a window actually took itself down. `destroy` is not really a
    /// command — but it is the one window operation this app's lifecycle turns
    /// on, and the alternative is a test reaching into a `vi.fn` it has no
    /// handle on.
    destroy: vi.fn(async () => {
      state.calls.push({ command: "destroy", args: { label: state.windowLabel } });
    }),
    /// Models tauri 2.11's own wrapper, which is the part that matters: it
    /// **awaits** the handler and only then destroys the window. A handler that
    /// fires its IPC off without awaiting is racing its own teardown, and a
    /// fake that called the handler synchronously would let that bug pass.
    onCloseRequested: async (
      handler: (evt: CloseRequestedEventLike) => void | Promise<void>,
    ) => {
      closeHandlers.push(handler);
      return () => {
        const at = closeHandlers.indexOf(handler);
        if (at !== -1) closeHandlers.splice(at, 1);
      };
    },
    onFocusChanged: vi.fn(async () => () => {}),
    // OS file drops onto a terminal pane (`TerminalPane.tsx`). No test drives
    // an actual drop through this yet — the fake only has to resolve with an
    // unlisten function so a mounted pane's `onMount` does not throw trying to
    // register the listener at all.
    onDragDropEvent: vi.fn(async () => () => {}),
  };
}

/// Close this window the way the OS traffic light would: raise the close
/// request, await every handler, and destroy unless one prevented it.
///
/// The whole point of the detach lifecycle is that a window closed by the OS
/// and one closed by our own control end up in the same place, so a test has to
/// be able to press the traffic light.
export async function closeCurrentWindow(): Promise<void> {
  for (const handler of [...closeHandlers]) {
    let prevented = false;
    await handler({
      preventDefault() {
        prevented = true;
      },
    });
    if (!prevented) {
      state.calls.push({ command: "destroy", args: { label: state.windowLabel } });
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
