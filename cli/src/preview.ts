/**
 * Render a local preview of the markdown that will be committed.
 * Uses the pure buildMarkdown builder from ./core (vendored from the `brain`
 * repo's @brain/core package). A local createdISO is computed for preview
 * only — local-register.ts stamps the authoritative timestamp at write time.
 */

import { buildMarkdown, makeId } from "./core/index.js";
import type { RegisterInput } from "./core/index.js";

export function renderPreview(input: RegisterInput): string {
  const createdISO = new Date().toISOString();
  const id = makeId({ type: input.type, title: input.title, createdISO });
  const { path, contents } = buildMarkdown(input, { id, createdISO });

  return [
    "─".repeat(60),
    `Preview  →  ${path}`,
    "─".repeat(60),
    contents,
    "─".repeat(60),
  ].join("\n");
}
