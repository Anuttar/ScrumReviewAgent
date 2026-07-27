// ═══════════════════════════════════════════════════════════════════════════
// SharePoint Operations — Document library, list, and site access
// Uses graphRequest (fetch-based) instead of the heavy Graph SDK.
// ═══════════════════════════════════════════════════════════════════════════

import { graphRequest, graphDownload } from "./auth.js";
import mammoth from "mammoth";

async function parsePdf(buffer: Buffer): Promise<{ text: string; numpages: number }> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return { text: result.text, numpages: result.total };
}

export interface DocumentInfo {
  name: string;
  path: string;
  url: string;
  lastModified: string;
  modifiedBy: string;
  size: number;
  type: string;
}

export interface ListItem {
  id: string;
  title: string;
  fields: Record<string, any>;
  createdAt: string;
  modifiedAt: string;
}

function extractSiteId(siteUrl: string): string {
  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    throw new Error(`Invalid SharePoint URL: "${siteUrl}". Expected format: https://company.sharepoint.com/sites/SiteName`);
  }
  if (!url.protocol.startsWith("http")) {
    throw new Error(`Invalid SharePoint URL protocol: "${url.protocol}". Must be https.`);
  }
  const hostName = url.hostname;
  const pathParts = url.pathname.split("/").filter(Boolean);

  for (const segment of ["sites", "teams"]) {
    const segmentIndex = pathParts.indexOf(segment);
    if (segmentIndex >= 0 && segmentIndex + 1 < pathParts.length) {
      const siteName = pathParts[segmentIndex + 1];
      return `${hostName}:/${segment}/${siteName}`;
    }
  }

  const sitePath = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  return `${hostName}:/${sitePath}`;
}

const MAX_CACHE_SIZE = 200;
const siteIdCache = new Map<string, string>();

function cacheSet(key: string, value: string): void {
  if (siteIdCache.size >= MAX_CACHE_SIZE) {
    const firstKey = siteIdCache.keys().next().value;
    if (firstKey) siteIdCache.delete(firstKey);
  }
  siteIdCache.set(key, value);
}

async function resolveSiteId(siteUrl: string): Promise<string> {
  const cacheKey = siteUrl.toLowerCase().replace(/\/+$/, "");
  if (siteIdCache.has(cacheKey)) return siteIdCache.get(cacheKey)!;

  const directSiteId = extractSiteId(siteUrl);

  try {
    const site = await graphRequest("GET", `/sites/${directSiteId}?$select=id,webUrl`);
    if (site?.id) {
      cacheSet(cacheKey, site.id);
      return site.id;
    }
  } catch {
    // Fall back to search below
  }

  const url = new URL(siteUrl);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const siteName = pathParts[pathParts.length - 1];
  if (!siteName) throw new Error(`Could not extract SharePoint site name from ${siteUrl}`);

  const response = await graphRequest("GET", `/sites?search=${encodeURIComponent(siteName)}&$top=10`);
  const normalizedUrl = siteUrl.toLowerCase().replace(/\/$/, "");
  const matchingSite = response.value?.find((site: any) =>
    site.webUrl?.toLowerCase().replace(/\/$/, "") === normalizedUrl
  ) || response.value?.find((site: any) =>
    site.webUrl?.toLowerCase().includes(`/${siteName.toLowerCase()}`)
  ) || response.value?.[0];

  if (!matchingSite?.id) {
    throw new Error(`SharePoint site not found: ${siteUrl}`);
  }

  cacheSet(cacheKey, matchingSite.id);
  return matchingSite.id;
}

