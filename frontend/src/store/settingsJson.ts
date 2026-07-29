/// The editor settings as text, in VS Code's dotted form.
///
/// ```jsonc
/// {
///   "editor.fontSize": 13,
///   "[rust]": { "editor.tabSize": 4 }
/// }
/// ```
///
/// The GUI and this are two *views* over one store, not two stores: this module
/// only converts between the persisted nested shape and the flat dotted text,
/// and the dialog writes the result back through the same `updateEditor` the
/// controls use. There is no second copy of the values behind the JSON editor.
///
/// Dotted for display and JSON, nested in memory — the mapping lives in
/// `settingsSchema.ts` (`id` ↔ `key`) and is applied here.
///
/// DOM-free and Monaco-free: the completion and validation the JSON pane gets
/// come from `settingsJsonSchema()` handed to
/// `monaco.languages.json.jsonDefaults.setDiagnosticsOptions`, but generating
/// that schema is just walking the table, so it belongs here with the rest of
/// the conversion and is testable in plain node.

import {
  EDITOR_SETTING_LIST,
  isPlainObject,
  parseEditorSettings,
  settingById,
  type EditorSetting,
} from "./settingsSchema";
import type { EditorCoreSettings, EditorSettings } from "./settings";

/// The uri the generated schema is registered under, and the uri of the model
/// the JSON pane edits. They have to agree — `fileMatch` is how Monaco decides
/// a buffer gets this schema — so both live here rather than in the component.
export const SETTINGS_JSON_SCHEMA_URI = "voidlink://schemas/editor-settings.json";
export const SETTINGS_JSON_MODEL_URI = "voidlink://settings/editor-settings.json";

/// Wrap a language id the way VS Code does: `"[rust]"`.
export function languageSectionKey(languageId: string): string {
  return `[${languageId}]`;
}

/// The language id inside a `"[rust]"` key, or `null` for an ordinary key.
export function languageIdFromSection(key: string): string | null {
  if (key.length < 3 || !key.startsWith("[") || !key.endsWith("]")) return null;
  return key.slice(1, -1);
}

/// Serialise the editor settings to dotted JSON.
///
/// Every setting is written, not only the modified ones. A settings file that
/// omits its defaults is smaller and much harder to edit — the whole point of
/// the text view is being able to see and change any option without knowing its
/// name in advance.
///
/// Keys the schema does not know are written last and verbatim, so opening the
/// JSON view on a config from a newer build and saving it does not eat fields.
export function toSettingsJson(editor: EditorSettings): string {
  const values = editor as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const s of EDITOR_SETTING_LIST) out[s.id] = values[s.key];

  for (const [language, patch] of Object.entries(editor.languageOverrides)) {
    const section: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      const setting = EDITOR_SETTING_LIST.find((s) => s.key === key);
      section[setting ? setting.id : key] = value;
    }
    if (Object.keys(section).length > 0) out[languageSectionKey(language)] = section;
  }

  const known = new Set<string>(EDITOR_SETTING_LIST.map((s) => s.key as string));
  known.add("languageOverrides");
  for (const [key, value] of Object.entries(values)) {
    if (!known.has(key)) out[key] = value;
  }

  return `${JSON.stringify(out, null, 2)}\n`;
}

export type SettingsJsonResult =
  | { ok: true; editor: EditorSettings }
  | { ok: false; error: string; line?: number };

/// Parse dotted JSON back into the shape the store holds.
///
/// A failure returns a message and **leaves the caller's store untouched** —
/// the dialog surfaces the message inline rather than silently discarding the
/// edit, because a text pane that quietly drops what you typed is worse than
/// one that refuses it.
///
/// Values that parse as JSON but do not validate against the table are *not* an
/// error: `parseEditorSettings` falls each of them back to its default, exactly
/// as it does for a blob loaded from localStorage. Malformed JSON is the only
/// thing this rejects, because it is the only thing with no defined meaning.
export function parseSettingsJson(text: string): SettingsJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: jsonErrorMessage(e, text), line: jsonErrorLine(e, text) };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: "Settings must be a JSON object.", line: 1 };
  }

  const nested: Record<string, unknown> = {};
  const languageOverrides: Record<string, Record<string, unknown>> = {};

  for (const [key, value] of Object.entries(parsed)) {
    const language = languageIdFromSection(key);
    if (language) {
      if (!isPlainObject(value)) continue;
      const patch: Record<string, unknown> = {};
      for (const [innerKey, innerValue] of Object.entries(value)) {
        const setting = settingById(innerKey);
        patch[setting ? (setting.key as string) : innerKey] = innerValue;
      }
      languageOverrides[language] = patch;
      continue;
    }
    const setting = settingById(key);
    nested[setting ? (setting.key as string) : key] = value;
  }

  nested.languageOverrides = languageOverrides;
  // One parse, one set of rules: the same validation, clamping and unknown-key
  // preservation a blob from localStorage goes through.
  return { ok: true, editor: parseEditorSettings(nested) };
}

