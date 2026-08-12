/// The tab strip's overflow chevron and cross-group drag, mounted in a real
/// browser.
///
/// Two things here have no jsdom equivalent, for two different reasons.
///
/// **Overflow** is measured with `scrollWidth > clientWidth + 1` after a real
/// `ResizeObserver` fires (`recomputeOverflow` in `TabStrip.tsx`). jsdom
/// reports `0` for both of those on every element and never fires a resize
/// callback — `src/test/setup.ts` stubs `ResizeObserver` to a no-op specifically
/// so components that construct one do not throw during mount. A render test
/// against this control would either always see the chevron or never see it,
/// regardless of whether the strip actually overflowed.
///
/// **Cross-group drag** is resolved entirely from `getBoundingClientRect` now:
/// the strip is one drop zone and it works out *where* a release lands by
/// measuring the rows it rendered. jsdom reports a zero rect for every element,
/// so every drop position in the app would resolve to the same slot and none of
/// these assertions could fail.
///
/// The gesture is pointer events rather than HTML5 drag-and-drop — see
/// `dragDrop.ts` for why it has to be — so the helpers below drive
/// `pointerdown` / `pointermove` / `pointerup` directly.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { cancelDrag } from "./dragDrop";
import {
  DragGhost,
  PaneDropOverlay,
  TabStrip,
  type TabDescriptor,
  type TabKind,
} from "./TabStrip";

/// Drive a drag. The first move has to clear `DRAG_THRESHOLD_PX` or the
/// controller treats the whole thing as a click and never starts — which is the
/// property that lets a tab still be clicked at all.
function press(source: Element, at: { x: number; y: number }) {
  source.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: at.x,
      clientY: at.y,
    }),
  );
}

function moveTo(at: { x: number; y: number }) {
  window.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      buttons: 1,
      clientX: at.x,
      clientY: at.y,
    }),
  );
}

function release(at: { x: number; y: number }) {
  window.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      buttons: 0,
      clientX: at.x,
      clientY: at.y,
    }),
  );
}

/// The centre of an element, in viewport coordinates.
function centre(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/// A point just inside an element's leading edge — where an insertion lands
/// *before* it, since `insertionIndex` splits each row at its midpoint.
function leadingEdge(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left + 2, y: r.top + r.height / 2 };
}

function tab(id: string, kind: TabKind = "file"): TabDescriptor {
  return {
    kind,
    id,
    label: id,
    icon: (<span data-testid={`icon-${id}`} />) as JSX.Element,
    title: id,
    pinnable: true,
    draggable: true,
  };
}

function baseProps(tabs: TabDescriptor[]) {
  return {
    tabs,
    activeId: tabs[0]?.id ?? null,
    isPinned: () => false,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onReorder: vi.fn(),
    onTogglePin: vi.fn(),
  };
}

describe("overflow: the chevron reflects real scrollWidth vs clientWidth", () => {
  it("shows the overflow chevron once real tab width exceeds a narrow strip", async () => {
    const tabs = Array.from({ length: 15 }, (_, i) => tab(`file-${i}.ts`));
    render(() => (
      <div style={{ width: "220px" }}>
        <TabStrip {...baseProps(tabs)} />
      </div>
    ));

    // The ResizeObserver in `TabStrip.tsx` fires asynchronously; `waitFor`
    // gives it the tick jsdom's stub never would have needed because it never
    // fires at all.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /show all tabs/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /show all tabs/i })).toHaveTextContent("15");
  });

  it("shows no chevron for the identical tabs once the strip is wide enough", async () => {
    const tabs = Array.from({ length: 15 }, (_, i) => tab(`file-${i}.ts`));
    render(() => (
      <div style={{ width: "3000px" }}>
        <TabStrip {...baseProps(tabs)} />
      </div>
    ));

    // Same tabs, same component, only the container's real width differs —
    // isolating overflow detection from everything else the strip does.
    await waitFor(() => expect(screen.getByText("file-0.ts")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /show all tabs/i })).not.toBeInTheDocument();
  });
});

