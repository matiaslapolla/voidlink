import type { Editor, JSONContent } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useState } from "react";

interface ExportMenuProps {
  editor: Editor;
}

function htmlToPlainText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent ?? "";
}

interface TableRow {
  type: string;
  content: string;
  level?: number;
}

function getNodeText(node: JSONContent): string {
  return (node.content ?? [])
    .map((c) => c.text ?? "")
    .join("");
}

function getListItemText(item: JSONContent): string {
  return (item.content ?? [])
    .flatMap((p) => (p.content ?? []).map((c) => c.text ?? ""))
    .join("");
}

function extractStructuredData(editor: Editor): TableRow[] {
  const rows: TableRow[] = [];
  const json = editor.getJSON();

  for (const node of json.content ?? []) {
    const textContent = getNodeText(node);

    switch (node.type) {
      case "heading":
        rows.push({
          type: `h${node.attrs?.level ?? 1}`,
          content: textContent,
          level: node.attrs?.level as number | undefined,
        });
        break;
      case "paragraph":
        if (textContent) rows.push({ type: "paragraph", content: textContent });
        break;
      case "bulletList":
      case "orderedList":
        for (const item of node.content ?? []) {
          rows.push({
            type: node.type === "bulletList" ? "bullet" : "numbered",
            content: getListItemText(item),
          });
        }
        break;
      case "taskList":
        for (const item of node.content ?? []) {
          const checked = (item as JSONContent).attrs?.checked ? "[x]" : "[ ]";
          rows.push({ type: "task", content: `${checked} ${getListItemText(item)}` });
        }
        break;
      case "codeBlock":
        rows.push({ type: "code", content: textContent });
        break;
      case "blockquote":
        for (const child of node.content ?? []) {
          rows.push({ type: "quote", content: getNodeText(child) });
        }
        break;
      default:
        if (textContent) rows.push({ type: node.type ?? "text", content: textContent });
    }
  }

  return rows;
}

function toCsv(rows: TableRow[]): string {
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const header = "type,content,level";
  const lines = rows.map(
    (r) => `${escape(r.type)},${escape(r.content)},${r.level ?? ""}`,
  );
  return [header, ...lines].join("\n");
}

function download(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const isTauri = "__TAURI_INTERNALS__" in window;

async function saveWithDialog(
  content: string,
  defaultPath: string,
  filterName: string,
  extension: string,
) {
  if (isTauri) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath,
        filters: [{ name: filterName, extensions: [extension] }],
      });
      if (path) {
        await writeTextFile(path, content);
      }
      return;
    } catch {
      // fall through to blob download
    }
  }
  download(content, defaultPath, "text/plain");
}

export function ExportMenu({ editor }: ExportMenuProps) {
  const [open, setOpen] = useState(false);

  const exportCsv = async () => {
    const data = extractStructuredData(editor);
    await saveWithDialog(toCsv(data), "export.csv", "CSV", "csv");
    setOpen(false);
  };

  const exportJson = async () => {
    const data = extractStructuredData(editor);
    await saveWithDialog(
      JSON.stringify(data, null, 2),
      "export.json",
      "JSON",
      "json",
    );
    setOpen(false);
  };

  const exportMarkdown = async () => {
    const html = editor.getHTML();
    const text = htmlToPlainText(html);
    await saveWithDialog(text, "export.md", "Markdown", "md");
    setOpen(false);
  };

  return (
    <div className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
        Export
      </Button>
      {open && (
        <div className="absolute top-full right-0 mt-1 bg-popover border border-border rounded-lg shadow-md p-1 min-w-[140px] z-50">
          <TooltipWrapper label="Export as CSV — structured rows and columns">
            <button
              className="w-full text-left px-3 py-1.5 text-sm rounded-md hover:bg-accent"
              onClick={exportCsv}
            >
              CSV
            </button>
          </TooltipWrapper>
          <TooltipWrapper label="Export as JSON — full document structure with metadata">
            <button
              className="w-full text-left px-3 py-1.5 text-sm rounded-md hover:bg-accent"
              onClick={exportJson}
            >
              JSON
            </button>
          </TooltipWrapper>
          <TooltipWrapper label="Export as Markdown text">
            <button
              className="w-full text-left px-3 py-1.5 text-sm rounded-md hover:bg-accent"
              onClick={exportMarkdown}
            >
              Plain Text
            </button>
          </TooltipWrapper>
        </div>
      )}
    </div>
  );
}
