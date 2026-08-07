/// Pointer-driven drag and drop — every drag *inside* the app goes through here.
///
/// **Why not HTML5 drag-and-drop.** Tauri installs an OS-level drag destination
/// on the webview so the frontend can be handed real filesystem paths
/// (`onDragDropEvent`, which is how a Finder drop reaches `TerminalPane`). On
/// macOS that destination is a wry `NSView` override, and `draggingUpdated`
/// returns `NSDragOperationCopy` *without calling super* while Tauri's handler
/// reports every event as handled — so WebKit never sees the drag session and
/// the page never receives a single `dragover` or `drop`. Tauri documents the
/// same for Windows, where `dragDropEnabled` "must be disabled to allow HTML5
/// drag and drop on the frontend". Either way: an in-page HTML5 drag cannot
/// work while that handler is on, and turning it off would cost us the one
/// thing it provides that nothing else can — absolute paths for OS drops.
///
/// Pointer events are never intercepted by it. Three things follow that the
/// HTML5 API could not have given us anyway:
///
///   • **One active target, guaranteed.** Targets register a zone and the
///     controller hit-tests them itself, so exactly one is active at a time and
///     `leave` is always called on the one before it. A target cannot be left
///     holding an insertion caret for a drag that has moved on, which is the
///     entire class of bug `dragleave` is famous for.
///   • **Hit-testing by coordinate, not by DOM.** The browser tab's page is an
///     OS-level child webview composited *above* the DOM; a DOM drop target
///     underneath it is unreachable by hit-testing. A rect test does not care
///     what is painted on top. (`BrowserPane` still hides itself for the
///     duration so the preview is *visible* — but the drop lands either way.)
///   • **Cancellation that is distinguishable.** `Escape` ends the gesture as a
///     cancel, where HTML5 DnD reports it as a `dragend` identical to a
///     completed drop.
///
/// The gesture starts only after `DRAG_THRESHOLD_PX`, so a click on a tab is
/// still a click, and the click that would follow a real drag is swallowed.

import { createSignal, onCleanup } from "solid-js";

export interface Point {
  x: number;
  y: number;
}

/// What is in flight. One shape for every draggable thing in the app, because
/// the controller has to compare and route them without knowing what any of
/// them mean.
export interface DragPayload {
  /// Which family of drop target can accept this at all.
  /// `sidebar` is a whole docked panel travelling to another edge; its `id` is
  /// a `SidebarId`. It is a separate family from `workspace` (a row *inside*
  /// the rail) precisely so the rail's own reorder zone cannot accept the rail.
  kind: "tab" | "tabgroup" | "workspace" | "card" | "path" | "sidebar";
  /// The dragged thing's own id — a tab id, a workspace id, a card id.
  id: string;
  /// What the ghost calls it.
  label: string;
  /// Tab drags: the tab's kind (`terminal`, `compare`, …), which decides which
  /// store array a reorder touches.
  tabKind?: string;
  /// Tab drags: the pane group the drag started in, or `null` in a window that
  /// has no pane groups. A drop in a different group is a *move*.
  paneGroupId?: string | null;
  /// Tab-group drags: the group travelling as a unit. `id` is its first member,
  /// so a target that only understands tabs still behaves.
  tabGroupId?: string;
  /// Path drags (the file tree): the absolute path.
  path?: string;
}

/// A registered drop target.
export interface DropZone {
  /// Unique per mounted target. `registerDropZone` overwrites on collision, so
  /// a duplicated id silently loses a target — mint it from a component id.
  id: string;
  /// The element whose rect *is* the zone. Read on every move, so a zone that
  /// moves or resizes mid-drag needs no invalidation.
  el: () => HTMLElement | undefined;
  /// Higher wins when zones overlap. A tab strip sits over its own pane body,
  /// so the strip is 2 and the body is 1. Equal priorities resolve to the
  /// smaller rect, which is the inner target.
  priority?: number;
  accepts: (payload: DragPayload) => boolean;
  /// Called on every move while the pointer is inside. Returns the sentence the
  /// ghost should show, or `null` to refuse *this point* — the zone stays
  /// active (so it can keep drawing), but a release does nothing.
  over: (payload: DragPayload, at: Point) => string | null;
  drop: (payload: DragPayload, at: Point) => void;
  /// The pointer moved to a different zone, or the drag ended. Always called
  /// exactly once per `over` run.
  leave?: () => void;
}

