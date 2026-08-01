import { For, Show, createMemo, createSignal } from "solid-js";
import { Check, Plus, RotateCcw, X } from "lucide-solid";
import {
  addHillScope,
  hillScopes,
  moveHillScope,
  removeHillScope,
  setHillScopeDone,
} from "@/store/hills";
import {
  PHASE_LABELS,
  compareScopes,
  hillPath,
  phaseOf,
  pointAt,
  stalledDays,
  type HillScope,
} from "./hillModel";

/// Hill charts, rendered and draggable.
///
/// See `hillModel.ts` for why the dot is moved by hand and never inferred. Two
/// things this component is responsible for beyond drawing:
///
///   1. **The dot is a `slider`.** Not decoration with a mouse handler — an
///      ARIA slider with arrow-key control. A hill you can only move by dragging
///      is a hill somebody on a trackpad, or on a keyboard, cannot move; and
///      "cannot record progress" is a worse failure than "chart looks nice".
///   2. **The move is committed once.** Dragging emits a position on every
///      pointer move and the *store* would record every one of them. So the drag
///      writes to local state and commits on release. (`moveHillScope` also
///      ignores a no-op move, so a slipped click costs nothing either.)
interface HillsSectionProps {
  workspaceId: string;
  /// The repository the log event is filed under. The workspace's active
  /// checkout; absent when it has none.
  repoPath?: string;
}

/// Drawing box. Fixed rather than measured: a hill is a diagram, not a
/// visualisation that gains anything from being wider, and measuring it would
/// pull `ResizeObserver` into every render test for no benefit.
const W = 320;
const H = 68;
/// Arrow-key step. A twentieth of the hill — coarse enough that crossing the
/// crest takes a deliberate number of presses.
const STEP = 0.05;

const PATH = hillPath(W, H);

function HillChart(props: {
  scope: HillScope;
  /// The position being dragged, when one is. Separate from the scope's own so
  /// the store is not written on every pointer move.
  preview: number | null;
  onPreview: (position: number | null) => void;
  onCommit: (position: number) => void;
}) {
  const position = () => props.preview ?? props.scope.position;
  const dot = createMemo(() => pointAt(position(), W, H));

  const positionFrom = (clientX: number, target: SVGSVGElement) => {
    const box = target.getBoundingClientRect();
    // A zero-width box means the element is not laid out (jsdom, or a hidden
    // pane). Dividing by it yields Infinity, which `clampPosition` would turn
    // into a silent jump to the end of the hill.
    if (box.width <= 0) return position();
    return (clientX - box.left) / box.width;
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      class="w-full h-16 touch-none select-none"
      role="presentation"
      onPointerMove={(e) => {
        if (props.preview === null) return;
        props.onPreview(positionFrom(e.clientX, e.currentTarget));
      }}
      onPointerUp={() => {
        if (props.preview !== null) props.onCommit(props.preview);
        props.onPreview(null);
      }}
      onPointerLeave={() => {
        // Committing on leave rather than discarding: the pointer leaving the
        // box mid-drag is a common way to finish one, and throwing the move
        // away would read as the drag not having worked.
        if (props.preview !== null) props.onCommit(props.preview);
        props.onPreview(null);
      }}
    >
      <path d={PATH} class="stroke-border" fill="none" stroke-width="1.5" />
      <line
        x1={W / 2}
        y1="0"
        x2={W / 2}
        y2={H}
        class="stroke-border"
        stroke-width="1"
        stroke-dasharray="2 3"
      />
      <circle
        cx={dot().x}
        cy={dot().y}
        r="6"
        role="slider"
        tabindex="0"
        aria-label={`${props.scope.name} position on the hill`}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(position() * 100)}
        aria-valuetext={PHASE_LABELS[phaseOf({ position: position(), done: props.scope.done })]}
        class="cursor-grab focus-visible:outline-none"
        classList={{
          "fill-muted-foreground": props.scope.done,
          "fill-primary": !props.scope.done,
        }}
        onPointerDown={(e) => {
          e.currentTarget.ownerSVGElement?.setPointerCapture?.(e.pointerId);
          props.onPreview(props.scope.position);
        }}
        onKeyDown={(e) => {
          const delta =
            e.key === "ArrowRight" || e.key === "ArrowUp"
              ? STEP
              : e.key === "ArrowLeft" || e.key === "ArrowDown"
                ? -STEP
                : e.key === "Home"
                  ? -1
                  : e.key === "End"
                    ? 1
                    : 0;
          if (delta === 0) return;
          e.preventDefault();
          props.onCommit(props.scope.position + delta);
        }}
      />
    </svg>
  );
}

