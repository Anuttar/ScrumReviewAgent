import { describe, test, expect } from 'vitest';
import { formatDocumentList, formatSearchResults, formatListItems } from '../src/sharepoint/formatters.js';
import type { DocumentInfo, ListItem } from '../src/sharepoint/sharepoint.js';

describe('formatDocumentList', () => {
  test('returns a "No documents" message for an empty list', () => {
    expect(formatDocumentList([], 'Team Capacity')).toBe('No documents found in "Team Capacity".');
  });

  test('renders a markdown table with folder/file icons and formatted sizes', () => {
    const docs: DocumentInfo[] = [
      { name: 'Sprint 14.xlsx', path: '/Sprint 14.xlsx', type: 'file', size: 2048, lastModified: '2026-07-06T00:00:00Z', modifiedBy: 'Alice', url: 'https://example.com/a' },
      { name: 'Archive', path: '/Archive', type: 'folder', size: 0, lastModified: '2026-07-01T00:00:00Z', modifiedBy: 'Bob', url: 'https://example.com/b' },
    ];

    const result = formatDocumentList(docs, 'Team Capacity');
    expect(result).toContain('## 📂 Team Capacity (2 items)');
    expect(result).toContain('| Name | Type | Modified | By | Size |');
    expect(result).toContain('📊 Sprint 14.xlsx'); // xlsx icon
    expect(result).toContain('2.0 KB');
    expect(result).toContain('📁 Archive');
    expect(result).toContain('| - |'); // folder size shown as "-"
  });

  test('escapes markdown-breaking characters in names and metadata', () => {
    const docs: DocumentInfo[] = [
      { name: 'Weird | Name`.txt', path: '/w.txt', type: 'file', size: 10, lastModified: '2026-07-06T00:00:00Z', modifiedBy: 'A\nB', url: 'https://example.com/c' },
    ];

    const result = formatDocumentList(docs, 'Docs');
    expect(result).toContain('Weird \\| Name\\`.txt');
    expect(result).toContain('A B'); // newline replaced with space
    expect(result).not.toContain('A\nB');
  });

  test('formats sizes in B, KB, and MB depending on magnitude', () => {
    const docs: DocumentInfo[] = [
      { name: 'tiny.txt', path: '/tiny.txt', type: 'file', size: 500, lastModified: '2026-07-06T00:00:00Z', modifiedBy: 'A', url: 'u1' },
      { name: 'big.zip', path: '/big.zip', type: 'file', size: 5 * 1024 * 1024, lastModified: '2026-07-06T00:00:00Z', modifiedBy: 'A', url: 'u2' },
    ];

    const result = formatDocumentList(docs, 'Docs');
    expect(result).toContain('500 B');
    expect(result).toContain('5.0 MB');
  });
});

describe('formatSearchResults', () => {
  test('returns a "No documents" message for an empty result set', () => {
    expect(formatSearchResults([], 'sprint report')).toBe('No documents found for "sprint report".');
  });

  test('renders a markdown table with links and summaries', () => {
    const results = [
      { name: 'Report.pdf', url: 'https://example.com/report.pdf', lastModified: '2026-07-06T00:00:00Z', summary: 'Sprint 14 summary' },
      { name: 'NoSummary.docx', url: 'https://example.com/x.docx' },
    ];

    const result = formatSearchResults(results, 'sprint report');
    expect(result).toContain('## 🔍 Search Results for "sprint report" (2)');
    expect(result).toContain('[Report.pdf](https://example.com/report.pdf)');
    expect(result).toContain('Sprint 14 summary');
    expect(result).toContain('[NoSummary.docx](https://example.com/x.docx) | - | - |'); // missing lastModified/summary default to "-"
  });
});

describe('formatListItems', () => {
  test('returns a "No items" message for an empty list', () => {
    expect(formatListItems([], 'Risks')).toBe('No items found in "Risks".');
  });

  test('renders a markdown table with id, title, created and modified dates', () => {
    const items: ListItem[] = [
      { id: '1', title: 'Risk: vendor delay', fields: {}, createdAt: '2026-07-01T00:00:00Z', modifiedAt: '2026-07-05T00:00:00Z' },
    ];

    const result = formatListItems(items, 'Risks');
    expect(result).toContain('## 📋 Risks (1 items)');
    expect(result).toContain('Risk: vendor delay');
    expect(result).toContain('| 1 |');
  });

  test('escapes markdown special characters in the title', () => {
    const items: ListItem[] = [
      { id: '2', title: 'A | B `C`', fields: {}, createdAt: '2026-07-01T00:00:00Z', modifiedAt: '2026-07-05T00:00:00Z' },
    ];

    const result = formatListItems(items, 'Risks');
    expect(result).toContain('A \\| B \\`C\\`');
  });
});
