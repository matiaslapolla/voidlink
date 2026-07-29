/// JSON-RPC 2.0 over an injected transport.
///
/// One layer, one job: ids, pending requests, timeouts, and routing incoming
/// messages to the right place. It has no Monaco imports and no Tauri imports —
/// the transport is a two-function interface — which is what makes it testable
/// and what keeps `<constraints>`' layering honest.
///
/// Three things here are not obvious and all three are failure modes:
///
///   **Timeouts.** A request whose response never arrives leaks its promise for
///   the lifetime of the window, and the caller — a Monaco provider — is holding
///   the suggest widget open waiting for it. rust-analyzer genuinely does go
///   quiet for tens of seconds during its first index, so the timeout is
///   generous, but it exists.
///
///   **Server→client requests.** A server that asks
///   `client/registerCapability` and gets no answer will, in rust-analyzer's
///   case, block its own initialisation. Every server request therefore gets a
///   response: the handled ones an answer, everything else a MethodNotFound
///   error, which is the specified way to decline.
///
///   **Cancellation.** Monaco hands every provider a `CancellationToken` and
///   fires it constantly (every keystroke supersedes the previous completion
///   request). `$/cancelRequest` tells the server to stop working; without it
///   rust-analyzer keeps computing completions for a prefix nobody is typing.

/// JSON-RPC error codes used here. `MethodNotFound` is the specified answer to
/// a request we choose not to implement.
const METHOD_NOT_FOUND = -32601;
const REQUEST_CANCELLED = -32800;

export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface LspTransport {
  /// Deliver one serialised message. Rejecting is allowed and is treated as
  /// "the server is gone".
  send(text: string): Promise<void>;
}

export interface LspClientHandlers {
  /// A notification from the server: `textDocument/publishDiagnostics`,
  /// `window/logMessage`, `$/progress`.
  onNotification(method: string, params: unknown): void;
  /// A request from the server. Return a result to answer it, or `undefined`
  /// to decline with MethodNotFound. Throwing is also declining.
  onRequest?(method: string, params: unknown): unknown;
  /// Every request that failed or timed out, and every one that succeeded.
  /// Feeds the `degraded` status without this module knowing what that is.
  onOutcome?(ok: boolean): void;
}

export class LspRequestError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.code = code;
    this.name = "LspRequestError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/// Default request budget. Long, because rust-analyzer's first
/// `textDocument/completion` after a cold start can sit behind a full index of
/// the crate graph; short enough that a wedged server does not hold a provider
/// open forever.
const DEFAULT_TIMEOUT_MS = 20_000;

export class LspClient {
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private disposed = false;

  private readonly transport: LspTransport;
  private readonly handlers: LspClientHandlers;

  constructor(transport: LspTransport, handlers: LspClientHandlers) {
    this.transport = transport;
    this.handlers = handlers;
  }

  /// Send a request and wait for its response.
  ///
  /// `signal` is an `AbortSignal` rather than Monaco's `CancellationToken` so
  /// this module stays Monaco-free; the providers adapt one to the other in two
  /// lines. Aborting rejects the promise *and* tells the server to stop.
  request<T>(
    method: string,
    params: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new LspRequestError("language server is not running", 0));
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const settle = (fn: () => void) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => {
          this.cancel(id);
          this.handlers.onOutcome?.(false);
          reject(new LspRequestError(`${method} timed out after ${timeoutMs}ms`, 0));
        });
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      if (options.signal) {
        // A cancelled request is not a failure — it is Monaco superseding its
        // own query — so it never touches the health signal.
        const abort = () =>
          settle(() => {
            this.cancel(id);
            reject(new LspRequestError(`${method} cancelled`, REQUEST_CANCELLED));
          });
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      }

      void this.write({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        settle(() => {
          this.handlers.onOutcome?.(false);
          reject(e);
        });
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    void this.write({ jsonrpc: "2.0", method, params }).catch(() => {
      // A notification that cannot be delivered means the server is gone,
      // which the exit event already reports. Nothing to add here.
    });
  }

  /// Feed one raw message from the server.
  ///
  /// Never throws: this is called from an event listener, and a malformed
  /// message from a server must not take the listener — and with it every
  /// other session's delivery — down.
  receive(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      console.warn("[lsp] unparsable message from server", raw.slice(0, 200));
      return;
    }

    // A response: has an id and no method.
    if (message.method === undefined && message.id !== undefined && message.id !== null) {
      const entry = this.pending.get(message.id);
      if (!entry) return; // Already timed out or cancelled.
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) {
        // A cancellation acknowledged by the server is the expected end of a
        // superseded request, not a sign of ill health.
        this.handlers.onOutcome?.(message.error.code === REQUEST_CANCELLED);
        entry.reject(new LspRequestError(message.error.message, message.error.code));
        return;
      }
      this.handlers.onOutcome?.(true);
      entry.resolve(message.result);
      return;
    }

    if (!message.method) return;

    // A request: has both a method and an id, and must be answered.
    if (message.id !== undefined && message.id !== null) {
      let result: unknown;
      try {
        result = this.handlers.onRequest?.(message.method, message.params);
      } catch {
        result = undefined;
      }
      void this.write(
        result === undefined
          ? {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: METHOD_NOT_FOUND, message: `${message.method} is not supported` },
            }
          : { jsonrpc: "2.0", id: message.id, result },
      ).catch(() => {});
      return;
    }

    try {
      this.handlers.onNotification(message.method, message.params);
    } catch (e) {
      // A handler that throws must not stop the next notification arriving.
      console.warn("[lsp] notification handler failed", message.method, e);
    }
  }

  /// Reject everything in flight and refuse new work. Called when the session
  /// ends, so no provider is left holding a promise against a dead process.
  dispose(reason: string): void {
    this.disposed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new LspRequestError(reason, 0));
    }
    this.pending.clear();
  }

  /// Requests still waiting. Only used by tests and the log header.
  get inFlight(): number {
    return this.pending.size;
  }

  private cancel(id: JsonRpcId): void {
    if (this.disposed) return;
    void this.write({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }).catch(() => {});
  }

  private write(message: JsonRpcMessage): Promise<void> {
    return this.transport.send(JSON.stringify(message));
  }
}