/// How far the pointer must travel before a press becomes a drag. Below it the
/// gesture is a click and the target never hears about it.
const DRAG_THRESHOLD_PX = 4;

const [payload, setPayload] = createSignal<DragPayload | null>(null);
const [pointer, setPointer] = createSignal<Point | null>(null);
const [action, setAction] = createSignal<string | null>(null);

/// What is being dragged, or `null`. Drop targets subscribe to it so overlays
/// exist only for the duration of a drag — a permanently mounted one would eat
/// every click in the pane underneath.
export const activeDrag = payload;
/// Where the pointer is, in viewport coordinates, for as long as a drag lasts.
export const dragPointer = pointer;
/// What releasing right now would do, in a sentence — published by whichever
/// zone is active. `null` means nothing would happen.
export const dropActionLabel = action;
export const isDragging = () => payload() !== null;

const zones = new Map<string, DropZone>();

/// Register for the life of the calling component.
export function registerDropZone(zone: DropZone): void {
  zones.set(zone.id, zone);
  onCleanup(() => {
    if (zones.get(zone.id) === zone) zones.delete(zone.id);
  });
}

/// The zone under `at` that should own the drag: highest priority, then
/// smallest rect. A zone whose element has gone (or measures zero, which is
/// what a hidden pane measures at) is not a candidate.
function hitTest(at: Point, p: DragPayload): DropZone | null {
  let best: DropZone | null = null;
  let bestPriority = -Infinity;
  let bestArea = Infinity;
  for (const zone of zones.values()) {
    if (!zone.accepts(p)) continue;
    const el = zone.el();
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (at.x < r.left || at.x >= r.right || at.y < r.top || at.y >= r.bottom) continue;
    const priority = zone.priority ?? 0;
    const area = r.width * r.height;
    if (priority > bestPriority || (priority === bestPriority && area < bestArea)) {
      best = zone;
      bestPriority = priority;
      bestArea = area;
    }
  }
  return best;
}

/// The in-flight gesture. Module-scoped because there is exactly one pointer
/// and therefore at most one of these.
interface Session {
  payload: DragPayload;
  origin: Point;
  pointerId: number;
  source: HTMLElement;
  started: boolean;
  zone: DropZone | null;
  /// Whether the active zone accepted the *current* point. A refused point
  /// still keeps the zone active so it can keep drawing its own state.
  armed: boolean;
  priorCursor: string;
  priorSelect: string;
}

let session: Session | null = null;

/// Begin a drag from a pointer-down. Safe to call on any `pointerdown`: nothing
/// happens until the pointer has moved `DRAG_THRESHOLD_PX`, so this never
/// competes with the click handler on the same element.
///
/// The caller keeps its own click/select behaviour; all this does is watch.
export function beginDrag(e: PointerEvent, item: DragPayload): void {
  if (e.button !== 0) return;
  if (session) endSession(false);
  const source = e.currentTarget as HTMLElement | null;
  if (!source) return;
  session = {
    payload: item,
    origin: { x: e.clientX, y: e.clientY },
    pointerId: e.pointerId,
    source,
    started: false,
    zone: null,
    armed: false,
    priorCursor: "",
    priorSelect: "",
  };
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
  window.addEventListener("keydown", onKeyDown, true);
}

function onPointerMove(e: PointerEvent) {
  const s = session;
  if (!s || e.pointerId !== s.pointerId) return;
  const at = { x: e.clientX, y: e.clientY };

  if (!s.started) {
    const dx = at.x - s.origin.x;
    const dy = at.y - s.origin.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    s.started = true;
    // Capture *now* rather than at pointer-down: capturing early would retarget
    // the events a plain click depends on.
    try {
      s.source.setPointerCapture(s.pointerId);
    } catch {
      // A source removed between press and threshold. The window listeners are
      // what actually drive the drag, so it still works.
    }
    s.priorCursor = document.body.style.cursor;
    s.priorSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    // A drag that selects the text it sweeps across leaves the window looking
    // like the drop went wrong even when it went right.
    document.body.style.userSelect = "none";
    setPayload(s.payload);
  }

  // Suppress the browser's own text selection for the rest of the gesture.
  e.preventDefault();
  setPointer(at);

  const next = hitTest(at, s.payload);
  if (next !== s.zone) {
    s.zone?.leave?.();
    s.zone = next;
  }
  if (!next) {
    s.armed = false;
    setAction(null);
    return;
  }
  const label = next.over(s.payload, at);
  s.armed = label !== null;
  setAction(label);
}

