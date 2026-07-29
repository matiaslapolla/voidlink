import { afterEach, describe, expect, it } from "vitest";
import { cancelAllPrompts, resolvePrompt, textPrompt, usePrompt } from "./prompt";

const { request } = usePrompt();

afterEach(() => cancelAllPrompts());

describe("prompt queueing", () => {
  it("does not cancel an open prompt when another is raised", async () => {
    // The two steps of "Add remote": name, then URL. A prompt raised from another
    // pane in between used to cancel this flow silently, mid-way.
    const name = textPrompt({ title: "Add remote", label: "Remote name" });
    const other = textPrompt({ title: "Rename branch", label: "New name" });

    expect(request()?.title).toBe("Add remote");
    resolvePrompt("upstream");
    expect(await name).toBe("upstream");

    // The interloper is next, not lost and not resolved as a cancel.
    expect(request()?.title).toBe("Rename branch");
    resolvePrompt("feature/x");
    expect(await other).toBe("feature/x");
    expect(request()).toBeNull();
  });

  it("resolves an empty answer as a cancel and moves on", async () => {
    const first = textPrompt({ title: "one" });
    const second = textPrompt({ title: "two" });

    resolvePrompt("   ");
    expect(await first).toBeNull();
    expect(request()?.title).toBe("two");
    resolvePrompt("value");
    expect(await second).toBe("value");
  });

  it("cancelAllPrompts settles every pending promise", async () => {
    const first = textPrompt({ title: "one" });
    const second = textPrompt({ title: "two" });
    cancelAllPrompts();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(request()).toBeNull();
  });
});
