import { describe, expect, it } from "vitest";
import { createRowIdentity } from "./stableRows";

interface Row {
  name: string;
  ahead: number;
}

const identity = () => createRowIdentity<Row>((r) => r.name);

describe("createRowIdentity", () => {
  it("hands back the same object when nothing changed", () => {
    const stable = identity();
    const first = stable([{ name: "main", ahead: 0 }]);
    const second = stable([{ name: "main", ahead: 0 }]);
    // The whole point: `<For>` is keyed by reference, so an equal-but-new
    // object is what tears the row's DOM down and drops focus with it.
    expect(second[0]).toBe(first[0]);
  });

  it("hands back a new object when a field changed", () => {
    const stable = identity();
    const first = stable([{ name: "main", ahead: 0 }]);
    const second = stable([{ name: "main", ahead: 2 }]);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].ahead).toBe(2);
  });

  it("keeps unchanged rows stable when a neighbour moves", () => {
    const stable = identity();
    const first = stable([
      { name: "main", ahead: 0 },
      { name: "topic", ahead: 0 },
    ]);
    // `topic` moved and changed; `main` did neither and must not be rebuilt
    // just because the array around it did.
    const second = stable([
      { name: "topic", ahead: 3 },
      { name: "main", ahead: 0 },
    ]);
    expect(second[1]).toBe(first[0]);
    expect(second[0]).not.toBe(first[1]);
  });

  it("forgets a row that left the list", () => {
    const stable = identity();
    const first = stable([{ name: "gone", ahead: 0 }]);
    stable([]);
    const back = stable([{ name: "gone", ahead: 0 }]);
    // Not a correctness requirement so much as a leak one: the cache is
    // rebuilt from the current list every pass, so a branch deleted a thousand
    // pulses ago is not still held.
    expect(back[0]).not.toBe(first[0]);
  });

  it("never collapses two rows that share a key into one reference", () => {
    // A path is not unique in the changes list — a staged-then-edited file is
    // two rows. If both adopted one cached object, `<For>` would render a
    // single row and one of the two changes would be invisible, which is the
    // exact class of bug this list already had once.
    const stable = createRowIdentity<Row>((r) => r.name);
    stable([{ name: "a.txt", ahead: 0 }]);
    const rows = stable([
      { name: "a.txt", ahead: 0 },
      { name: "a.txt", ahead: 0 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toBe(rows[1]);
  });

  it("uses the fingerprint, not the key, to decide equality", () => {
    // Identity and contents are different questions: a branch keeps its name
    // while its ahead/behind moves under it.
    const stable = createRowIdentity<Row>(
      (r) => r.name,
      (r) => r.name,
    );
    const first = stable([{ name: "main", ahead: 0 }]);
    const second = stable([{ name: "main", ahead: 9 }]);
    expect(second[0]).toBe(first[0]);
    expect(second[0].ahead).toBe(0);
  });
});
