/**
 * Client-side validation using ./core's RegisterInput zod schema (vendored
 * from the `brain` repo's @brain/core package).
 * Prints issues clearly and exits non-zero on failure.
 * Returns the parsed (type-safe) RegisterInput on success.
 */

import { RegisterInput } from "./core/index.js";
import type { ZodError } from "zod";

export type ValidationResult =
  | { ok: true; data: RegisterInput }
  | { ok: false };

/**
 * Validate an unknown object against the RegisterInput discriminated union.
 * Prints a formatted error and returns { ok: false } on failure.
 * Does NOT call process.exit — caller decides.
 */
export function validateInput(raw: unknown): ValidationResult {
  const result = RegisterInput.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  printZodError(result.error);
  return { ok: false };
}

function printZodError(err: ZodError): void {
  console.error("\nValidation failed:");
  for (const issue of err.issues) {
    const path =
      issue.path.length > 0 ? `  [${issue.path.join(".")}]  ` : "  ";
    console.error(`${path}${issue.message}`);
  }
}
