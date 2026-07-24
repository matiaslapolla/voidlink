import type { EntryType, RegisterInput } from "./contract.js";

/**
 * Type → content-repo folder name (PRD §5.4). These folder names are part of the
 * frozen contract; downstream packs (F2 commit path, F7 reindex, F8 graph) rely
 * on them being identical.
 */
export const TYPE_FOLDER: Record<EntryType, string> = {
  decision: "decisions",
  shipped: "shipped",
  note: "notes",
  discovery: "discoveries",
  content: "content",
  training: "training",
};

/** Link kind → folder used in `[[wikilinks]]` and index-note targets. */
const LINK_FOLDER: Record<"project" | "label" | "ticket", string> = {
  project: "projects",
  label: "labels",
  ticket: "tickets",
};

export type LinkKind = "project" | "label" | "ticket";
export interface Link {
  kind: LinkKind;
  ref: string;
}

/**
 * Slugify: lowercase, NFKD-normalize and strip diacritics, replace any run of
 * non-[a-z0-9] with a single "-", trim leading/trailing "-".
 * e.g. "Use idempotency keys on retries" -> "use-idempotency-keys-on-retries"
 */
export function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alnum -> single "-"
    .replace(/^-+|-+$/g, ""); // trim leading/trailing "-"
}

/**
 * Deterministic id: `${date}-${slug(title)}` where date is the first 10 chars of
 * createdISO. createdISO is server-stamped in -03:00, so slice(0,10) is the
 * correct local calendar date.
 * e.g. "2026-06-07-use-idempotency-keys-on-retries"
 */
export function makeId(input: {
  type: EntryType;
  title: string;
  createdISO: string;
}): string {
  return `${input.createdISO.slice(0, 10)}-${slug(input.title)}`;
}

/**
 * Derive graph edges from the structured fields. Order: project, then labels (in
 * input order), then ticket. Pure — no IO, no enrichment.
 */
export function buildLinks(input: RegisterInput): Link[] {
  const links: Link[] = [];
  if (input.project) links.push({ kind: "project", ref: input.project });
  if (input.labels) {
    for (const label of input.labels) links.push({ kind: "label", ref: label });
  }
  if (input.ticket) links.push({ kind: "ticket", ref: input.ticket });
  return links;
}

/** Index-note folders — wikilinks into these are structural, not entry→entry. */
const INDEX_FOLDERS = new Set(["projects", "labels", "tickets"]);

/** Entry-id shape: `YYYY-MM-DD-slug` (see makeId). */
const ENTRY_ID_RE = /\b\d{4}-\d\d-\d\d-[a-z0-9-]+\b/g;

/**
 * Scan a body for entry→entry references — the real brain-like edge (PLAN §5).
 * Extracts `[[wikilink]]` targets and bare entry-id mentions, returning the
 * referenced entry ids. Pure — no IO, no validation that the target exists
 * (the index is derived and rebuildable, so a dangling ref is harmless).
 *
 * Rules:
 *   - `[[projects/foo]]` / `[[labels/x]]` / `[[tickets/PROJ-1]]` -> skipped
 *     (those are structural links, already derived from frontmatter fields).
 *   - `[[decisions/2026-06-07-foo]]` -> "2026-06-07-foo" (basename).
 *   - `[[2026-06-07-foo|alias]]` -> "2026-06-07-foo" (alias stripped).
 *   - bare `2026-06-07-foo` in prose -> included.
 */
export function extractBodyRefs(body: string): string[] {
  if (!body) return [];
  const out = new Set<string>();

  const wikilink = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikilink.exec(body)) !== null) {
    const captured = m[1];
    if (captured === undefined) continue;
    let inner = captured.trim();
    const pipe = inner.indexOf("|");
    if (pipe !== -1) inner = inner.slice(0, pipe).trim(); // strip alias
    const slash = inner.lastIndexOf("/");
    const folder = slash !== -1 ? inner.slice(0, slash) : "";
    const base = slash !== -1 ? inner.slice(slash + 1) : inner;
    if (folder && INDEX_FOLDERS.has(folder)) continue; // structural, not a ref
    const ref = base.trim();
    if (ref) out.add(ref);
  }

  for (const idMatch of body.matchAll(ENTRY_ID_RE)) {
    if (idMatch[0]) out.add(idMatch[0]);
  }

  return [...out];
}

