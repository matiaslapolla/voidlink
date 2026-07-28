import { describe, expect, it } from "vitest";
import {
  canOutline,
  flattenOutline,
  OUTLINE_LANGUAGES,
  parseOutline,
  symbolChainAt,
  type OutlineNode,
} from "./outline";

/// `name:kind@line-endLine`, so a whole tree fits in one readable assertion.
function shape(nodes: readonly OutlineNode[]): string[] {
  return nodes.flatMap((n) => [
    `${n.name}:${n.kind}@${n.line}-${n.endLine}`,
    ...shape(n.children).map((s) => `  ${s}`),
  ]);
}

const names = (nodes: readonly OutlineNode[]) => nodes.map((n) => n.name);

describe("canOutline", () => {
  it("covers the languages the parser has rules for", () => {
    expect(canOutline("typescript")).toBe(true);
    expect(canOutline("rust")).toBe(true);
    expect(canOutline("markdown")).toBe(true);
    expect(canOutline("plaintext")).toBe(false);
  });

  it("agrees with the exported list the provider registers for", () => {
    for (const lang of OUTLINE_LANGUAGES) expect(canOutline(lang)).toBe(true);
  });
});

describe("parseOutline — unsupported languages", () => {
  it("returns nothing rather than guessing", () => {
    expect(parseOutline("plaintext", "hello\nworld")).toEqual([]);
    expect(parseOutline("json", '{"a": 1}')).toEqual([]);
  });

  it("handles an empty file", () => {
    expect(parseOutline("typescript", "")).toEqual([]);
  });
});

describe("parseOutline — TypeScript", () => {
  const src = [
    "import { a } from 'b';", // 1
    "", // 2
    "export interface Props {", // 3
    "  x: number;", // 4
    "}", // 5
    "", // 6
    "export class Widget {", // 7
    "  private count = 0;", // 8
    "", // 9
    "  render(): void {", // 10
    "    if (this.count) {", // 11
    "      return;", // 12
    "    }", // 13
    "  }", // 14
    "}", // 15
    "", // 16
    "export function make(): Widget {", // 17
    "  return new Widget();", // 18
    "}", // 19
    "", // 20
    "const helper = (n: number) => n + 1;", // 21
    "const TABLE = { a: 1 };", // 22
  ].join("\n");

  it("finds the top-level declarations, nested and ranged", () => {
    expect(shape(parseOutline("typescript", src))).toEqual([
      "Props:interface@3-5",
      "Widget:class@7-15",
      "  render:method@10-15",
      "make:function@17-19",
      "helper:function@21-21",
      "TABLE:constant@22-22",
    ]);
  });

  it("does not mistake a block opener for a method", () => {
    expect(names(parseOutline("typescript", src)).join()).not.toContain("if");
  });

  it("reads an async arrow as a function and a plain value as a constant", () => {
    const nodes = parseOutline(
      "typescript",
      ["export const load = async () => {}", "export const NAME = 'x';"].join("\n"),
    );
    expect(shape(nodes)).toEqual(["load:function@1-1", "NAME:constant@2-2"]);
  });

  it("skips comment lines that mention a declaration", () => {
    const nodes = parseOutline("typescript", "// export function ghost() {}\nfunction real() {}");
    expect(names(nodes)).toEqual(["real"]);
  });

  it("treats JavaScript with the same rules", () => {
    expect(names(parseOutline("javascript", "function go() {}"))).toEqual(["go"]);
  });
});

