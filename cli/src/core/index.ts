/**
 * Vendored copy of the `brain` repo's @brain/core package — the zod contract
 * + pure (IO-free) markdown/id builders for the second-brain vault format.
 * Kept in sync by hand; this is the CLI's only copy, not a shared workspace
 * package (voidlink is a plain npm project, not the `brain` pnpm monorepo).
 */

export {
  ENTRY_TYPES,
  RegisterInput,
  type EntryType,
} from "./contract.js";

export {
  TYPE_FOLDER,
  slug,
  makeId,
  buildLinks,
  extractBodyRefs,
  buildFrontmatter,
  buildMarkdown,
  type Link,
  type LinkKind,
  type BuildMeta,
  type BuildExtra,
  type BuiltMarkdown,
} from "./builders.js";