/** De-duplicate links by `${kind}/${ref}`, preserving first-seen order. */
function dedupeLinks(links: Link[]): Link[] {
  const seen = new Set<string>();
  const out: Link[] = [];
  for (const l of links) {
    const key = `${l.kind}/${l.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/**
 * Quote a YAML scalar value only when needed. We keep plain (bare) scalars where
 * YAML would unambiguously read them back as the same string — so ids like
 * `2026-06-07-foo` and tickets like `BRN-12` stay bare (matching PRD §5.3) — and
 * double-quote anything YAML could otherwise mis-parse: empty strings, leading/
 * trailing whitespace, structural indicators in unsafe positions, a leading
 * indicator char, values that parse as bool/null/number, and ISO timestamps
 * (which contain `:` and would be read as a YAML timestamp). Correct YAML beats
 * aesthetic bareness.
 */
function yamlScalar(value: string): string {
  const needsQuote =
    value === "" ||
    /^\s|\s$/.test(value) || // leading/trailing whitespace
    /[\n\t]/.test(value) || // control chars
    /[:#]\s/.test(value) || // ": " or "# " => mapping / comment
    /\s#/.test(value) || // " #" => trailing comment
    /^[-?:]\s/.test(value) || // block indicator at start
    /^[!&*\[\]{}>|'"%@`,]/.test(value) || // reserved/flow indicator at start
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) || // bool/null
    /^[-+]?(\d[\d_]*\.?[\d_]*|\.\d+)([eE][-+]?\d+)?$/.test(value) || // number
    /^\d{4}-\d\d-\d\d([T ]\d\d:)/.test(value); // ISO datetime (e.g. created)
  if (!needsQuote) return value;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Render a YAML flow array of strings, e.g. [payments, reliability]. */
function yamlFlowArray(values: string[]): string {
  return `[${values.map(yamlScalar).join(", ")}]`;
}

export interface BuildMeta {
  id: string;
  createdISO: string;
}

export interface BuildExtra {
  /**
   * Extra frontmatter keys injected by the server (insertion order preserved).
   * This is where `shipped` gets `ticket_title` / `ticket_team` / `ticket_state`.
   */
  frontmatter?: Record<string, string>;
  /** Extra links appended to the auto-derived set (e.g. server `ticket` link). */
  links?: Link[];
}

/**
 * Build the YAML frontmatter block, fenced by `---` lines.
 *
 * Field order:
 *   id, type, title, project?, ticket?, labels?, ...extra.frontmatter,
 *   created, links (block list).
 *
 * `links` = dedupe(buildLinks(input) ++ (extra?.links ?? [])), each rendered as
 *   - "[[${folder}/${ref}]]"  (folder via kind: project→projects, label→labels, ticket→tickets)
 *
 * `extra` is optional so 2-arg callers (CLI / web preview) are unaffected.
 */
export function buildFrontmatter(
  input: RegisterInput,
  meta: BuildMeta,
  extra?: BuildExtra,
): string {
  const lines: string[] = ["---"];

  lines.push(`id: ${yamlScalar(meta.id)}`);
  lines.push(`type: ${input.type}`);
  lines.push(`title: ${yamlScalar(input.title)}`);
  if (input.project) lines.push(`project: ${yamlScalar(input.project)}`);
  if (input.ticket) lines.push(`ticket: ${yamlScalar(input.ticket)}`);
  if (input.labels && input.labels.length > 0) {
    lines.push(`labels: ${yamlFlowArray(input.labels)}`);
  }

  if (extra?.frontmatter) {
    for (const [key, value] of Object.entries(extra.frontmatter)) {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }

  lines.push(`created: ${yamlScalar(meta.createdISO)}`);

  const links = dedupeLinks([...buildLinks(input), ...(extra?.links ?? [])]);
  lines.push("links:");
  for (const link of links) {
    lines.push(`  - "[[${LINK_FOLDER[link.kind]}/${link.ref}]]"`);
  }

  lines.push("---");
  return lines.join("\n");
}

export interface BuiltMarkdown {
  /**
   * Type-relative path, e.g. "decisions/2026-06-07-...md".
   * The SERVER prepends CONTENT_PREFIX — do NOT include it here.
   */
  path: string;
  /** frontmatter + "\n" + body, with a trailing newline. */
  contents: string;
  /** Same de-duped link set rendered in the frontmatter. */
  links: Link[];
}

/**
 * Build the full markdown artifact for an entry. PURE — no IO. `path` is
 * type-relative (server applies CONTENT_PREFIX). `links` mirrors the frontmatter
 * set so callers can index without re-deriving.
 */
export function buildMarkdown(
  input: RegisterInput,
  meta: BuildMeta,
  extra?: BuildExtra,
): BuiltMarkdown {
  const path = `${TYPE_FOLDER[input.type]}/${meta.id}.md`;
  const frontmatter = buildFrontmatter(input, meta, extra);
  const body = input.body ?? "";
  const contents = `${frontmatter}\n${body}\n`;
  const links = dedupeLinks([...buildLinks(input), ...(extra?.links ?? [])]);
  return { path, contents, links };
}