function onPointerUp(e: PointerEvent) {
  const s = session;
  if (!s || e.pointerId !== s.pointerId) return;
  const at = { x: e.clientX, y: e.clientY };
  const dropped = s.started && s.armed && s.zone !== null;
  if (dropped) {
    // Before teardown: a zone's `drop` may unmount the very overlay this
    // gesture was drawn on, and it must not see a half-cleared drag.
    s.zone!.drop(s.payload, at);
  }
  endSession(s.started);
}

function onPointerCancel(e: PointerEvent) {
  const s = session;
  if (!s || e.pointerId !== s.pointerId) return;
  endSession(s.started);
}

function onKeyDown(e: KeyboardEvent) {
  if (!session || e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  endSession(session.started);
}

/// End the gesture, from wherever it ended — a drop, a cancel, `Escape`, the
/// source unmounting. Idempotent, and it has to be: every exit routes here.
function endSession(swallowClick: boolean) {
  const s = session;
  session = null;
  window.removeEventListener("pointermove", onPointerMove, true);
  window.removeEventListener("pointerup", onPointerUp, true);
  window.removeEventListener("pointercancel", onPointerCancel, true);
  window.removeEventListener("keydown", onKeyDown, true);
  if (s) {
    s.zone?.leave?.();
    if (s.started) {
      document.body.style.cursor = s.priorCursor;
      document.body.style.userSelect = s.priorSelect;
      try {
        s.source.releasePointerCapture(s.pointerId);
      } catch {
        // Already released, or the source is gone. Nothing to undo.
      }
    }
  }
  setPayload(null);
  setPointer(null);
  setAction(null);
  if (swallowClick) armClickGuard();
}

/// How long after a drag ends a `click` is still assumed to belong to it.
///
/// A real drag is followed by a `click` — pointer capture retargets it to the
/// source — which would select the very tab the user just dragged away. But the
/// click is not *guaranteed*: if `setPointerCapture` failed, or the release
/// landed somewhere that generates none, nothing follows at all.
///
/// So the guard is a deadline rather than an add-then-remove pair. Removing the
/// listener on a timer races the browser's own input dispatch — a `setTimeout(0)`
/// task can be scheduled before or after the click, and losing that race means
/// either the drag selects a tab or the guard survives to eat an unrelated
/// click later. A timestamp cannot lose it: at most one click is swallowed, and
/// only if it arrives inside the window.
const CLICK_GUARD_MS = 300;

let clickGuardInstalled = false;
let suppressClickUntil = 0;

function armClickGuard() {
  suppressClickUntil = Date.now() + CLICK_GUARD_MS;
  if (clickGuardInstalled || typeof window === "undefined") return;
  clickGuardInstalled = true;
  window.addEventListener(
    "click",
    (e) => {
      if (Date.now() > suppressClickUntil) return;
      suppressClickUntil = 0;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
}

/// Cancel any drag in flight. For hosts that need to abort one for a reason of
/// their own — a worktree switching out from under it, a window closing.
///
/// It disarms the click guard too. A cancel says "forget this gesture
/// happened", and a pending guard is part of the gesture: leaving it armed
/// would eat the next click for up to `CLICK_GUARD_MS` on behalf of a drag that
/// no longer exists.
export function cancelDrag(): void {
  if (session) endSession(false);
  suppressClickUntil = 0;
}

/// Which of `rows` the pointer is in front of, along one axis.
///
/// Shared because both tab strips and the board answer the same question:
/// given a row of boxes and a point, which box does an insertion land before?
/// A row is "passed" once the pointer is beyond its midpoint, so the caret sits
/// where the eye expects rather than flipping at the box's leading edge.
/// Returns `rows.length` for "after everything".
export function insertionIndex(
  rows: readonly DOMRect[],
  at: Point,
  axis: "x" | "y",
): number {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const mid = axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2;
    if ((axis === "x" ? at.x : at.y) < mid) return i;
  }
  return rows.length;
}
