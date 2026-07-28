/// A lightweight document outline, parsed from text.
///
/// This exists because Monaco ships no symbol provider for anything outside its
/// three bundled web-worker languages, and the two surfaces Wave 3 owes —
/// breadcrumbs and go-to-symbol — are useless without one. It is explicitly a
/// *fallback*: Wave 5's language servers register real providers through
/// `documentSymbols.ts`, which prefers whatever was registered last, and this
/// parser then stops being consulted for those languages.
///
/// It is regex-and-indentation, and it is honest about that. It will miss a
/// declaration split across lines and it will not understand a macro. What it
/// will do is name the function you are inside, for the languages this
/// repository and its users actually edit, without a language server, a worker,
/// or a whole-file parse on every keystroke.
///
/// Pure: text in, tree out. No Monaco, no DOM — which is what makes the nesting
/// and range arithmetic testable, and that arithmetic is where outline code
/// goes wrong.

export type OutlineKind =
  | "class"
  | "interface"
  | "enum"
  | "function"
  | "method"
  | "module"
  | "struct"
  | "constant"
  | "variable"
  | "section";

export interface OutlineNode {
  name: string;
  /// Secondary text — a Go receiver type. Empty when there is nothing useful to
  /// add; never a repeat of the name.
  detail: string;
  kind: OutlineKind;
  /// 1-based, Monaco's convention throughout.
  line: number;
  column: number;
  /// Last line this symbol covers, inclusive. Derived from where the next
  /// same-or-shallower symbol starts, because a brace matcher that is wrong
  /// about a string literal is worse than an approximation that is never wrong
  /// by more than one symbol.
  endLine: number;
  children: OutlineNode[];
}

interface Rule {
  re: RegExp;
  kind: OutlineKind;
  /// Which capture group holds the name. Defaults to 1.
  nameGroup?: number;
  /// Capture group for the detail text, if any.
  detailGroup?: number;
  /// Same rule, different kind when the line is indented — a `def` at column 1
  /// is a function, a `def` inside a class is a method.
  indentedKind?: OutlineKind;
  /// Reject `NOT_A_NAME` captures. Only the TypeScript method rule needs this:
  /// it is the one pattern loose enough to match `if (x) {`, and applying the
  /// list everywhere would silently drop Rust's `fn new` and Go's `func new`.
  rejectKeywords?: boolean;
}

/// Block openers that look like a call with a body. Excluded from the method
/// rule, which is otherwise the loosest pattern here.
const NOT_A_NAME = new Set([
  "if", "for", "while", "switch", "catch", "return", "do", "else", "try",
  "function", "class", "new", "typeof", "await", "yield", "in", "of",
]);

