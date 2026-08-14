import { describe, expect, it } from "vitest";
import { COMMAND_PREFIX, paletteMode, paletteTerm } from "./paletteMode";

describe("paletteMode — which half of the palette a query asks for", () => {
  it("defaults to files, because ⌘P opens with an empty query", () => {
    expect(paletteMode("")).toBe("files");
    expect(paletteMode("registry.ts")).toBe("files");
  });

  it("switches to commands on a leading >, which is what ⌘K seeds", () => {
    expect(paletteMode(COMMAND_PREFIX)).toBe("commands");
    expect(paletteMode(">new terminal")).toBe("commands");
  });

  it("ignores leading whitespace — a space before the > is a typo, not a mode", () => {
    expect(paletteMode("  >term")).toBe("commands");
  });

  it("does not read a > anywhere but the front", () => {
    expect(paletteMode("src/a>b.ts")).toBe("files");
  });
});

describe("paletteTerm — what is actually matched against", () => {
  it("strips the mode marker", () => {
    expect(paletteTerm(">")).toBe("");
    expect(paletteTerm(">term")).toBe("term");
    expect(paletteTerm("> new terminal ")).toBe("new terminal");
  });

  it("leaves a file query alone", () => {
    expect(paletteTerm("  App.tsx ")).toBe("App.tsx");
  });
});
