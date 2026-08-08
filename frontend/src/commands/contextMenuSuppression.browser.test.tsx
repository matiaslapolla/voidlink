/// The predicate behind `main.tsx`'s document-level suppression, exercised
/// against a real DOM: a right-click on ordinary content is suppressed, one
/// inside an `<input>` is not. `render` (jsdom) could dispatch the same
/// events, but the acceptance bar for this stream calls for the real thing —
/// see `vitest.config.ts`'s note on what `browser` exists to prove that
/// jsdom's stubs cannot.
import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import { shouldSuppressContextMenu } from "./contextMenuSuppression";

function dispatchContextMenu(target: Element): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

/// Installs the same listener `main.tsx` does (minus the `import.meta.env.DEV`
/// branch, which is a one-line gate around this and not what this test is
/// about), scoped to `root` rather than `window` so it cannot see events from
/// a previous test's still-mounted tree.
function installSuppression(root: HTMLElement): () => void {
  const handler = (e: Event) => {
    if (shouldSuppressContextMenu(e.target as Element | null)) e.preventDefault();
  };
  root.addEventListener("contextmenu", handler, true);
  return () => root.removeEventListener("contextmenu", handler, true);
}

describe("the document-level contextmenu suppression", () => {
  it("prevents the default action on ordinary content", () => {
    const { container } = render(() => <div data-testid="content">hello</div>);
    const uninstall = installSuppression(container);
    try {
      const event = dispatchContextMenu(container.querySelector('[data-testid="content"]')!);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      uninstall();
    }
  });

  it("leaves a right-click inside a real text input alone", () => {
    const { container } = render(() => <input type="text" value="hello" />);
    const uninstall = installSuppression(container);
    try {
      const event = dispatchContextMenu(container.querySelector("input")!);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      uninstall();
    }
  });

  it("leaves a right-click inside a textarea alone", () => {
    const { container } = render(() => <textarea>hello</textarea>);
    const uninstall = installSuppression(container);
    try {
      const event = dispatchContextMenu(container.querySelector("textarea")!);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      uninstall();
    }
  });

  it("leaves a right-click inside a contenteditable element alone", () => {
    const { container } = render(() => <div contentEditable={true}>hello</div>);
    const uninstall = installSuppression(container);
    try {
      const event = dispatchContextMenu(container.querySelector('[contenteditable="true"]')!);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      uninstall();
    }
  });

  it("still suppresses a right-click on a child of a text input's container that is not the input itself", () => {
    const { container } = render(() => (
      <div data-testid="wrapper">
        <label>Name</label>
        <input type="text" />
      </div>
    ));
    const uninstall = installSuppression(container);
    try {
      const label = container.querySelector("label")!;
      const event = dispatchContextMenu(label);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      uninstall();
    }
  });
});