export function HillsSection(props: HillsSectionProps) {
  const [draft, setDraft] = createSignal("");
  /// `scopeId → position` while a drag is in flight.
  const [preview, setPreview] = createSignal<Record<string, number>>({});

  const scopes = createMemo(() => [...hillScopes(props.workspaceId)].sort(compareScopes));

  const add = (e: Event) => {
    e.preventDefault();
    const id = addHillScope({
      workspaceId: props.workspaceId,
      name: draft(),
      repo: props.repoPath,
    });
    if (id) setDraft("");
  };

  const now = Date.now();

  return (
    <div class="flex flex-col flex-1 min-h-0">
      <form class="flex items-center gap-2 px-3 py-2 shrink-0" onSubmit={add}>
        <input
          type="text"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          placeholder="What are you working on?"
          aria-label="New scope"
          class="flex-1 min-w-0 px-2 py-1 text-body bg-muted/40 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          class="inline-flex items-center gap-1 px-2 py-1 text-body rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus class="w-3 h-3" aria-hidden="true" />
          Track it
        </button>
      </form>

      <div class="flex-1 min-h-0 overflow-y-auto px-3 pb-4">
        <Show
          when={scopes().length > 0}
          fallback={
            <p class="py-2 text-body text-muted-foreground">
              Nothing on the hill yet. A scope is a piece of work you can say you are either
              still figuring out or already executing — the chart exists to make that
              difference visible, which a percentage cannot.
            </p>
          }
        >
          <For each={scopes()}>
            {(scope) => {
              const stalled = stalledDays(scope, now);
              return (
                <section class="py-2 border-b border-border last:border-b-0">
                  <div class="flex items-center gap-2">
                    <h3
                      class="flex-1 min-w-0 truncate text-body"
                      classList={{
                        "line-through text-muted-foreground": scope.done,
                        "text-foreground": !scope.done,
                      }}
                    >
                      {scope.name}
                    </h3>
                    <span class="text-label text-muted-foreground">
                      {PHASE_LABELS[phaseOf(scope)]}
                    </span>
                    <Show when={stalled !== null && !scope.done}>
                      {/* A scope nobody has moved in days is the signal this
                          chart exists to produce. */}
                      <span
                        class="px-1 rounded bg-muted text-micro text-muted-foreground"
                        title="Nobody has moved this in a while"
                      >
                        {stalled}d still
                      </span>
                    </Show>
                    <button
                      type="button"
                      aria-label={scope.done ? `Reopen ${scope.name}` : `Finish ${scope.name}`}
                      onClick={() =>
                        setHillScopeDone({
                          workspaceId: props.workspaceId,
                          scopeId: scope.id,
                          done: !scope.done,
                          repo: props.repoPath,
                        })
                      }
                      class="p-1 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Show when={scope.done} fallback={<Check class="w-3 h-3" />}>
                        <RotateCcw class="w-3 h-3" />
                      </Show>
                    </button>
                    <button
                      type="button"
                      aria-label={`Stop tracking ${scope.name}`}
                      onClick={() =>
                        removeHillScope({
                          workspaceId: props.workspaceId,
                          scopeId: scope.id,
                          repo: props.repoPath,
                        })
                      }
                      class="p-1 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X class="w-3 h-3" />
                    </button>
                  </div>

                  <HillChart
                    scope={scope}
                    preview={preview()[scope.id] ?? null}
                    onPreview={(position) =>
                      setPreview((current) => {
                        const next = { ...current };
                        if (position === null) delete next[scope.id];
                        else next[scope.id] = position;
                        return next;
                      })
                    }
                    onCommit={(position) =>
                      moveHillScope({
                        workspaceId: props.workspaceId,
                        scopeId: scope.id,
                        position,
                        repo: props.repoPath,
                      })
                    }
                  />

                  {/* Axis labels, and decorative in the accessibility tree: the
                      dot already announces which half it is in as its
                      `aria-valuetext`, and a screen reader that also read these
                      would hear both phases named for every scope. */}
                  <div
                    class="flex justify-between text-micro text-muted-foreground"
                    aria-hidden="true"
                  >
                    <span>Figuring it out</span>
                    <span>Making it happen</span>
                  </div>
                </section>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}
