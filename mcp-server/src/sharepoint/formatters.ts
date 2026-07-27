// ═══════════════════════════════════════════════════════════════════════════
// SharePoint Formatters — Render results as Markdown tables
// ═══════════════════════════════════════════════════════════════════════════

import type { DocumentInfo, ListItem } from "./sharepoint.js";

/** Escape pipe, newline, and backtick characters to prevent markdown table injection */
function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/`/g, "\\`").replace(/\n/g, " ");
}

export function formatDocumentList(docs: DocumentInfo[], library: string): string {
  if (!docs.length) return `No documents found in "${library}".`;

  const lines = [
    `## 📂 ${library} (${docs.length} items)\n`,
    "| Name | Type | Modified | By | Size |",
    "|------|------|----------|-----|------|",
  ];

  for (const doc of docs) {
    const size = doc.type === "folder" ? "-" : formatSize(doc.size);
    const date = new Date(doc.lastModified).toLocaleDateString();
    const icon = doc.type === "folder" ? "📁" : getFileIcon(doc.name);
    lines.push(`| ${icon} ${escapeMd(doc.name)} | ${escapeMd(doc.type)} | ${date} | ${escapeMd(doc.modifiedBy)} | ${size} |`);
  }

  return lines.join("\n");
}

export function formatSearchResults(results: any[], query: string): string {
  if (!results.length) return `No documents found for "${query}".`;

  const lines = [
    `## 🔍 Search Results for "${query}" (${results.length})\n`,
    "| Name | Modified | Summary |",
    "|------|----------|---------|",
  ];

  for (const r of results) {
    const date = r.lastModified ? new Date(r.lastModified).toLocaleDateString() : "-";
    lines.push(`| [${escapeMd(r.name || "")}](${r.url}) | ${date} | ${escapeMd(r.summary || "-")} |`);
  }

  return lines.join("\n");
}

export function formatListItems(items: ListItem[], listName: string): string {
  if (!items.length) return `No items found in "${listName}".`;

  const lines = [
    `## 📋 ${listName} (${items.length} items)\n`,
    "| # | Title | Created | Modified |",
    "|---|-------|---------|----------|",
  ];

  for (const item of items) {
    const created = new Date(item.createdAt).toLocaleDateString();
    const modified = new Date(item.modifiedAt).toLocaleDateString();
    lines.push(`| ${item.id} | ${escapeMd(item.title)} | ${created} | ${modified} |`);
  }

  return lines.join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf": return "📄";
    case "docx": case "doc": return "📝";
    case "xlsx": case "xls": return "📊";
    case "pptx": case "ppt": return "📽️";
    case "png": case "jpg": case "jpeg": return "🖼️";
    default: return "📄";
  }
}
