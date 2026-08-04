/// Three ways to look at an image that changed.
///
/// A picture has no lines, so none of the diff machinery applies: the only
/// useful question is "what moved", and the three modes answer it differently.
///
///   * **Side by side** — the default, and the only one that shows both
///     images whole. Right for "is this the same asset at a different size".
///   * **Swipe** — one image over the other, revealed by a divider you drag.
///     Right for a re-export or a retouch, where the change is a few pixels
///     and two images a hand-width apart cannot be compared by eye.
///   * **Onion skin** — the two cross-faded at a ratio you drag. Right for
///     alignment: a logo nudged two pixels reads instantly as a double image
///     at 50% and is invisible in either of the other two.
///
/// Motion doctrine (see `components/layout/ViewSwitcher.tsx`): both the swipe
/// and the onion slider are *pointer-driven*, one-to-one with the drag, with
/// no transition on the property being dragged. The movement is the reading —
/// the divider is at 60% because your finger is at 60% — so it carries
/// information. Nothing here animates on its own; there is no crossfade on
/// mode change, because a crossfade between two pictures of the same thing
/// would be indistinguishable from the onion mode it is not.
///
/// Mode is local state, not a preference: which question you are asking
/// changes per image, and persisting the answer would hand the next image the
/// previous one's question.

import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { Columns2, Layers, SplitSquareHorizontal } from "lucide-solid";
import { dataUrl, formatBytes, type ImageDiffPlan } from "./imageDiff";

export interface ImageSide {
  base64: string;
  byteLen: number;
}

type Mode = "side-by-side" | "swipe" | "onion";

const MODES: { id: Mode; label: string; icon: typeof Columns2; hint: string }[] = [
  {
    id: "side-by-side",
    label: "Side by side",
    icon: Columns2,
    hint: "Both images whole, next to each other",
  },
  {
    id: "swipe",
    label: "Swipe",
    icon: SplitSquareHorizontal,
    hint: "Drag the divider to reveal the new image over the old",
  },
  {
    id: "onion",
    label: "Onion skin",
    icon: Layers,
    hint: "Drag to cross-fade — a shifted element reads as a double image",
  },
];

export function ImageDiffView(props: {
  plan: ImageDiffPlan;
  old: ImageSide | null;
  new: ImageSide | null;
  /// A side existed but was over the read ceiling. Says "too large" instead of
  /// letting a missing side read as "deleted".
  oversize?: boolean;
}) {
  const [mode, setMode] = createSignal<Mode>("side-by-side");

  const oldUrl = createMemo(() =>
    props.old ? dataUrl(props.plan.kind, props.old.base64) : null,
  );
  const newUrl = createMemo(() =>
    props.new ? dataUrl(props.plan.kind, props.new.base64) : null,
  );

  /// Overlay modes need both pictures. With only one there is nothing to
  /// reveal or fade to, so they are not offered rather than offered and inert.
  const bothSides = () => oldUrl() !== null && newUrl() !== null;

  return (
    <div class="absolute inset-0 flex flex-col min-h-0">
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0 text-label">
        <Show when={props.old}>
          {(o) => (
            <span class="text-muted-foreground tabular-nums">
              old <span class="text-destructive">{formatBytes(o().byteLen)}</span>
            </span>
          )}
        </Show>
        <Show when={props.old && props.new}>
          <span class="text-muted-foreground/60">→</span>
        </Show>
        <Show when={props.new}>
          {(n) => (
            <span class="text-muted-foreground tabular-nums">
              new <span class="text-success">{formatBytes(n().byteLen)}</span>
            </span>
          )}
        </Show>
        <div
          role="group"
          aria-label="Image comparison mode"
          class="ml-auto flex items-center gap-0.5 rounded-md border border-border p-0.5"
        >
          <For each={MODES}>
            {(m) => {
              const disabled = () => m.id !== "side-by-side" && !bothSides();
              return (
                <button
                  onClick={() => setMode(m.id)}
                  disabled={disabled()}
                  aria-pressed={mode() === m.id}
                  aria-label={m.label}
                  title={
                    disabled()
                      ? `${m.label} needs both versions — this file has only one`
                      : m.hint
                  }
                  class={`flex items-center gap-1 px-2 py-0.5 text-label rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    mode() === m.id
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                  }`}
                >
                  <m.icon class="w-3 h-3" />
                  {m.label}
                </button>
              );
            }}
          </For>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-auto scrollbar-thin p-4">
        <Show when={props.oversize}>
          <p class="mb-3 text-body text-muted-foreground">
            One side of this file is too large to load. Only what fits is shown.
          </p>
        </Show>
        <Show
          when={oldUrl() || newUrl()}
          fallback={
            <p class="text-body text-muted-foreground italic">
              Neither version of this file could be read.
            </p>
          }
        >
          <Show when={mode() === "side-by-side" || !bothSides()}>
            <SideBySide old={oldUrl()} new={newUrl()} />
          </Show>
          <Show when={mode() === "swipe" && bothSides()}>
            <Overlay old={oldUrl()!} new={newUrl()!} kind="swipe" />
          </Show>
          <Show when={mode() === "onion" && bothSides()}>
            <Overlay old={oldUrl()!} new={newUrl()!} kind="onion" />
          </Show>
        </Show>
      </div>
    </div>
  );
}