export async function listDocuments(
  siteUrl: string,
  library: string,
  folderPath: string | undefined,
  count: number
): Promise<DocumentInfo[]> {
  const siteId = await resolveSiteId(siteUrl);
  const drivesResponse = await graphRequest("GET", `/sites/${siteId}/drives`);

  const drive = drivesResponse.value.find((d: any) => d.name === library);
  if (!drive) throw new Error(`Library "${library}" not found`);

  if (folderPath && (folderPath.includes("..") || /^[\/\\]/.test(folderPath))) {
    throw new Error("Invalid folder path: must be relative and cannot contain '..'");
  }

  const itemsEndpoint = folderPath
    ? `/drives/${drive.id}/root:/${folderPath}:/children?$top=${count}`
    : `/drives/${drive.id}/root/children?$top=${count}`;

  const response = await graphRequest("GET", itemsEndpoint);

  return response.value.map((item: any) => ({
    name: item.name,
    path: item.parentReference?.path || "",
    url: item.webUrl,
    lastModified: item.lastModifiedDateTime,
    modifiedBy: item.lastModifiedBy?.user?.displayName || "Unknown",
    size: item.size || 0,
    type: item.folder ? "folder" : item.file?.mimeType || "file",
  }));
}

function escapeSearchTerm(term: string): string {
  return `"${term.replace(/"/g, "")}"`;
}

export async function searchDocuments(
  query: string,
  siteUrl: string | undefined,
  fileType: string | undefined,
  count: number
): Promise<any[]> {
  let searchQuery = escapeSearchTerm(query);
  if (fileType) searchQuery += ` filetype:${fileType.replace(/[^a-zA-Z0-9]/g, "")}`;
  if (siteUrl) searchQuery += ` site:${siteUrl.replace(/["']/g, "")}`;

  const response = await graphRequest("POST", "/search/query", {
    requests: [
      {
        entityTypes: ["driveItem"],
        query: { queryString: searchQuery },
        size: count,
      },
    ],
  });

  const hits = response.value?.[0]?.hitsContainers?.[0]?.hits || [];
  return hits.map((hit: any) => ({
    name: hit.resource?.name,
    url: hit.resource?.webUrl,
    lastModified: hit.resource?.lastModifiedDateTime,
    summary: hit.summary,
  }));
}