/// The vertical strip belongs in the browser project for the same reason
/// overflow does: both of its claims are about real geometry. jsdom reports 0
/// for `scrollHeight`, `clientHeight`, `offsetTop` and `offsetHeight` alike, so
/// a render test could not tell a column from a row.
describe("vertical orientation", () => {
  it("overflows down its own axis rather than across", async () => {
    const tabs = Array.from({ length: 15 }, (_, i) => tab(`file-${i}.ts`));
    render(() => (
      // Tall enough that a *row* of these tabs would overflow and a column of
      // them would not: the assertion only holds if the strip switched axes.
      <div style={{ width: "220px", height: "2000px", display: "flex" }}>
        <TabStrip {...baseProps(tabs)} orientation="vertical" width={220} />
      </div>
    ));

    await waitFor(() => expect(screen.getByText("file-0.ts")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /show all tabs/i })).not.toBeInTheDocument();
  });

  it("puts the active indicator on the vertical axis, at the active card", async () => {
    const tabs = [tab("first.ts"), tab("second.ts"), tab("third.ts")];
    render(() => (
      <div style={{ width: "220px", height: "600px", display: "flex" }}>
        <TabStrip
          {...baseProps(tabs)}
          activeId="third.ts"
          orientation="vertical"
          width={220}
        />
      </div>
    ));

    const rule = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-motion="tab-indicator"]');
      expect(el).not.toBeNull();
      return el!;
    });

    // A vertical rule is placed by `translateY` and sized by `height`; the
    // horizontal one is the transpose. Asserting both is what catches a
    // half-converted indicator, which renders as a 0×0 element that is easy to
    // miss by eye.
    await waitFor(() => expect(rule.style.transform).toMatch(/translateY\((?!0px)/));
    expect(rule.style.height).not.toBe("0px");
    expect(rule.style.width).toBe("");
  });

  it("gives a vertical tab the column's width instead of the row's 140px cap", async () => {
    const long = tab("a/very/deeply/nested/path/to/a/component.tsx");
    render(() => (
      <div style={{ width: "300px", height: "400px", display: "flex" }}>
        <TabStrip {...baseProps([long])} orientation="vertical" width={300} />
      </div>
    ));

    const label = await waitFor(() => screen.getByText(long.label));
    // The single reason to want vertical tabs. A row caps the label at 140px;
    // in a 300px column it must be free to use what is there.
    expect(label.getBoundingClientRect().width).toBeGreaterThan(140);
  });

  /// The "+" used to be pinned under the tab list. In a column that is the
  /// wrong end: the list grows downward, so the control the user reaches for
  /// to add to it moves further away the more they have added.
  it("puts the controls above the tabs in a column, and after them in a row", async () => {
    const tabs = [tab("first.ts"), tab("second.ts")];
    const trailing = <button aria-label="New tab">+</button>;

    const vertical = render(() => (
      <div style={{ width: "220px", height: "600px", display: "flex" }}>
        <TabStrip {...baseProps(tabs)} orientation="vertical" width={220} trailing={trailing} />
      </div>
    ));
    const vControls = await waitFor(() =>
      vertical.container.querySelector<HTMLElement>('[data-testid="tab-strip-controls"]')!,
    );
    const vScroller = vertical.container.querySelector<HTMLElement>(
      '[data-testid="tab-strip-scroller"]',
    )!;
    expect(vControls.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      vScroller.getBoundingClientRect().top,
    );
    // DOM order, not just pixels: a CSS `order` swap would satisfy the rect
    // above while leaving tab order and screen readers pointing the old way.
    expect(vControls.compareDocumentPosition(vScroller) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    vertical.unmount();

    // A row is unchanged: the controls still trail the tabs at its right end.
    const horizontal = render(() => (
      <div style={{ width: "600px", display: "flex" }}>
        <TabStrip {...baseProps(tabs)} trailing={trailing} />
      </div>
    ));
    const hControls = await waitFor(() =>
      horizontal.container.querySelector<HTMLElement>('[data-testid="tab-strip-controls"]')!,
    );
    const hScroller = horizontal.container.querySelector<HTMLElement>(
      '[data-testid="tab-strip-scroller"]',
    )!;
    expect(hControls.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      hScroller.getBoundingClientRect().left,
    );
    expect(hScroller.compareDocumentPosition(hControls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("drag between groups", () => {
  beforeEach(cancelDrag);

  it("moves a tab from one pane group's strip onto another's", () => {
    const onMoveTabA = vi.fn();
    const onMoveTabB = vi.fn();

    render(() => (
      <div style={{ display: "flex" }}>
        <div style={{ width: "400px" }}>
          <TabStrip {...baseProps([tab("a1")])} groupId="group-a" onMoveTab={onMoveTabA} />
        </div>
        <div style={{ width: "400px" }}>
          <TabStrip {...baseProps([tab("b1")])} groupId="group-b" onMoveTab={onMoveTabB} />
        </div>
      </div>
    ));

    const target = leadingEdge(screen.getByTitle("b1"));
    press(screen.getByTitle("a1"), centre(screen.getByTitle("a1")));
    moveTo(target);
    release(target);

    // The strip the tab landed *on* is the one whose `onMoveTab` fires — group
    // A, which the drag started in, gets nothing.
    expect(onMoveTabB).toHaveBeenCalledTimes(1);
    const [payload, beforeTabId] = onMoveTabB.mock.calls[0];
    expect(payload).toMatchObject({ kind: "tab", id: "a1", paneGroupId: "group-a" });
    // Released on b1's leading half, so it lands in front of b1 rather than
    // wherever the strip happened to end.
    expect(beforeTabId).toBe("b1");
    expect(onMoveTabA).not.toHaveBeenCalled();
  });

  /// Reordering inside one strip — the oldest thing the strip does, and the
  /// case a cross-pane test does not touch at all.
  it("reorders within a strip, anchored on the tab the pointer is in front of", () => {
    const props = baseProps([tab("a", "terminal"), tab("b", "terminal"), tab("c", "terminal")]);
    render(() => (
      <div style={{ width: "800px" }}>
        <TabStrip {...props} groupId="group-a" onMoveTab={vi.fn()} />
      </div>
    ));

    const target = leadingEdge(screen.getByTitle("a"));
    press(screen.getByTitle("c"), centre(screen.getByTitle("c")));
    moveTo(target);
    release(target);

    expect(props.onReorder).toHaveBeenCalledWith("terminal", "c", "a");
  });

  /// The anchor has to be of the dragged tab's own kind: `onReorder` moves a
  /// tab within its kind's store array, and a tab of another kind is not in
  /// that array to be positioned against.
  it("anchors a reorder on the next tab of the same kind, not the next tab", () => {
    const props = baseProps([
      tab("cmp", "compare"),
      tab("t1", "terminal"),
      tab("t2", "terminal"),
    ]);
    render(() => (
      <div style={{ width: "800px" }}>
        <TabStrip {...props} groupId="group-a" onMoveTab={vi.fn()} />
      </div>
    ));

    // Dropped in front of the compare tab, which a terminal cannot be ordered
    // against — so the anchor walks on to the first terminal at or after it.
    const target = leadingEdge(screen.getByTitle("cmp"));
    press(screen.getByTitle("t2"), centre(screen.getByTitle("t2")));
    moveTo(target);
    release(target);

    expect(props.onReorder).toHaveBeenCalledWith("terminal", "t2", "t1");
  });

  it("is a click, not a drag, when the pointer never moves", () => {
    const props = baseProps([tab("a1")]);
    render(() => <TabStrip {...props} groupId="group-a" onMoveTab={vi.fn()} />);

    const card = screen.getByTitle("a1");
    press(card, centre(card));
    release(centre(card));
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    // Below the threshold the controller never starts, so the click that
    // follows is the user's and reaches `onSelect`.
    expect(props.onSelect).toHaveBeenCalledTimes(1);
  });
});

/// What the user asked for and the old per-tab drop targets could not express:
/// a group holding tabs of different kinds, in the order they were dropped.
///
/// Per-kind store arrays cannot represent that — a terminal and a compare tab
/// live in different lists — so the group's own `tabIds` is the only ordering
/// that can, and `onAssignTab` is the only call that writes it. The drop has to
/// make that call with a *position*, not just a membership.
describe("mixing kinds inside a tab group", () => {
  beforeEach(cancelDrag);

  it("drops a tab of another kind between two members, at that position", () => {
    const onAssignTab = vi.fn();
    const group = {
      id: "tg1",
      label: "Review",
      color: "chart-1" as const,
      collapsed: false,
      tabIds: ["term-1", "term-2"],
    };
    const tabs = [
      tab("term-1", "terminal"),
      tab("term-2", "terminal"),
      tab("cmp-1", "compare"),
    ];

    render(() => (
      <div style={{ width: "800px" }}>
        <TabStrip
          {...baseProps(tabs)}
          groupId="group-a"
          tabGroups={[group]}
          onAssignTab={onAssignTab}
        />
      </div>
    ));

    // Drop the compare tab on term-2's leading half — between the two
    // terminals, which is a slot no per-kind array has a name for.
    const target = leadingEdge(screen.getByTitle("term-2"));
    press(screen.getByTitle("cmp-1"), centre(screen.getByTitle("cmp-1")));
    moveTo(target);
    release(target);

    expect(onAssignTab).toHaveBeenCalledWith("cmp-1", "tg1", "term-2");
  });

  it("takes a tab out of the group when it is dropped past the last row", () => {
    const onAssignTab = vi.fn();
    const group = {
      id: "tg1",
      label: "Review",
      color: "chart-1" as const,
      collapsed: false,
      tabIds: ["term-1"],
    };

    render(() => (
      <div style={{ width: "800px" }}>
        <TabStrip
          {...baseProps([tab("term-1", "terminal")])}
          groupId="group-a"
          tabGroups={[group]}
          onAssignTab={onAssignTab}
        />
      </div>
    ));

    // The far end of the strip is outside every group — the inverse of the
    // gesture that put the tab in one.
    const strip = screen.getByTitle("term-1").parentElement!.getBoundingClientRect();
    const end = { x: strip.right - 4, y: strip.top + strip.height / 2 };
    press(screen.getByTitle("term-1"), centre(screen.getByTitle("term-1")));
    moveTo(end);
    release(end);

    expect(onAssignTab).toHaveBeenCalledWith("term-1", null, null);
  });
});

/// The drag ghost and the pane preview, which have no jsdom equivalent for a
/// third reason: both are driven by pointer *coordinates* carried on a real
/// `DragEvent`, and both are read off `getBoundingClientRect`. jsdom reports a
/// zero rect for every element, so `dropIntentAt` would classify every pointer
/// position in the app as the same degenerate box and the preview would be
/// identical for a centre drop and an edge one.
///
/// `paneDrop.test.ts` covers the arithmetic. What is only checkable here is
/// that the arithmetic is wired to the pixels the user is actually pointing at.
describe("the drag ghost and the pane preview", () => {
  /// The payload, the pointer and the action sentence are module state in
  /// `dragDrop.ts` — one drag is in flight at a time across every strip and
  /// pane in the window, which is the whole reason they are not per-component.
  /// A test that leaves a drag open therefore hands the next one a ghost it
  /// never started.
  beforeEach(cancelDrag);

  /// A pane body with a drop overlay on it, laid out at a known size so the
  /// 20% edge zones land at known coordinates.
  function pane(onSplitDrop = vi.fn(), onMoveTab = vi.fn()) {
    return (
      <div style={{ position: "relative", width: "400px", height: "200px" }} data-testid="pane">
        <PaneDropOverlay
          groupId="group-b"
          paneCount={2}
          onMoveTab={onMoveTab}
          onSplitDrop={onSplitDrop}
        />
      </div>
    );
  }

  /// A point at a fraction of the pane's box.
  function inPane(fx: number, fy: number) {
    const box = screen.getByTestId("pane").getBoundingClientRect();
    return { x: box.left + box.width * fx, y: box.top + box.height * fy };
  }

  it("names the tab in flight and says what to do with it", () => {
    render(() => (
      <>
        <TabStrip {...baseProps([tab("a1")])} groupId="group-a" onMoveTab={vi.fn()} />
        <DragGhost />
      </>
    ));

    // Nothing follows the cursor when nothing is being dragged.
    expect(screen.queryByTestId("drag-ghost")).toBeNull();

    const card = screen.getByTitle("a1");
    press(card, centre(card));
    // Somewhere over nothing, well clear of the strip.
    moveTo({ x: 5, y: 400 });

    // The label comes off the payload — the ghost is the app's own drag image,
    // so this is the only place the thing in flight is named. Scoped to the
    // ghost: the tab card it was dragged from still carries the same label,
    // and it should.
    expect(within(screen.getByTestId("drag-ghost")).getByText("a1")).toBeInTheDocument();
    // Over nothing: instruction rather than a blank line.
    expect(screen.getByText("Release over a pane")).toBeInTheDocument();
  });

  it("says what releasing here would do, per zone, and updates as the pointer moves", () => {
    render(() => (
      <>
        <TabStrip {...baseProps([tab("a1")])} groupId="group-a" onMoveTab={vi.fn()} />
        {pane()}
        <DragGhost />
      </>
    ));
    const card = screen.getByTitle("a1");
    press(card, centre(card));

    // Centre: a move, and the count is not mentioned because the layout does
    // not change.
    moveTo(inPane(0.5, 0.5));
    expect(screen.getByText("Move into this pane")).toBeInTheDocument();

    // Right-hand 20%: a split, and the sentence is the count *after* the drop.
    moveTo(inPane(0.95, 0.5));
    expect(screen.getByText("Split right — 3 panes")).toBeInTheDocument();
    expect(screen.queryByText("Move into this pane")).toBeNull();

    // Top 20%: same pane, different edge — the sentence tracks the pointer
    // rather than the pane it is over.
    moveTo(inPane(0.5, 0.02));
    expect(screen.getByText("Split up — 3 panes")).toBeInTheDocument();
  });

  it("goes away when the gesture does, wherever it ended", () => {
    render(() => (
      <>
        <TabStrip {...baseProps([tab("a1")])} groupId="group-a" onMoveTab={vi.fn()} />
        <DragGhost />
      </>
    ));
    const card = screen.getByTitle("a1");
    press(card, centre(card));
    moveTo({ x: 5, y: 400 });
    expect(screen.getByText("Release over a pane")).toBeInTheDocument();

    // Released over nothing — the case no drop target would ever hear about.
    release({ x: 5, y: 400 });
    expect(screen.queryByTestId("drag-ghost")).toBeNull();
  });

  it("cancels on Escape without dropping", () => {
    const onSplitDrop = vi.fn();
    render(() => (
      <>
        <TabStrip {...baseProps([tab("a1")])} groupId="group-a" onMoveTab={vi.fn()} />
        {pane(onSplitDrop)}
        <DragGhost />
      </>
    ));
    const card = screen.getByTitle("a1");
    press(card, centre(card));
    moveTo(inPane(0.95, 0.5));
    expect(screen.getByText("Split right — 3 panes")).toBeInTheDocument();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(screen.queryByTestId("drag-ghost")).toBeNull();

    // And the release that follows the cancel is not a drop.
    release(inPane(0.95, 0.5));
    expect(onSplitDrop).not.toHaveBeenCalled();
  });

  it("still delivers the drop it is describing", () => {
    const onSplitDrop = vi.fn();
    render(() => (
      <>
        <TabStrip {...baseProps([tab("a1")])} groupId="group-a" onMoveTab={vi.fn()} />
        {pane(onSplitDrop)}
        <DragGhost />
      </>
    ));
    const card = screen.getByTitle("a1");
    press(card, centre(card));
    moveTo(inPane(0.95, 0.5));
    release(inPane(0.95, 0.5));

    expect(onSplitDrop).toHaveBeenCalledTimes(1);
    const [payload, orientation, placement] = onSplitDrop.mock.calls[0];
    expect(payload).toMatchObject({ id: "a1", paneGroupId: "group-a" });
    expect(orientation).toBe("row");
    expect(placement).toBe("after");
    // And the ghost is gone, without a second gesture to dismiss it.
    expect(screen.queryByTestId("drag-ghost")).toBeNull();
  });

  /// The property that makes a browser tab's pane droppable at all.
  ///
  /// Its page is an OS-level child webview composited *above* the DOM, so a
  /// drop target underneath it can never be hit-tested by the DOM — which is
  /// what the old HTML5 implementation relied on. The controller hit-tests by
  /// rect instead, so anything painted on top is irrelevant. An opaque element
  /// over the pane is the closest a test can get to a native view, and it is
  /// the same question.
  it("lands the drop even when something opaque covers the pane", () => {
    const onSplitDrop = vi.fn();
    render(() => (
      <>
        <TabStrip {...baseProps([tab("a1")])} groupId="group-a" onMoveTab={vi.fn()} />
        <div style={{ position: "relative", width: "400px", height: "200px" }}>
          {pane(onSplitDrop)}
          <div
            style={{
              position: "absolute",
              inset: "0",
              "z-index": "999",
              background: "black",
            }}
          />
        </div>
        <DragGhost />
      </>
    ));
    const card = screen.getByTitle("a1");
    press(card, centre(card));
    moveTo(inPane(0.95, 0.5));
    release(inPane(0.95, 0.5));

    expect(onSplitDrop).toHaveBeenCalledTimes(1);
  });
});