function SideBySide(props: { old: string | null; new: string | null }) {
  return (
    <div class="grid grid-cols-2 gap-4">
      <Pane label="Old" tone="destructive" src={props.old} absent="Added — there was no old version." />
      <Pane label="New" tone="success" src={props.new} absent="Deleted — there is no new version." />
    </div>
  );
}

function Pane(props: {
  label: string;
  tone: "destructive" | "success";
  src: string | null;
  absent: string;
}) {
  return (
    <div class="flex flex-col gap-1 min-w-0">
      <span
        class={`text-micro tracking-wide ${
          props.tone === "destructive" ? "text-destructive" : "text-success"
        }`}
      >
        {props.label}
      </span>
      <Show
        when={props.src}
        fallback={<p class="text-body text-muted-foreground italic">{props.absent}</p>}
      >
        {(src) => (
          <img
            src={src()}
            alt={`${props.label} version`}
            // `checkerboard` is the app's transparency backdrop: a PNG with an
            // alpha channel on a plain background is indistinguishable from
            // one with a white matte, and which of those it is *is* often the
            // change being reviewed.
            class="max-w-full h-auto object-contain rounded border border-border bg-[repeating-conic-gradient(theme(colors.muted.DEFAULT)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]"
          />
        )}
      </Show>
    </div>
  );
}

/// Swipe and onion share everything but what the drag controls, so they share
/// a component: both stack the two images at identical size and both map a
/// horizontal pointer position to one number in [0, 1].
function Overlay(props: { old: string; new: string; kind: "swipe" | "onion" }) {
  const [ratio, setRatio] = createSignal(0.5);
  const [dragging, setDragging] = createSignal(false);
  let host: HTMLDivElement | undefined;

  function positionFrom(clientX: number) {
    if (!host) return;
    const box = host.getBoundingClientRect();
    if (box.width === 0) return;
    setRatio(Math.min(1, Math.max(0, (clientX - box.left) / box.width)));
  }

  function onPointerDown(e: PointerEvent) {
    // Capture on the host, so a drag that leaves the image keeps steering it
    // instead of stopping at the edge — the difference between a control you
    // can throw to 0% and one you have to creep to.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    positionFrom(e.clientX);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging()) return;
    positionFrom(e.clientX);
  }

  function endDrag(e: PointerEvent) {
    if (!dragging()) return;
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  /// Keyboard steering, in the same units. A comparison control that only a
  /// mouse can move is a comparison only a mouse user can make.
  function onKeyDown(e: KeyboardEvent) {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft") setRatio((r) => Math.max(0, r - step));
    else if (e.key === "ArrowRight") setRatio((r) => Math.min(1, r + step));
    else if (e.key === "Home") setRatio(0);
    else if (e.key === "End") setRatio(1);
    else return;
    e.preventDefault();
  }

  onCleanup(() => setDragging(false));

  const pct = () => `${(ratio() * 100).toFixed(1)}%`;

  return (
    <div class="flex flex-col gap-2 items-start">
      <div
        ref={host}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        role="slider"
        tabindex={0}
        aria-label={props.kind === "swipe" ? "Swipe position" : "Onion-skin blend"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio() * 100)}
        aria-valuetext={
          props.kind === "swipe"
            ? `${Math.round(ratio() * 100)}% of the new version shown`
            : `${Math.round(ratio() * 100)}% new, ${100 - Math.round(ratio() * 100)}% old`
        }
        class={`relative inline-block select-none touch-none rounded border border-border overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          props.kind === "swipe" ? "cursor-ew-resize" : "cursor-ew-resize"
        }`}
      >
        {/* The old image sizes the box; the new one is absolutely positioned
            over it at the same size. Two images of different dimensions then
            overlay honestly — a resize shows as the new one not filling the
            frame, rather than as the box changing shape mid-drag. */}
        <img src={props.old} alt="Old version" class="block max-w-full h-auto pointer-events-none" />
        <img
          src={props.new}
          alt="New version"
          class="absolute inset-0 w-full h-full object-contain pointer-events-none"
          style={
            props.kind === "swipe"
              ? // No transition: the reveal is the drag. A tween here would put
                // the divider somewhere the pointer is not, which is the exact
                // failure the motion doctrine names.
                { "clip-path": `inset(0 0 0 ${pct()})` }
              : { opacity: ratio() }
          }
        />
        <Show when={props.kind === "swipe"}>
          <div
            class="absolute top-0 bottom-0 w-px bg-primary pointer-events-none"
            style={{ left: pct() }}
          />
        </Show>
      </div>
      <p class="text-micro text-muted-foreground tabular-nums">
        <Show
          when={props.kind === "swipe"}
          fallback={<>{Math.round(ratio() * 100)}% new over old — drag, or use ← →</>}
        >
          old ┃ new at {Math.round(ratio() * 100)}% — drag, or use ← →
        </Show>
      </p>
    </div>
  );
}