export async function getDocumentContent(
  documentUrl: string,
  metadataOnly: boolean
): Promise<string> {
  const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024; // 50MB limit

  // Encode URL for sharing API
  const encodedUrl = Buffer.from(documentUrl).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // Get drive item metadata
  const driveItem = await graphRequest("GET", `/shares/u!${encodedUrl}/driveItem`);

  if (metadataOnly) {
    const fields = Object.entries(driveItem)
      .filter(([k]) => !k.startsWith("@") && typeof k === "string")
      .filter(([_, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => `| ${k} | ${v} |`)
      .join("\n");
    return `## Document Metadata\n\n| Field | Value |\n|-------|-------|\n${fields}`;
  }

  // Check file size before downloading
  const fileSize = driveItem.size ?? 0;
  if (fileSize > MAX_DOWNLOAD_SIZE) {
    return `⚠️ File too large to extract (${(fileSize / 1024 / 1024).toFixed(1)} MB). Max supported: 50 MB. Use metadataOnly=true to see file details.`;
  }

  // Determine file type
  const fileName: string = driveItem.name || "";
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  // Download the file content
  const downloadUrl = driveItem["@microsoft.graph.downloadUrl"];
  if (!downloadUrl) {
    const driveId = driveItem.parentReference?.driveId;
    const itemId = driveItem.id;
    if (!driveId || !itemId) {
      return "Could not resolve download URL for this document.";
    }
    const buffer = await graphDownload(`/drives/${driveId}/items/${itemId}/content`);
    return extractText(buffer, ext, fileName);
  }

  const buffer = await graphDownload(downloadUrl);
  return extractText(buffer, ext, fileName);
}

async function extractText(buffer: Buffer, ext: string, fileName: string): Promise<string> {
  const MAX_LENGTH = 50_000;

  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.slice(0, MAX_LENGTH);
    const header = `## 📄 ${fileName}\n\n`;
    return header + text + (result.value.length > MAX_LENGTH ? "\n\n*[...truncated]*" : "");
  }

  if (ext === "pdf") {
    const data = await parsePdf(buffer);
    const text = data.text.slice(0, MAX_LENGTH);
    const header = `## 📄 ${fileName} (${data.numpages} pages)\n\n`;
    return header + text + (data.text.length > MAX_LENGTH ? "\n\n*[...truncated]*" : "");
  }

  if (ext === "txt" || ext === "md" || ext === "csv" || ext === "json") {
    const text = buffer.toString("utf-8").slice(0, MAX_LENGTH);
    const header = `## 📄 ${fileName}\n\n`;
    return header + text;
  }

  if (ext === "pptx") {
    try {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(buffer);
      const texts: string[] = [];
      const slideFiles = Object.keys(zip.files)
        .filter(f => f.match(/^ppt\/slides\/slide\d+\.xml$/))
        .sort();
      for (const slideFile of slideFiles) {
        const xml = await zip.files[slideFile].async("text");
        const matches = xml.match(/<a:t>([^<]*)<\/a:t>/g) || [];
        const slideText = matches.map(m => m.replace(/<\/?a:t>/g, "")).join(" ");
        if (slideText.trim()) texts.push(slideText.trim());
      }
      const text = texts.join("\n\n").slice(0, MAX_LENGTH);
      const header = `## 📄 ${fileName} (${slideFiles.length} slides)\n\n`;
      return header + text;
    } catch {
      return `Cannot extract text from ${fileName}. File type: pptx`;
    }
  }

  if (ext === "xlsx") {
    try {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(buffer);

      // Parse shared strings
      const sharedStrings: string[] = [];
      const ssFile = zip.files["xl/sharedStrings.xml"];
      if (ssFile) {
        const ssXml = await ssFile.async("text");
        const siMatches = ssXml.match(/<si>([\s\S]*?)<\/si>/g) || [];
        for (const si of siMatches) {
          const tMatches = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
          const cellText = tMatches.map(m => m.replace(/<\/?t[^>]*>/g, "")).join("");
          sharedStrings.push(cellText);
        }
      }

      // Find the first worksheet
      const sheetFile = zip.files["xl/worksheets/sheet1.xml"];
      if (!sheetFile) {
        return `Cannot extract table from ${fileName}: no sheet1 found.`;
      }
      const sheetXml = await sheetFile.async("text");

      // Parse rows
      const rowMatches = sheetXml.match(/<row[^>]*>([\s\S]*?)<\/row>/g) || [];
      const rows: string[][] = [];
      let maxCol = 0;

      for (const rowXml of rowMatches) {
        const cellMatches = rowXml.match(/<c[^>]*>[\s\S]*?<\/c>|<c[^/]*\/>/g) || [];
        const rowData: Map<number, string> = new Map();

        for (const cellXml of cellMatches) {
          // Get cell reference (e.g. "A1", "B2")
          const refMatch = cellXml.match(/r="([A-Z]+)\d+"/);
          if (!refMatch) continue;
          const colLetters = refMatch[1];
          const colIndex = colLetters.split("").reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1;

          // Get cell type
          const typeMatch = cellXml.match(/t="([^"]*)"/);
          const cellType = typeMatch ? typeMatch[1] : "n";

          // Get cell value
          const valueMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/);
          let value = "";

          if (valueMatch) {
            if (cellType === "s") {
              // Shared string reference
              const idx = parseInt(valueMatch[1], 10);
              value = sharedStrings[idx] || "";
            } else {
              value = valueMatch[1];
            }
          }

          // Round numeric values for cleaner display
          if (cellType === "n" && value && !isNaN(Number(value))) {
            const num = parseFloat(value);
            value = num === Math.floor(num) ? num.toString() : num.toFixed(2).replace(/\.?0+$/, "");
          }

          rowData.set(colIndex, value);
          if (colIndex + 1 > maxCol) maxCol = colIndex + 1;
        }

        const row: string[] = [];
        for (let i = 0; i < maxCol; i++) {
          row.push(rowData.get(i) || "");
        }
        rows.push(row);
      }

      if (rows.length === 0) {
        return `No data found in ${fileName}.`;
      }

      // Build markdown table
      const header = `## 📄 ${fileName}\n\n`;
      const lines: string[] = [];

      // First row as table header
      const headerRow = rows[0];
      lines.push("| " + headerRow.map(h => h || " ").join(" | ") + " |");
      lines.push("| " + headerRow.map(() => "---").join(" | ") + " |");

      // Data rows
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        // Skip completely empty rows
        if (row.every(cell => !cell.trim())) continue;
        // Pad row to header length
        while (row.length < headerRow.length) row.push("");
        lines.push("| " + row.map(cell => cell.replace(/\|/g, "\\|")).join(" | ") + " |");
      }

      const text = lines.join("\n").slice(0, MAX_LENGTH);
      return header + text;
    } catch (e) {
      return `Cannot extract text from ${fileName}. File type: xlsx. Error: ${e}`;
    }
  }

  return `Unsupported file type: .${ext}. Supported: docx, pdf, pptx, xlsx, txt, md, csv, json`;
}