/// `JSON.parse`'s message, trimmed to something a settings pane can show. V8
/// includes a byte position and other engines a line number; both spellings are
/// handled because neither is specified.
function jsonErrorMessage(e: unknown, text: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  const line = jsonErrorLine(e, text);
  const cleaned = raw.replace(/^JSON\.parse:\s*/, "").replace(/\s*in JSON at position.*$/, "");
  return line ? `Line ${line}: ${cleaned}` : cleaned;
}

function jsonErrorLine(e: unknown, text: string): number | undefined {
  const raw = e instanceof Error ? e.message : String(e);
  const explicit = raw.match(/line (\d+)/i);
  if (explicit) return Number(explicit[1]);
  const position = raw.match(/position (\d+)/i);
  if (!position) return undefined;
  const offset = Math.min(Number(position[1]), text.length);
  return text.slice(0, offset).split("\n").length;
}

/// A JSON Schema for the dotted form, generated from the table.
///
/// Handed to `monaco.languages.json.jsonDefaults.setDiagnosticsOptions` so the
/// JSON pane gets completion over every setting id, hover text from each
/// entry's description, and inline squiggles on a bad enum member — for free,
/// and impossible to let drift, because it is the same table the GUI renders.
export function settingsJsonSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const s of EDITOR_SETTING_LIST) properties[s.id] = propertySchema(s);

  return {
    type: "object",
    title: "VoidLink editor settings",
    properties,
    // `[rust]`, `[typescript]` — any Monaco language id, holding the same
    // properties. `additionalProperties` stays permissive at the top level so a
    // key from a newer build is not squiggled as an error in an older one.
    patternProperties: {
      "^\\[[^\\]]+\\]$": {
        type: "object",
        description: "Settings that apply only to this Monaco language id.",
        properties,
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  };
}

function propertySchema(s: EditorSetting): Record<string, unknown> {
  const common = { description: s.description, default: s.default, title: s.label };
  switch (s.kind) {
    case "boolean":
      return { ...common, type: "boolean" };
    case "number":
      return { ...common, type: "number", minimum: s.min, maximum: s.max };
    case "enum":
      return {
        ...common,
        type: "string",
        enum: s.members.map((m) => m.value),
        enumDescriptions: s.members.map((m) => m.label),
      };
    case "string":
      return { ...common, type: "string" };
    case "numberList":
      return {
        ...common,
        type: "array",
        items: { type: "number", minimum: s.min, maximum: s.max },
      };
    case "pathMap":
      return { ...common, type: "object", additionalProperties: { type: "string" } };
  }
}

/// Apply one language override patch, dropping the language entirely when the
/// patch empties out. Kept here so the GUI's per-language section and the JSON
/// view produce byte-identical stores.
export function withLanguageOverride(
  editor: EditorSettings,
  languageId: string,
  patch: Partial<EditorCoreSettings>,
): Record<string, Partial<EditorCoreSettings>> {
  const next = { ...editor.languageOverrides };
  const merged = { ...(next[languageId] ?? {}), ...patch } as Record<string, unknown>;
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  if (Object.keys(merged).length === 0) delete next[languageId];
  else next[languageId] = merged as Partial<EditorCoreSettings>;
  return next;
}

/// Drop one field from one language's override — the per-setting reset inside
/// the language section.
export function withoutLanguageOverride(
  editor: EditorSettings,
  languageId: string,
  key: keyof EditorCoreSettings,
): Record<string, Partial<EditorCoreSettings>> {
  const next = { ...editor.languageOverrides };
  const patch = { ...(next[languageId] ?? {}) } as Record<string, unknown>;
  delete patch[key as string];
  if (Object.keys(patch).length === 0) delete next[languageId];
  else next[languageId] = patch as Partial<EditorCoreSettings>;
  return next;
}
