/**
 * core — the zod contract plus the pure (IO-free) logic for the second-brain
 * vault format. Originally the `brain` repo's @brain/core package; that repo is
 * being torn down, so this is now the only copy rather than a vendored mirror.
 *
 * The purity rule is the load-bearing part: everything here is a function of
 * its arguments, including the clock. Reading and writing the vault is the
 * CLI's job (`vault.ts`), which keeps all of this testable without a fixture
 * directory.
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

export {
  FOLDER_TYPE,
  parseEntry,
  type ParsedEntry,
} from "./parse.js";

export {
  buildIndexNotes,
  orphanedIndexNotes,
  type IndexKind,
  type IndexNote,
  type ExistingCreated,
} from "./index-notes.js";

export {
  review,
  DEFAULT_THRESHOLDS,
  type Finding,
  type FindingKind,
  type Severity,
  type ReviewInput,
  type ReviewThresholds,
} from "./review.js";