export async function listSites(query?: string): Promise<any[]> {
  const searchTerm = query ? encodeURIComponent(query) : "*";
  const response = await graphRequest("GET", `/sites?search=${searchTerm}&$top=25`);
  return response.value.map((site: any) => ({
    name: site.displayName,
    url: site.webUrl,
    description: site.description,
    id: site.id,
  }));
}

export async function getListItems(
  siteUrl: string,
  listName: string,
  filter: string | undefined,
  count: number
): Promise<ListItem[]> {
  const siteId = await resolveSiteId(siteUrl);

  const safeListName = listName.replace(/[^a-zA-Z0-9 _-]/g, "");
  let endpoint = `/sites/${siteId}/lists/${encodeURIComponent(safeListName)}/items?expand=fields&$top=${count}`;
  if (filter) {
    const hasDangerousChars = /[;{}[\]\\]/.test(filter.replace(/(contains|startswith|endswith)\s*\(/gi, ""));
    if (hasDangerousChars) {
      throw new Error("Invalid filter expression: contains disallowed characters.");
    }
    endpoint += `&$filter=${encodeURIComponent(filter)}`;
  }

  const response = await graphRequest("GET", endpoint);
  return response.value.map((item: any) => ({
    id: item.id,
    title: item.fields?.Title || item.fields?.Name || `Item ${item.id}`,
    fields: item.fields || {},
    createdAt: item.createdDateTime,
    modifiedAt: item.lastModifiedDateTime,
  }));
}

export async function getRecentChanges(
  siteUrl: string,
  days: number
): Promise<string> {
  const siteId = await resolveSiteId(siteUrl);

  const since = new Date();
  since.setDate(since.getDate() - days);

  const drivesResponse = await graphRequest("GET", `/sites/${siteId}/drives`);

  const results: string[] = [`## Recent Changes (last ${days} days)\n`];

  for (const drive of drivesResponse.value.slice(0, 3)) {
    try {
      const response = await graphRequest("GET", `/drives/${drive.id}/recent?$top=10`);
      const items = response.value.filter(
        (item: any) => new Date(item.lastModifiedDateTime) > since
      );
      if (items.length > 0) {
        results.push(`### ${drive.name}\n`);
        results.push("| File | Modified | By |");
        results.push("|------|----------|-----|");
        for (const item of items) {
          results.push(
            `| ${item.name} | ${new Date(item.lastModifiedDateTime).toLocaleDateString()} | ${item.lastModifiedBy?.user?.displayName || "?"} |`
          );
        }
        results.push("");
      }
    } catch {
      // Skip drives we can't access
    }
  }

  return results.length > 1 ? results.join("\n") : "No recent changes found.";
}
