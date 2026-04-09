import { FileText, GitCommit, Search, MessageSquare } from "lucide-solid";
import type { ContextItemKind } from "@/types/context";

export const KIND_ICON: Record<ContextItemKind, any> = {
  "search-result": Search,
  file: FileText,
  "diff-hunk": GitCommit,
  freetext: MessageSquare,
};

export const KIND_LABEL: Record<ContextItemKind, string> = {
  "search-result": "Search",
  file: "File",
  "diff-hunk": "Diff",
  freetext: "Note",
};
