/// Searching the settings table.
///
/// The dialog cannot grow another thirty rows and stay usable; what makes VS
/// Code's settings work at that size is a filter box and a "modified" filter,
/// both of which need the settings to be data. They are, so this is small.
///
/// Uses `commands/fuzzy.ts` — the one scorer, with its matched-character
/// ranges, so a hit here highlights exactly the way a palette hit does. There
/// is deliberately no second matcher in this file.
///
/// DOM-free: `SettingsDialog.tsx` renders what this returns.

import { bestFuzzyMatch, type MatchRange } from "@/commands/fuzzy";
import {
  EDITOR_SETTING_LIST,
  isModified,
  type EditorSetting,
  type SettingSection,
} from "./settingsSchema";
import type { EditorSettings } from "./settings";

export interface SettingHit {
  setting: EditorSetting;
  /// Which field matched — the label is what the dialog draws big, so a hit on
  /// the id or the description highlights the *secondary* line instead.
  field: "label" | "id" | "description" | "member";
  /// Matched character runs inside that field, for `FuzzyText`.
  ranges: MatchRange[];
  /// The enum member's label, when `field` is `"member"`. Searching "relative"
  /// has to find `editor.lineNumbers`, and saying which member it was is the
  /// difference between a useful result and a mysterious one.
  member?: string;
  modified: boolean;
}

export interface SettingFilter {
  query: string;
  modifiedOnly: boolean;
}

/// The searched fields, in the order `bestFuzzyMatch` reports them.
const FIELDS = ["label", "id", "description"] as const;

/// Filter and rank the table.
///
/// Order is by score, then by the table's own order — so an empty query with
/// `modifiedOnly` off returns every setting in exactly the order the sections
/// declare, which is the resting state of the dialog.
export function searchSettings(
  filter: SettingFilter,
  current: EditorSettings,
): SettingHit[] {
  const values = current as unknown as Record<string, unknown>;
  const query = filter.query.trim();
  const out: { hit: SettingHit; score: number; index: number }[] = [];

  EDITOR_SETTING_LIST.forEach((setting, index) => {
    const modified = isModified(setting, values[setting.key]);
    if (filter.modifiedOnly && !modified) return;

    if (!query) {
      out.push({ hit: { setting, field: "label", ranges: [], modified }, score: 0, index });
      return;
    }

    const direct = bestFuzzyMatch(
      [setting.label, setting.id, setting.description],
      query,
    );
    const member = matchMember(setting, query);

    // A member hit only wins when nothing on the setting itself matched
    // better — typing "line" should land on "Line numbers", not on the "Line"
    // member of the cursor style.
    if (direct && (!member || direct.match.score >= member.score)) {
      out.push({
        hit: {
          setting,
          field: FIELDS[direct.field],
          ranges: direct.match.ranges,
          modified,
        },
        score: direct.match.score,
        index,
      });
      return;
    }
    if (member) {
      out.push({
        hit: {
          setting,
          field: "member",
          ranges: member.ranges,
          member: member.label,
          modified,
        },
        score: member.score,
        index,
      });
    }
  });

  out.sort((a, b) => b.score - a.score || a.index - b.index);
  return out.map((o) => o.hit);
}

/// The best-matching enum member of one setting, matched on both its stored
/// value (`wordWrapColumn`) and its display label (`Column`) — the user has
/// seen one of them and may be typing either.
function matchMember(
  setting: EditorSetting,
  query: string,
): { score: number; ranges: MatchRange[]; label: string } | null {
  if (setting.kind !== "enum") return null;
  let best: { score: number; ranges: MatchRange[]; label: string } | null = null;
  for (const m of setting.members) {
    const match = bestFuzzyMatch([m.label, m.value], query);
    if (!match) continue;
    if (!best || match.match.score > best.score) {
      best = { score: match.match.score, ranges: match.match.ranges, label: m.label };
    }
  }
  return best;
}

/// Group hits back into their sections for rendering, dropping the sections
/// that no hit landed in. Keeps the table's section order.
export function groupHits(hits: SettingHit[]): { section: SettingSection; hits: SettingHit[] }[] {
  const bySection = new Map<SettingSection, SettingHit[]>();
  for (const hit of hits) {
    const list = bySection.get(hit.setting.section);
    if (list) list.push(hit);
    else bySection.set(hit.setting.section, [hit]);
  }
  return [...bySection].map(([section, list]) => ({ section, hits: list }));
}

/// How many settings differ from their default. Drives the count on the
/// "Modified" filter chip — a filter that might return nothing should say so
/// before you press it (MASTER §7.6: no dead affordance).
export function modifiedCount(current: EditorSettings): number {
  const values = current as unknown as Record<string, unknown>;
  return EDITOR_SETTING_LIST.filter((s) => isModified(s, values[s.key])).length;
}
