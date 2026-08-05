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
/// **Cross-group drag** hands a real `DataTransfer` to `dataTransfer.setData`
/// in `onDragStart` (`TabStrip.tsx`). `DataTransfer` is a browser constructor
/// jsdom does not implement at all — `new DataTransfer()` throws
/// `ReferenceError` there, which is why every drag test up to now has had to
/// stub the whole gesture rather than drive it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import {
  DragGhost,
  endTabDrag,
  PaneDropOverlay,
  TabStrip,
  type TabDescriptor,
  type TabKind,
} from "./TabStrip";

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
});

describe("drag between groups", () => {
  it("moves a tab from one pane group's strip onto another's with a real DataTransfer", async () => {
    const onMoveTabA = vi.fn();
    const onMoveTabB = vi.fn();
    const tabA = tab("a1");
    const tabB = tab("b1");

    render(() => (
      <div style={{ display: "flex" }}>
        <div style={{ width: "400px" }}>
          <TabStrip {...baseProps([tabA])} groupId="group-a" onMoveTab={onMoveTabA} />
        </div>
        <div style={{ width: "400px" }}>
          <TabStrip {...baseProps([tabB])} groupId="group-b" onMoveTab={onMoveTabB} />
        </div>
      </div>
    ));

    const source = screen.getByTitle("a1");
    const target = screen.getByTitle("b1");

    // `DataTransfer` is a real browser API. Constructing one is the line this
    // test could not cross in jsdom.
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }),
    );
    target.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }),
    );
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));

    // The strip the tab landed *on* is the one whose `onMoveTab` fires — group
    // A, which the drag started in, gets nothing.
    expect(onMoveTabB).toHaveBeenCalledTimes(1);
    const [payload, beforeTabId] = onMoveTabB.mock.calls[0];
    expect(payload).toMatchObject({ kind: "file", id: "a1", groupId: "group-a" });
    expect(beforeTabId).toBe("b1");
    expect(onMoveTabA).not.toHaveBeenCalled();

    // `text/voidlink-item` is what `onDragStart` wrote into the real
    // `DataTransfer` — proof the handler ran against this exact gesture and
    // not a stand-in for one.
    expect(dataTransfer.getData("text/voidlink-item")).toBe("file:a1");
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
describe("the drag ghost", () => {
  /// The payload, the pointer and the action sentence are module state in
  /// `TabStrip.tsx` — one drag is in flight at a time across every strip in the
  /// window, which is the whole reason they are not per-component. A test that
  /// leaves a drag open therefore hands the next one a ghost it never started.
  beforeEach(endTabDrag);

  /// A pane body with a drop overlay on it, laid out at a known size so the
  /// 20% edge zones land at known coordinates.
  function pane(paneCount = 2) {
    return (
      <div style={{ position: "relative", width: "400px", height: "200px" }} data-testid="pane">
        <PaneDropOverlay
          groupId="group-b"
          paneCount={paneCount}
          onMoveTab={vi.fn()}
          onSplitDrop={vi.fn()}
        />
      </div>
    );
  }

  function startDrag(source: Element, dataTransfer: DataTransfer) {
    source.dispatchEvent(
      new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: 40,
        clientY: 10,
      }),
    );
  }

  it("names the tab in flight and says what to do with it", () => {
    render(() => (
      <>
        <TabStrip {...baseProps([tab("a1")])} groupId="group-a" onMoveTab={vi.fn()} />
        <DragGhost />
      </>
    ));

    // Nothing follows the cursor when nothing is being dragged.
    expect(screen.queryByText("Release over a pane")).toBeNull();

    startDrag(screen.getByTitle("a1"), new DataTransfer());

    // The label comes off `TabDragPayload.label` — the ghost is the app's own
    // drag image, so this is the only place the thing in flight is named.
    // Scoped to the ghost: the tab card it was dragged from still carries the
    // same label, and it should.
    expect(within(screen.getByTestId("drag-ghost")).getByText("a1")).toBeInTheDocument();
    // Over nothing yet: instruction rather than a blank line.
    expect(screen.getByText("Release over a pane")).toBeInTheDocument();
  });

  it("says what releasing here would do, per zone, and updates as the pointer moves", () => {
    render(() => (
      <>
        <TabStrip {...baseProps([tab("a1")])} groupId="group-a" onMoveTab={vi.fn()} />
        {pane(2)}
        <DragGhost />
      </>
    ));
    const dataTransfer = new DataTransfer();
    startDrag(screen.getByTitle("a1"), dataTransfer);

    const box = screen.getByTestId("pane").getBoundingClientRect();
    const over = (fx: number, fy: number) =>
      screen.getByTestId("pane").firstElementChild!.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: box.left + box.width * fx,
          clientY: box.top + box.height * fy,
        }),
      );

    // Centre: a move, and the count is not mentioned because the layout does
    // not change.
    over(0.5, 0.5);
    expect(screen.getByText("Move into this pane")).toBeInTheDocument();

    // Right-hand 20%: a split, and the sentence is the count *after* the drop.
    over(0.95, 0.5);
    expect(screen.getByText("Split right — 3 panes")).toBeInTheDocument();
    expect(screen.queryByText("Move into this pane")).toBeNull();

    // Top 20%: same pane, different edge — the sentence tracks the pointer
    // rather than the pane it is over.
    over(0.5, 0.02);
    expect(screen.getByText("Split up — 3 panes")).toBeInTheDocument();
  });

  it("goes away when the gesture does, wherever it ended", () => {
    render(() => (
      <>
        <TabStrip {...baseProps([tab("a1")])} groupId="group-a" onMoveTab={vi.fn()} />
        <DragGhost />
      </>
    ));
    const source = screen.getByTitle("a1");
    startDrag(source, new DataTransfer());
    expect(screen.getByText("Release over a pane")).toBeInTheDocument();

    // `dragend` fires on the source after *every* drag, including one the user
    // abandoned over nothing — which is the case no drop handler would catch.
    source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
    expect(screen.queryByText("Release over a pane")).toBeNull();
  });

  /// The document-level teardown listener is in the bubble phase on purpose: in
  /// the capture phase it would clear the payload before the pane's own `drop`
  /// handler read it, and every drop in the app would silently do nothing.
  it("still delivers the drop it is describing", () => {
    const onSplitDrop = vi.fn();
    render(() => (
      <>
        <TabStrip {...baseProps([tab("a1")])} groupId="group-a" onMoveTab={vi.fn()} />
        <div style={{ position: "relative", width: "400px", height: "200px" }} data-testid="pane">
          <PaneDropOverlay
            groupId="group-b"
            paneCount={2}
            onMoveTab={vi.fn()}
            onSplitDrop={onSplitDrop}
          />
        </div>
        <DragGhost />
      </>
    ));
    const dataTransfer = new DataTransfer();
    startDrag(screen.getByTitle("a1"), dataTransfer);

    const overlay = screen.getByTestId("pane").firstElementChild!;
    const box = screen.getByTestId("pane").getBoundingClientRect();
    const at = { clientX: box.left + box.width * 0.95, clientY: box.top + box.height * 0.5 };
    overlay.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, ...at }),
    );
    overlay.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, ...at }),
    );

    expect(onSplitDrop).toHaveBeenCalledTimes(1);
    const [payload, orientation, placement] = onSplitDrop.mock.calls[0];
    expect(payload).toMatchObject({ id: "a1", groupId: "group-a" });
    expect(orientation).toBe("row");
    expect(placement).toBe("after");
    // And the ghost is gone, without a second gesture to dismiss it.
    expect(screen.queryByText(/Split right/)).toBeNull();
  });
});