describe("parseOutline — Rust", () => {
  const src = [
    "pub struct Walker {", // 1
    "    root: PathBuf,", // 2
    "}", // 3
    "", // 4
    "impl Walker {", // 5
    "    pub fn new(root: PathBuf) -> Self {", // 6
    "        Self { root }", // 7
    "    }", // 8
    "", // 9
    "    async fn walk(&self) {}", // 10
    "}", // 11
    "", // 12
    "pub enum Kind { A, B }", // 13
    "pub trait Visit {}", // 14
    "mod tests {}", // 15
  ].join("\n");

  it("nests methods under their impl block", () => {
    expect(shape(parseOutline("rust", src))).toEqual([
      "Walker:struct@1-3",
      // `impl Walker` carries the type as its name, which is what every editor
      // shows and what makes two impls of one type distinguishable below.
      "Walker:class@5-11",
      "  new:method@6-8",
      "  walk:method@10-11",
      "Kind:enum@13-13",
      "Visit:interface@14-14",
      "tests:module@15-15",
    ]);
  });

  it("keeps two impls of the same type apart", () => {
    const nodes = parseOutline(
      "rust",
      ["impl Display for X {", "}", "impl Iterator for X {", "}"].join("\n"),
    );
    expect(names(nodes)).toEqual(["Display for X", "Iterator for X"]);
  });
});

describe("parseOutline — Python", () => {
  it("distinguishes a method from a module-level function by indentation", () => {
    const src = ["class Thing:", "    def run(self):", "        pass", "", "def main():", "    pass"].join("\n");
    expect(shape(parseOutline("python", src))).toEqual([
      "Thing:class@1-3",
      "  run:method@2-3",
      "main:function@5-6",
    ]);
  });
});

describe("parseOutline — Go", () => {
  it("keeps the receiver as detail rather than mangling the name", () => {
    const src = ["type Server struct {", "}", "", "func (s *Server) Start() {}", "func main() {}"].join("\n");
    const nodes = parseOutline("go", src);
    expect(names(nodes)).toEqual(["Server", "Start", "main"]);
    expect(nodes[1].kind).toBe("method");
    expect(nodes[1].detail).toBe("*Server");
  });
});

describe("parseOutline — Markdown", () => {
  it("nests by heading level, not indentation", () => {
    const src = ["# Top", "text", "## One", "### Deep", "## Two", "# Other"].join("\n");
    expect(shape(parseOutline("markdown", src))).toEqual([
      "Top:section@1-5",
      "  One:section@3-4",
      "    Deep:section@4-4",
      "  Two:section@5-5",
      "Other:section@6-6",
    ]);
  });

  it("ignores shell comments inside a fenced block", () => {
    const src = ["# Real", "```sh", "# not a heading", "```", "## After"].join("\n");
    expect(names(parseOutline("markdown", src))).toEqual(["Real"]);
    expect(names(parseOutline("markdown", src)[0].children)).toEqual(["After"]);
  });

  it("strips closing hashes from a closed ATX heading", () => {
    expect(names(parseOutline("markdown", "## Title ##"))).toEqual(["Title"]);
  });
});

describe("symbolChainAt", () => {
  const nodes = parseOutline(
    "typescript",
    ["class A {", "  go() {", "    return 1;", "  }", "}", "", "function b() {}"].join("\n"),
  );

  it("returns the containing chain, outermost first", () => {
    expect(symbolChainAt(nodes, 3).map((n) => n.name)).toEqual(["A", "go"]);
  });

  it("stops at the outer symbol when the cursor is between children", () => {
    expect(symbolChainAt(nodes, 1).map((n) => n.name)).toEqual(["A"]);
  });

  it("is empty above the first symbol", () => {
    expect(symbolChainAt(nodes, 7).map((n) => n.name)).toEqual(["b"]);
    expect(symbolChainAt([], 1)).toEqual([]);
  });
});

describe("flattenOutline", () => {
  it("keeps depth and container path for the picker's rows", () => {
    const nodes = parseOutline(
      "typescript",
      ["class A {", "  go() {", "  }", "}", "function b() {}"].join("\n"),
    );
    expect(flattenOutline(nodes).map((r) => [r.node.name, r.depth, r.container.join(".")])).toEqual([
      ["A", 0, ""],
      ["go", 1, "A"],
      ["b", 0, ""],
    ]);
  });
});