const TS_RULES: Rule[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "interface" },
  { re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: "function",
  },
  // `const foo = () => …` and `const foo = async function …`. Arrow functions
  // are how most of this codebase's non-exported helpers are written, so an
  // outline that skipped them would be mostly empty.
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>)/,
    kind: "function",
  },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/, kind: "constant" },
  // A method: indented, an identifier, a parameter list, an open brace. The
  // leading-whitespace requirement is what keeps top-level `if (…) {` out; the
  // keyword set above covers the indented ones.
  {
    re: /^\s+(?:(?:public|private|protected|static|readonly|abstract|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\{\s*$/,
    kind: "method",
    rejectKeywords: true,
  },
];

const RUST_PUB = /(?:pub(?:\s*\([^)]*\))?\s+)?/.source;
const RUST_RULES: Rule[] = [
  {
    re: new RegExp(`^\\s*${RUST_PUB}(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+([A-Za-z_]\\w*)`),
    kind: "function",
    indentedKind: "method",
  },
  { re: new RegExp(`^\\s*${RUST_PUB}struct\\s+([A-Za-z_]\\w*)`), kind: "struct" },
  { re: new RegExp(`^\\s*${RUST_PUB}enum\\s+([A-Za-z_]\\w*)`), kind: "enum" },
  { re: new RegExp(`^\\s*${RUST_PUB}(?:unsafe\\s+)?trait\\s+([A-Za-z_]\\w*)`), kind: "interface" },
  { re: new RegExp(`^\\s*${RUST_PUB}mod\\s+([A-Za-z_]\\w*)`), kind: "module" },
  { re: new RegExp(`^\\s*${RUST_PUB}(?:const|static)\\s+(?:mut\\s+)?([A-Za-z_]\\w*)`), kind: "constant" },
  { re: new RegExp(`^\\s*${RUST_PUB}type\\s+([A-Za-z_]\\w*)`), kind: "interface" },
  // `impl Trait for Type` / `impl Type`. The whole target is the name, because
  // `impl Display for X` and `impl Iterator for X` are different sections and
  // collapsing them to the type name would merge them.
  { re: /^\s*impl(?:\s*<[^>]*>)?\s+([^{]+?)\s*\{/, kind: "class" },
  { re: /^\s*macro_rules!\s+([A-Za-z_]\w*)/, kind: "function" },
];

const PYTHON_RULES: Rule[] = [
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function", indentedKind: "method" },
];

const GO_RULES: Rule[] = [
  {
    re: /^func\s+\(\s*[A-Za-z_]\w*\s+([^)]+)\)\s*([A-Za-z_]\w*)/,
    kind: "method",
    nameGroup: 2,
    detailGroup: 1,
  },
  { re: /^func\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/, kind: "struct" },
  { re: /^\s*type\s+([A-Za-z_]\w*)\s+interface\b/, kind: "interface" },
  { re: /^\s*type\s+([A-Za-z_]\w*)/, kind: "interface" },
];

/// Which rule set a Monaco language id uses. Everything else outlines empty,
/// which the breadcrumb renders as "just the file path" — the right answer for
/// a language we cannot honestly parse.
const RULES: Record<string, Rule[]> = {
  typescript: TS_RULES,
  javascript: TS_RULES,
  rust: RUST_RULES,
  python: PYTHON_RULES,
  go: GO_RULES,
};

/// Languages the fallback provider is registered for.
export const OUTLINE_LANGUAGES: readonly string[] = [...Object.keys(RULES), "markdown"];

export function canOutline(languageId: string): boolean {
  return OUTLINE_LANGUAGES.includes(languageId);
}

type Flat = { node: OutlineNode; depth: number };

/// Parse `text` into a symbol tree.
///
/// Nesting is by indentation for code and by heading level for markdown, and
/// `endLine` is filled in afterwards from where the next same-or-shallower
/// symbol starts. Both are approximations; both are stable, which matters more
/// for a breadcrumb than exactness — a chain that flickers as you scroll is
/// worse than one that is occasionally a line generous.
export function parseOutline(languageId: string, text: string): OutlineNode[] {
  const lines = text.split("\n");
  const flat =
    languageId === "markdown" ? parseMarkdown(lines) : parseWithRules(RULES[languageId], lines);
  fillEndLines(flat, lines);
  return nest(flat);
}

function parseWithRules(rules: Rule[] | undefined, lines: string[]): Flat[] {
  if (!rules) return [];
  const out: Flat[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // A blank or comment-only line can never declare anything, and skipping
    // them first is what keeps this cheap on a large file.
    const trimmed = raw.trim();
    if (
      trimmed === "" ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("#!")
    ) {
      continue;
    }
    for (const rule of rules) {
      const m = raw.match(rule.re);
      if (!m) continue;
      const name = (m[rule.nameGroup ?? 1] ?? "").trim();
      if (!name || (rule.rejectKeywords && NOT_A_NAME.has(name))) continue;
      const indent = raw.length - raw.trimStart().length;
      const kind = indent > 0 && rule.indentedKind ? rule.indentedKind : rule.kind;
      out.push({
        depth: indent,
        node: {
          name,
          detail: rule.detailGroup ? (m[rule.detailGroup] ?? "").trim() : "",
          kind,
          line: i + 1,
          column: Math.max(1, raw.indexOf(name) + 1),
          endLine: i + 1,
          children: [],
        },
      });
      break;
    }
  }
  return out;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

function parseMarkdown(lines: string[]): Flat[] {
  const out: Flat[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // A `#` inside a fenced block is a shell comment, not a heading.
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = raw.match(HEADING);
    if (!m) continue;
    out.push({
      depth: m[1].length,
      node: {
        name: m[2].trim(),
        detail: "",
        kind: "section",
        line: i + 1,
        column: 1,
        endLine: i + 1,
        children: [],
      },
    });
  }
  return out;
}

function fillEndLines(flat: Flat[], lines: string[]) {
  for (let i = 0; i < flat.length; i++) {
    let end = lines.length;
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[j].depth <= flat[i].depth) {
        end = flat[j].node.line - 1;
        break;
      }
    }
    // Walk back over the blank lines between two declarations. Without this a
    // symbol's range swallows the gap after it, and the breadcrumb keeps
    // claiming you are inside a function you have already scrolled past.
    while (end > flat[i].node.line && (lines[end - 1] ?? "").trim() === "") end--;
    flat[i].node.endLine = Math.max(flat[i].node.line, end);
  }
}

/// Fold a depth-tagged list into a tree. A symbol becomes a child of the
/// nearest preceding symbol with a smaller depth *that still covers its line*,
/// so a stray indent after a closing brace does not adopt the next declaration.
function nest(flat: Flat[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: Flat[] = [];
  for (const item of flat) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.depth < item.depth && top.node.endLine >= item.node.line) break;
      stack.pop();
    }
    if (stack.length === 0) roots.push(item.node);
    else stack[stack.length - 1].node.children.push(item.node);
    stack.push(item);
  }
  return roots;
}

/// The chain of symbols containing `line`, outermost first. The breadcrumb's
/// tail; empty above the first symbol in a file, which renders as just the path.
export function symbolChainAt<T extends { line: number; endLine: number; children?: T[] }>(
  nodes: readonly T[],
  line: number,
): T[] {
  for (const node of nodes) {
    if (line < node.line || line > node.endLine) continue;
    return [node, ...symbolChainAt(node.children ?? [], line)];
  }
  return [];
}

/// Depth-first flattening for the go-to-symbol list, keeping the container path
/// so a picker can show `EditorController › save` rather than nine bare `save`s.
export function flattenOutline<T extends { name: string; children?: T[] }>(
  nodes: readonly T[],
  container: string[] = [],
): { node: T; depth: number; container: string[] }[] {
  const out: { node: T; depth: number; container: string[] }[] = [];
  for (const node of nodes) {
    out.push({ node, depth: container.length, container });
    if (node.children?.length) out.push(...flattenOutline(node.children, [...container, node.name]));
  }
  return out;
}
