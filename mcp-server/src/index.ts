import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fetch from 'node-fetch';
import sharp from 'sharp';
import { AzureDevOpsClient, AzureDevOpsConfig, BugTrendData, DeliveryAnalysisResult } from './azure-devops-client.js';
import { getAuthStatus, logout, triggerLogin } from './sharepoint/auth.js';
import {
  listDocuments,
  searchDocuments,
  getDocumentContent,
  listSites,
  getListItems,
  getRecentChanges,
} from './sharepoint/sharepoint.js';
import { formatDocumentList, formatListItems, formatSearchResults } from './sharepoint/formatters.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read configuration from environment variables
function getConfig(): AzureDevOpsConfig {
  const orgUrl = process.env.AZURE_DEVOPS_ORG_URL;
  const project = process.env.AZURE_DEVOPS_PROJECT;
  const team = process.env.AZURE_DEVOPS_TEAM;
  const pat = process.env.AZURE_DEVOPS_PAT;

  if (!orgUrl || !project || !team || !pat) {
    throw new Error(
      'Missing required environment variables: AZURE_DEVOPS_ORG_URL, AZURE_DEVOPS_PROJECT, AZURE_DEVOPS_TEAM, AZURE_DEVOPS_PAT'
    );
  }

  return { orgUrl, project, team, pat };
}

const server = new McpServer({
  name: 'azure-devops-sprint',
  version: '1.0.0',
});

let client: AzureDevOpsClient;

try {
  client = new AzureDevOpsClient(getConfig());
} catch (error) {
  console.error('Failed to initialize Azure DevOps client:', error);
  process.exit(1);
}

// Tool: Get Current Sprint
server.tool(
  'get_current_sprint',
  'Get details about the current active sprint (name, dates, timeframe)',
  {},
  async () => {
    try {
      const sprint = await client.getCurrentSprint();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(sprint, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Sprint Work Items
server.tool(
  'get_sprint_work_items',
  'Get all work items (user stories, tasks, bugs) in the current or specified sprint',
  {
    iterationId: z.string().optional().describe('Sprint iteration ID. If not provided, uses current sprint.'),
  },
  async ({ iterationId }) => {
    try {
      let sprintId = iterationId;
      if (!sprintId) {
        const currentSprint = await client.getCurrentSprint();
        sprintId = currentSprint.id;
      }

      const workItems = await client.getSprintWorkItems(sprintId);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(workItems, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Sprint Burndown
server.tool(
  'get_sprint_burndown',
  'Create sprint burndown chart with Monday-Friday working-day ideal burn and development burn trajectories. Returns an annotated PNG line chart, day-by-day data grid, statistics, and optional CSV export.',
  {
    iterationId: z.string().optional().describe('Sprint iteration ID. If not provided, uses current sprint.'),
    queryDate: z.string().optional().describe('Date to highlight in YYYY-MM-DD format. If not provided, uses today.'),
    includeChart: z.boolean().default(true).describe('If true, includes a PNG burndown chart in the output.'),
    includeCsv: z.boolean().default(true).describe('If true, exports the burndown source data to a CSV file and returns the file path.'),
  },
  async ({ iterationId, queryDate, includeChart, includeCsv }) => {
    try {
      const burndown = await client.getSprintBurndown(iterationId, queryDate);

      const maxValue = Math.max(
        1,
        ...burndown.points.map((p) => Math.max(p.scope, p.developmentRemaining, p.idealRemaining, p.teamTargetRemaining))
      );
      const yAxisMax = Math.ceil(maxValue * 1.1);

      const queryPoint = burndown.points.find((p) => p.isQueryDate) || burndown.points[burndown.points.length - 1];
      const idealAtQuery = queryPoint ? queryPoint.idealRemaining : 0;
      const remainingAtQuery = queryPoint ? queryPoint.developmentRemaining : 0;
      const varianceAtQuery = Math.round((remainingAtQuery - idealAtQuery) * 100) / 100;
      const paceStatus = varianceAtQuery > 0 ? 'Behind ideal pace' : varianceAtQuery < 0 ? 'Ahead of ideal pace' : 'On ideal pace';
      const workingDaysLeft = Math.max(burndown.totalDays - (queryPoint?.dayIndex || burndown.totalDays), 0);
      const requiredDailyBurn = workingDaysLeft > 0 ? Math.round((remainingAtQuery / workingDaysLeft) * 100) / 100 : remainingAtQuery;

      const gridTable = burndown.points
        .map((p) => {
          const marker = p.isQueryDate ? ' <== TODAY' : '';
          return `| D${p.dayIndex} | ${p.dayLabel.replace(`Day ${p.dayIndex} `, '')} | ${p.idealRemaining} | ${p.developmentRemaining} | ${p.teamTargetRemaining}${marker} |`;
        })
        .join('\n');

      // CSV export from the same points used to render the chart
      const csvHeader = [
        'dayIndex',
        'dayLabel',
        'date',
        'scope',
        'completed',
        'remaining',
        'developmentRemaining',
        'teamTargetRemaining',
        'idealRemaining',
        'isQueryDate',
      ].join(',');
      const csvRows = burndown.points
        .map((p) => [
          p.dayIndex,
          `"${String(p.dayLabel).replace(/"/g, '""')}"`,
          p.date,
          p.scope,
          p.completed,
          p.remaining,
          p.developmentRemaining,
          p.teamTargetRemaining,
          p.idealRemaining,
          p.isQueryDate,
        ].join(','))
        .join('\n');
      const csvContent = `${csvHeader}\n${csvRows}`;

      // ─── SVG Annotated Burndown Chart ──────────────────────────────────────
      let svgChart: string | undefined;
      if (includeChart) {
        const points = burndown.points;
        const n = points.length;

        // Chart dimensions
        const margin = { top: 60, right: 30, bottom: 120, left: 70 };
        const width = 900;
        const height = 500;
        const plotW = width - margin.left - margin.right;
        const plotH = height - margin.top - margin.bottom;

        // Scales
        const xScale = (i: number) => margin.left + (i / Math.max(n - 1, 1)) * plotW;
        const yScale = (v: number) => margin.top + plotH - (v / yAxisMax) * plotH;

        // Build polyline strings
        const idealPolyline = points.map((p, i) => `${xScale(i)},${yScale(p.idealRemaining)}`).join(' ');
        const actualPolyline = points.map((p, i) => `${xScale(i)},${yScale(p.teamTargetRemaining)}`).join(' ');

        // Dots
        const idealDots = points.map((p, i) => `<circle cx="${xScale(i)}" cy="${yScale(p.idealRemaining)}" r="4" fill="#1f77b4"/>`).join('');
        const actualDots = points.map((p, i) => `<circle cx="${xScale(i)}" cy="${yScale(p.teamTargetRemaining)}" r="4" fill="#d62728"/>`).join('');

        // Grid lines (horizontal)
        const yTicks = 6;
        let gridLines = '';
        for (let t = 0; t <= yTicks; t++) {
          const val = Math.round((yAxisMax / yTicks) * t * 10) / 10;
          const y = yScale(val);
          gridLines += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e0e0e0" stroke-width="0.5"/>`;
          gridLines += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#333">${val}</text>`;
        }

        // X-axis labels (rotated)
        const xLabels = points.map((p, i) => {
          const x = xScale(i);
          const label = `Day ${p.dayIndex} (${p.date.slice(5).replace('-', '/')})`;
          return `<text x="${x}" y="${margin.top + plotH + 14}" text-anchor="end" font-size="9" fill="#333" transform="rotate(-45 ${x} ${margin.top + plotH + 14})">${label}</text>`;
        }).join('');

        // Today vertical dashed line
        const queryIdx = points.findIndex((p) => p.isQueryDate);
        let todayLine = '';
        if (queryIdx >= 0) {
          const tx = xScale(queryIdx);
          todayLine = `<line x1="${tx}" y1="${margin.top}" x2="${tx}" y2="${margin.top + plotH}" stroke="#555" stroke-width="1.2" stroke-dasharray="6,3"/>`;
          todayLine += `<text x="${tx + 4}" y="${margin.top - 5}" font-size="9" fill="#555" transform="rotate(-90 ${tx + 4} ${margin.top - 5})">Today (${points[queryIdx].date})</text>`;
        }

        // Scope horizontal dashed line
        const scopeY = yScale(burndown.totalScope);
        const scopeLine = `<line x1="${margin.left}" y1="${scopeY}" x2="${width - margin.right}" y2="${scopeY}" stroke="#999" stroke-width="1" stroke-dasharray="4,4"/>`;
        const scopeLabel = `<text x="${width - margin.right + 4}" y="${scopeY + 4}" font-size="9" fill="#999">Scope (${burndown.totalScope})</text>`;

        // Sprint start annotation
        const startAnnotation = `<text x="${xScale(0) + 4}" y="${yScale(points[0].idealRemaining) - 10}" font-size="9" fill="#1f77b4" font-style="italic">Sprint Start</text>`;
        // End annotation
        const endAnnotation = `<text x="${xScale(n - 1) + 4}" y="${yScale(0) + 4}" font-size="9" fill="#d62728" font-weight="bold">End</text>`;

        // Legend
        const legendX = width - margin.right - 180;
        const legendY = margin.top + 10;
        const legend = `
          <rect x="${legendX}" y="${legendY}" width="175" height="60" fill="white" stroke="#ccc" rx="4"/>
          <line x1="${legendX + 10}" y1="${legendY + 16}" x2="${legendX + 30}" y2="${legendY + 16}" stroke="#1f77b4" stroke-width="2"/>
          <circle cx="${legendX + 20}" cy="${legendY + 16}" r="3" fill="#1f77b4"/>
          <text x="${legendX + 36}" y="${legendY + 20}" font-size="10" fill="#333">Ideal Burndown</text>
          <line x1="${legendX + 10}" y1="${legendY + 34}" x2="${legendX + 30}" y2="${legendY + 34}" stroke="#d62728" stroke-width="2"/>
          <circle cx="${legendX + 20}" cy="${legendY + 34}" r="3" fill="#d62728"/>
          <text x="${legendX + 36}" y="${legendY + 38}" font-size="10" fill="#333">Actual Burndown</text>
          <line x1="${legendX + 10}" y1="${legendY + 52}" x2="${legendX + 30}" y2="${legendY + 52}" stroke="#999" stroke-width="1" stroke-dasharray="4,4"/>
          <text x="${legendX + 36}" y="${legendY + 56}" font-size="10" fill="#333">Scope (${burndown.totalScope})</text>`;

        // Stats annotation box
        const statsBoxX = width - margin.right - 260;
        const statsBoxY = margin.top + plotH - 90;
        const statsLines = [
          `Burndown as of Day ${queryPoint?.dayIndex} (${queryPoint?.date}):`,
          `  Remaining Work: ${remainingAtQuery} story points`,
          `  Initial Scope: ${burndown.startScope} story points`,
          `  Working Days Left: ${workingDaysLeft}`,
          `  Ideal Remaining (Day ${queryPoint?.dayIndex}): ${idealAtQuery} SP`,
          `  Required Daily Burn: ${requiredDailyBurn} SP/day`,
        ];
        const statsText = statsLines.map((line, i) =>
          `<text x="${statsBoxX + 8}" y="${statsBoxY + 14 + i * 13}" font-size="9" fill="#333" font-family="monospace">${line}</text>`
        ).join('');
        const statsBox = `<rect x="${statsBoxX}" y="${statsBoxY}" width="255" height="${statsLines.length * 13 + 10}" fill="white" stroke="#aaa" rx="3" opacity="0.92"/>${statsText}`;

        // Title
        const sprintStart = burndown.sprint.startDate.slice(0, 10);
        const sprintFinish = burndown.sprint.finishDate.slice(0, 10);
        const title = `${burndown.sprint.name} Burndown Chart — Avengers Team (${sprintStart} – ${sprintFinish})`;
        const titleEl = `<text x="${width / 2}" y="24" text-anchor="middle" font-size="14" font-weight="bold" fill="#333">${title}</text>`;

        // Y-axis label
        const yLabel = `<text x="14" y="${margin.top + plotH / 2}" text-anchor="middle" font-size="11" fill="#333" transform="rotate(-90 14 ${margin.top + plotH / 2})">Remaining Work (story points)</text>`;
        // X-axis label
        const xLabel = `<text x="${margin.left + plotW / 2}" y="${height - 5}" text-anchor="middle" font-size="11" fill="#333">Working Day (and Date)</text>`;

        svgChart = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family:Arial,sans-serif;">
<rect x="0" y="0" width="${width}" height="${height}" fill="white"/>
${titleEl}
${yLabel}
${xLabel}
<!-- Grid -->
${gridLines}
<!-- Axes -->
<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#333" stroke-width="1"/>
<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" stroke="#333" stroke-width="1"/>
<!-- Scope line -->
${scopeLine}${scopeLabel}
<!-- Ideal line -->
<polyline points="${idealPolyline}" fill="none" stroke="#1f77b4" stroke-width="2"/>
${idealDots}
<!-- Actual line -->
<polyline points="${actualPolyline}" fill="none" stroke="#d62728" stroke-width="2"/>
${actualDots}
<!-- Today marker -->
${todayLine}
<!-- Annotations -->
${startAnnotation}
${endAnnotation}
<!-- X labels -->
${xLabels}
<!-- Legend -->
${legend}
<!-- Stats box -->
${statsBox}
</svg>`;
      }

      // Build summary text
      const summaryText = [
        `## Sprint Burndown — ${burndown.sprint.name} (Avengers)`,
        `**Sprint Window:** ${burndown.sprint.startDate.slice(0, 10)} to ${burndown.sprint.finishDate.slice(0, 10)}`,
        `**Working Days:** ${burndown.totalDays} total | ${workingDaysLeft} remaining`,
        `**Report Date:** ${burndown.queryDate} (Day ${queryPoint?.dayIndex})`,
        ``,
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Initial Scope | ${burndown.startScope} SP |`,
        `| Total Scope | ${burndown.totalScope} SP |`,
        `| Completed | ${burndown.completedScope} SP |`,
        `| Remaining | ${burndown.currentRemaining} SP |`,
        `| Ideal Remaining (Day ${queryPoint?.dayIndex}) | ${idealAtQuery} SP |`,
        `| Gap vs Ideal | ${varianceAtQuery > 0 ? '+' : ''}${varianceAtQuery} SP |`,
        `| Pace Status | ${paceStatus} |`,
        `| Required Daily Burn | ${requiredDailyBurn} SP/day |`,
        ``,
        `### Day-by-Day Grid`,
        `| Day | Working Day | Ideal Remaining | Development Remaining | Team Target Remaining |`,
        `|---|---|---:|---:|---:|`,
        gridTable,
      ].join('\n');

      // Return image + text content blocks
      const contentBlocks: { type: string; text?: string; data?: string; mimeType?: string }[] = [];

      let chartTempPath: string | undefined;
      let csvTempPath: string | undefined;

      if (svgChart) {
        // Convert SVG → PNG (Outlook supports PNG; not SVG)
        const pngBuffer = await sharp(Buffer.from(svgChart, 'utf-8'))
          .png()
          .toBuffer();
        const pngBase64 = pngBuffer.toString('base64');

        // Save to temp file so draft_sprint_email can embed it
        chartTempPath = path.join(os.tmpdir(), 'sprint_burndown_chart.png');
        fs.writeFileSync(chartTempPath, pngBuffer);

        contentBlocks.push({
          type: 'image' as const,
          data: pngBase64,
          mimeType: 'image/png',
        });
      }

      if (includeCsv) {
        csvTempPath = path.join(os.tmpdir(), 'sprint_burndown_data.csv');
        fs.writeFileSync(csvTempPath, csvContent, 'utf-8');
      }

      const pathNotes: string[] = [];
      if (chartTempPath) {
        pathNotes.push(`> **Chart saved to:** \`${chartTempPath}\` — pass this path as \`chartImagePath\` to \`draft_sprint_email\` to embed the chart visually in Outlook.`);
      }
      if (csvTempPath) {
        pathNotes.push(`> **CSV saved to:** \`${csvTempPath}\` — exported from the same data points used to render the chart.`);
      }

      const summaryWithExports = pathNotes.length > 0
        ? `${summaryText}\n\n${pathNotes.join('\n')}`
        : summaryText;

      contentBlocks.push({
        type: 'text' as const,
        text: summaryWithExports,
      });

      return {
        content: contentBlocks as any,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Delivery Analysis for Feature/Epic
server.tool(
  'get_delivery_analysis',
  'Analyze the delivery progress of a Feature or Epic work item. Returns epic overview, delivery health snapshot, feature breakdown with effort, KPIs, observations, and recommendations.',
  {
    workItemId: z.number().describe('The work item ID of the Feature or Epic to analyze.'),
  },
  async ({ workItemId }) => {
    try {
      const result: DeliveryAnalysisResult = await client.getDeliveryAnalysis(workItemId);
      const p = result.parent;
      const prog = result.progress;
      const sp = result.storyPoints;
      const tl = result.timeline;
      const orgUrl = process.env.AZURE_DEVOPS_ORG_URL || '';
      const project = process.env.AZURE_DEVOPS_PROJECT || '';
      const epicLink = `${orgUrl}/${project}/_workitems/edit/${p.id}`;

      // Helper: format date
      const fmtDate = (d: string) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Not set';

      // Schedule variance
      let scheduleVariance = '';
      let scheduleEmoji = '🟢';
      if (p.targetDate && p.resolvedDate) {
        const target = new Date(p.targetDate);
        const resolved = new Date(p.resolvedDate);
        const diffDays = Math.round((resolved.getTime() - target.getTime()) / 86400000);
        if (diffDays > 0) { scheduleVariance = `🔴 **~${diffDays} days late** vs. Target Date (Target ${fmtDate(p.targetDate)} → Resolved ${fmtDate(p.resolvedDate)})`; scheduleEmoji = '🔴'; }
        else if (diffDays < 0) { scheduleVariance = `🟢 **${Math.abs(diffDays)} days early** (Target ${fmtDate(p.targetDate)} → Resolved ${fmtDate(p.resolvedDate)})`; }
        else { scheduleVariance = `🟢 **On time** (Resolved on Target Date ${fmtDate(p.targetDate)})`; }
      } else if (p.targetDate && !p.resolvedDate && tl.status !== 'Delivered') {
        scheduleVariance = `⏳ In progress — target ${fmtDate(p.targetDate)}, ${tl.daysRemaining >= 0 ? tl.daysRemaining + ' days remaining' : ''}`;
      } else {
        scheduleVariance = `ℹ️ No target or resolved date available for variance calculation`;
      }

      // Scope stability
      const removedItems = result.children.filter((c) => c.stateCategory === 'removed');
      const scopeNotes: string[] = [];
      if (removedItems.length > 0) scopeNotes.push(`${removedItems.length} feature(s) removed`);
      const scopeEmoji = removedItems.length > 0 ? '🟡' : '🟢';

      // Completed work hours
      const totalHours = result.children.reduce((s, c) => s + (c.completedWork || 0), 0);
      const bugFixItems = result.children.filter((c) => c.title.toLowerCase().includes('bug') || c.title.toLowerCase().includes('fix'));
      const bugFixHours = bugFixItems.reduce((s, c) => s + (c.completedWork || 0), 0);
      const bugFixShare = totalHours > 0 ? Math.round((bugFixHours / totalHours) * 100) : 0;

      // High risk count
      const highRiskItems = result.children.filter((c) => c.risk && (c.risk.includes('High') || c.risk.includes('1')));

      // Quality signal
      let qualitySignal = '🟢 No rework signals detected';
      if (bugFixItems.length > 0) {
        qualitySignal = `🟡 Post-release bug-fix feature(s) detected (${bugFixItems.length}) — indicates potential rework`;
      }

      // Duration
      let durationText = '';
      if (p.activatedDate && p.resolvedDate) {
        const activated = new Date(p.activatedDate);
        const resolved = new Date(p.resolvedDate);
        const months = Math.round((resolved.getTime() - activated.getTime()) / (30 * 86400000));
        durationText = `~${months} month(s) (${fmtDate(p.activatedDate)} → ${fmtDate(p.resolvedDate)})`;
      }

      // Estimate vs Actuals
      let estimateVsActual = '';
      if (sp.total > 0 && totalHours > 0) {
        const ratio = (totalHours / sp.total).toFixed(1);
        estimateVsActual = `${sp.total} SP estimated vs. ${totalHours.toFixed(1)} h logged — **~${ratio}× variance**`;
      }

      // === BUILD OUTPUT ===

      // Section 1: Epic Overview
      const stateEmoji = tl.status === 'Delivered' || p.state === 'Resolved' || p.state === 'Closed' ? '✅' : p.state === 'Active' ? '🔄' : '⬜';
      const iterShort = p.iterationPath.split('\\').slice(-1)[0] || p.iterationPath;

      const overviewSection = [
        `## 📊 Delivery Analysis — ${p.type} #${p.id}`,
        `**${p.title}**`,
        '',
        '---',
        '',
        '### 🎯 Epic Overview',
        '',
        '| Attribute | Value |',
        '|-----------|-------|',
        `| **${p.type} ID** | [#${p.id}](${epicLink}) |`,
        `| **Title** | ${p.title} |`,
        `| **Product Owner** | ${p.assignedTo} |`,
        `| **Team / Area Path** | ${p.areaPath || p.iterationPath} |`,
        `| **State** | ${stateEmoji} **${p.state}** |`,
        `| **Priority / Risk** | ${p.priority || '-'} / ${p.risk || '-'} |`,
        `| **Value Area** | ${p.valueArea || '-'} |`,
        `| **Planned Start** | ${fmtDate(p.startDate)} |`,
        `| **Planned Target** | ${fmtDate(p.targetDate)} |`,
        `| **Activated Date** | ${fmtDate(p.activatedDate)} |`,
        `| **Resolved Date** | ${fmtDate(p.resolvedDate)} |`,
        `| **Tags** | ${p.tags || '-'} |`,
      ].join('\n');

      // Section 2: Delivery Health Snapshot
      const healthSection = [
        '',
        '---',
        '',
        '### 🚦 Delivery Health Snapshot',
        '',
        `- **Overall Status:** ${stateEmoji} **${tl.status}** — ${prog.done}/${prog.total} features completed (${prog.percentComplete}%)`,
        `- **Schedule Variance:** ${scheduleVariance}`,
        `- **Scope Stability:** ${scopeEmoji} ${scopeNotes.length > 0 ? scopeNotes.join('; ') : 'No scope changes detected'}`,
        `- **Quality Signal:** ${qualitySignal}`,
      ].join('\n');

      // Section 3: Feature Breakdown
      const featureRows = result.children.map((c, i) => {
        const stEmoji = c.stateCategory === 'done' ? '✅ Closed' : c.stateCategory === 'inProgress' ? '🔄 In Progress' : c.stateCategory === 'removed' ? '❌ **Removed**' : '⬜ Not Started';
        const iterShort2 = c.iterationPath.split('\\').slice(-1)[0] || '-';
        const workHrs = c.completedWork ? c.completedWork.toFixed(1) : '—';
        const riskVal = c.risk || '—';
        return `| ${i + 1} | ${c.id} | ${c.title} | ${stEmoji} | ${iterShort2} | ${workHrs} | ${riskVal} |`;
      }).join('\n');

      const featureSection = [
        '',
        '---',
        '',
        `### 📦 Feature Breakdown (${result.children.length} Features)`,
        '',
        '| # | Feature ID | Title | State | Iteration | Completed Work (h) | Risk |',
        '|---|-----------|-------|-------|-----------|-------------------:|------|',
        featureRows,
      ].join('\n');

      // Section 4: Delivery KPIs
      const kpiSection = [
        '',
        '---',
        '',
        '### 📈 Delivery KPIs',
        '',
        '| KPI | Value |',
        '|-----|-------|',
        `| **Total Features Planned** | ${result.children.length} |`,
        `| **Features Delivered (Closed)** | ${prog.done} (${prog.percentComplete}%) |`,
        `| **Features Removed** | ${prog.removed} (${result.children.length > 0 ? Math.round((prog.removed / result.children.length) * 100) : 0}%)${removedItems.length > 0 ? ' — ' + removedItems.map((r) => `#${r.id}`).join(', ') : ''} |`,
        `| **Total Completed Work Logged** | **~${totalHours.toFixed(1)} hours** |`,
        `| **Bug Fix Effort Share** | ~${bugFixShare}% (${bugFixHours.toFixed(1)} h of ${totalHours.toFixed(1)} h) |`,
        `| **High-Risk Features** | ${highRiskItems.length} out of ${result.children.length} (${result.children.length > 0 ? Math.round((highRiskItems.length / result.children.length) * 100) : 0}%) |`,
        durationText ? `| **Duration (Activated → Resolved)** | ${durationText} |` : '',
        estimateVsActual ? `| **Original Estimate vs. Actuals** | ${estimateVsActual} |` : '',
      ].filter(Boolean).join('\n');

      // Section 5: Key Delivery Observations
      const wentWell: string[] = [];
      if (prog.percentComplete === 100) wentWell.push(`- **${p.type} delivered end-to-end** — all planned features completed.`);
      if (prog.done >= 5) wentWell.push(`- Strong iterative delivery: ${prog.done} features closed successfully.`);
      if (result.teamContribution.length === 1) wentWell.push(`- Sole contributor (**${result.teamContribution[0].name}**) delivered all ${prog.done} features.`);
      else if (result.teamContribution.length > 1) wentWell.push(`- Collaborative delivery across ${result.teamContribution.length} team members.`);

      const watchAreas: string[] = [];
      if (bugFixShare > 30) watchAreas.push(`- **High rework** — bug-fix effort consumed ~${bugFixShare}% of total logged hours, suggesting insufficient upstream test coverage.`);
      if (removedItems.length > 0) watchAreas.push(`- **Scope churn** — ${removedItems.length} feature(s) removed after planning (${removedItems.map((r) => `#${r.id} ${r.title}`).join(', ')}).`);
      if (estimateVsActual && totalHours / sp.total > 2) watchAreas.push(`- **Estimation accuracy** — actuals exceeded estimates significantly, signaling under-sizing during grooming.`);

      const risks: string[] = [];
      if (highRiskItems.length > result.children.length * 0.5) risks.push(`- ${Math.round((highRiskItems.length / result.children.length) * 100)}% of features tagged as **High Risk** — risk mitigation strategy should be reviewed.`);
      if (scheduleEmoji === '🔴') risks.push(`- Target date slipped — review scheduling assumptions.`);
      if (result.blockers.length > 0) {
        for (const b of result.blockers) {
          risks.push(`- 🚨 **#${b.id}** — ${b.reason} (${b.assignedTo})`);
        }
      }

      const obsSection = [
        '',
        '---',
        '',
        '### 🔎 Key Delivery Observations',
        '',
        '**🟢 Went Well**',
        '',
        wentWell.length > 0 ? wentWell.join('\n') : '- No specific highlights.',
        '',
        '**🟡 Watch Areas**',
        '',
        watchAreas.length > 0 ? watchAreas.join('\n') : '- No concerns detected.',
        '',
        '**🔴 Risks / Concerns**',
        '',
        risks.length > 0 ? risks.join('\n') : '- No active risks.',
      ].join('\n');

      // Section 6: Recommendations
      const recs: string[] = [];
      if (bugFixShare > 30) recs.push(`1. **Retrospective Deep-Dive** on bug-fix features — was the release under-tested? Strengthen Definition of Done with mandatory test coverage before release.`);
      if (removedItems.length > 0) recs.push(`${recs.length + 1}. **Refinement Discipline** — introduce a "Ready for Sprint" gate to reduce features being removed after activation.`);
      if (estimateVsActual && totalHours / sp.total > 2) recs.push(`${recs.length + 1}. **Estimation Calibration** — re-baseline story-point calibration to reduce effort variance.`);
      if (highRiskItems.length > result.children.length * 0.5) recs.push(`${recs.length + 1}. **Risk Register** — high ratio of high-risk features warrants explicit risk-burndown tracking.`);
      if (sp.unestimated > 0) recs.push(`${recs.length + 1}. **Backlog Hygiene** — estimate the ${sp.unestimated} unestimated item(s) for velocity accuracy.`);
      if (tl.status === 'At Risk' || tl.status === 'Overdue') recs.push(`${recs.length + 1}. **Escalate & Re-plan** — timeline has slipped; align with stakeholders on revised date.`);
      if (recs.length === 0) recs.push('1. ✅ Delivery is healthy. Continue current practices and monitor upcoming releases.');

      const recsSection = [
        '',
        '---',
        '',
        '### 💡 Recommendations (Agile Coach Mode)',
        '',
        ...recs,
      ].join('\n');

      // Section 7: Footer
      const footerSection = [
        '',
        '---',
        '',
        `📎 **${p.type} Link:** [${p.type} #${p.id} in Azure DevOps](${epicLink})`,
        '',
        'Would you like me to:',
        `- 🔍 Drill into a specific feature (e.g., bug-fix analysis)?`,
        `- 📧 Draft a **leadership summary email**?`,
        `- 📊 Generate a **sprint-over-sprint delivery trend** for this ${p.type.toLowerCase()}?`,
      ].join('\n');

      const fullText = [overviewSection, healthSection, featureSection, kpiSection, obsSection, recsSection, footerSection].join('\n');

      return { content: [{ type: 'text' as const, text: fullText }] };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error analyzing delivery for work item: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Bug Trend Chart per Release
server.tool(
  'get_bug_trend_chart',
  'Generate a bug trend chart per release/sprint from an Azure DevOps saved query. Shows total, active, and resolved bug counts per iteration. If no queryId is provided, asks the user for it.',
  {
    queryId: z.string().optional().describe(
      'Azure DevOps saved query ID (UUID) or full query URL. ' +
      'Example: "a1b2c3d4-..." or "https://dev.azure.com/org/project/_queries/query/a1b2c3d4-...". ' +
      'Leave empty to get instructions on how to find the query ID.'
    ),
    includeChart: z.boolean().default(false).describe('If true, generates a PNG bug trend chart.'),
    includeCsv: z.boolean().default(true).describe('If true, exports the trend data to a CSV file.'),
    chartType: z.string().optional().describe(
      'Trend chart type. Supported values: 1|line-only, 2|stacked-bar, 3|comparison, 4|cumulative, 5|release-family, 6|regenerate.'
    ),
  },
  async ({ queryId, includeChart, includeCsv, chartType }) => {
    // ── Guard: prompt if no query ID supplied ───────────────────────────────
    if (!queryId || queryId.trim() === '') {
      return {
        content: [{
          type: 'text' as const,
          text: [
            '## 🐞 Bug Trend Chart — Query ID Required',
            '',
            'To generate the bug trend chart, please provide an **Azure DevOps saved query ID** or the **query URL**.',
            '',
            '**How to get your Query ID:**',
            '1. Go to **Azure DevOps → Boards → Queries**',
            '2. Open the saved query that returns bugs',
            '3. Copy the browser URL — it contains the query ID, for example:',
            '   ```',
            '   https://dev.azure.com/{org}/{project}/_queries/query/a1b2c3d4-5678-90ab-cdef-012345678901',
            '   ```',
            '',
            '**You can provide either:**',
            '- Full URL: `https://dev.azure.com/org/project/_queries/query/a1b2c3d4-...`',
            '- Just the UUID: `a1b2c3d4-5678-90ab-cdef-012345678901`',
            '',
            '*Example prompt: "Show bug trend chart for query a1b2c3d4-5678-90ab-cdef-012345678901"*',
          ].join('\n'),
        }],
      };
    }

    try {
      const trend: BugTrendData = await client.getBugTrendData(queryId);

      const rawChartType = (chartType || '').trim().toLowerCase();
      const chartTypeAliases: Record<string, string> = {
        '1': 'line-only',
        'line-only': 'line-only',
        'line only': 'line-only',
        '2': 'stacked-bar',
        'stacked-bar': 'stacked-bar',
        'stacked bar': 'stacked-bar',
        '3': 'comparison',
        'comparison': 'comparison',
        '4': 'cumulative',
        'cumulative': 'cumulative',
        '5': 'release-family',
        'release-family': 'release-family',
        'release family': 'release-family',
        '6': 'regenerate',
        'regenerate': 'regenerate',
      };
      const selectedChartType = chartTypeAliases[rawChartType];
      const shouldRenderChart = includeChart || !!selectedChartType;
      const chartTypeLabelMap: Record<string, string> = {
        'line-only': '📉 Line-only trend chart',
        'stacked-bar': '📊 Stacked bar chart',
        comparison: '🔀 Comparison chart',
        cumulative: '📈 Cumulative trend',
        'release-family': '🎨 Grouped by release family',
        regenerate: '🔄 Regenerated style chart',
      };

      if (chartType && !selectedChartType) {
        return {
          content: [{
            type: 'text' as const,
            text: [
              `Chart type \`${chartType}\` is not recognized.`,
              '',
              'Please choose one of the supported options:',
              '1. 📉 Line-only trend chart',
              '2. 📊 Stacked bar chart',
              '3. 🔀 Comparison chart',
              '4. 📈 Cumulative trend',
              '5. 🎨 Grouped by release family',
              '6. 🔄 Regenerate the same chart',
            ].join('\n'),
          }],
          isError: true,
        };
      }

      if (trend.points.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No bugs found for query \`${queryId}\`. The query returned 0 work items.` }],
        };
      }

      // ── SVG Bug Trend Chart (selectable visualization) ──────────────────
      let svgChart: string | undefined;
      if (shouldRenderChart) {
        const points = trend.points;
        const n = points.length;
        const margin = { top: 60, right: 40, bottom: 120, left: 60 };
        const width = 900;
        const height = 500;
        const plotW = width - margin.left - margin.right;
        const plotH = height - margin.top - margin.bottom;

        const xmlEscape = (value: string): string =>
          value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const buildGridAndAxis = (
          yAxisMax: number,
          xLabels: string,
          title: string,
          seriesSvg: string,
          legendSvg: string,
          yLabel = 'Bug Count'
        ): string => {
          const yScale = (v: number) => margin.top + plotH - (v / yAxisMax) * plotH;
          const yTicks = 5;
          let gridLines = '';
          for (let t = 0; t <= yTicks; t++) {
            const val = Math.round((yAxisMax / yTicks) * t);
            const y = yScale(val);
            gridLines += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e0e0e0" stroke-width="0.6"/>`;
            gridLines += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#333">${val}</text>`;
          }

          return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family:Arial,sans-serif;">
<rect x="0" y="0" width="${width}" height="${height}" fill="white"/>
<text x="${width / 2}" y="24" text-anchor="middle" font-size="14" font-weight="bold" fill="#333">${xmlEscape(title)}</text>
<text x="14" y="${margin.top + plotH / 2}" text-anchor="middle" font-size="11" fill="#333" transform="rotate(-90 14 ${margin.top + plotH / 2})">${xmlEscape(yLabel)}</text>
<text x="${margin.left + plotW / 2}" y="${height - 5}" text-anchor="middle" font-size="11" fill="#333">Release / Sprint</text>
${gridLines}
<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#333" stroke-width="1"/>
<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" stroke="#333" stroke-width="1"/>
${seriesSvg}
${xLabels}
${legendSvg}
</svg>`;
        };

        const xScale = (i: number) => margin.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
        const xLabelSvg = points
          .map((p, i) => {
            const x = xScale(i);
            return `<text x="${x}" y="${margin.top + plotH + 14}" text-anchor="end" font-size="9" fill="#333" transform="rotate(-45 ${x} ${margin.top + plotH + 14})">${xmlEscape(p.release)}</text>`;
          })
          .join('');

        const effectiveChartType = selectedChartType || 'line-only';

        if (effectiveChartType === 'line-only') {
          const yAxisMax = Math.ceil(Math.max(1, ...points.map((p) => p.total)) * 1.15);
          const yScale = (v: number) => margin.top + plotH - (v / yAxisMax) * plotH;
          const line = points.map((p, i) => `${xScale(i)},${yScale(p.total)}`).join(' ');
          const dots = points.map((p, i) => `<circle cx="${xScale(i)}" cy="${yScale(p.total)}" r="4" fill="#1f77b4"/>`).join('');
          const labels = points.map((p, i) => `<text x="${xScale(i)}" y="${yScale(p.total) - 8}" text-anchor="middle" font-size="9" fill="#1f77b4">${p.total}</text>`).join('');
          const series = `<polyline points="${line}" fill="none" stroke="#1f77b4" stroke-width="2.5"/>${dots}${labels}`;
          const legend = `<rect x="${width - 210}" y="${margin.top + 10}" width="170" height="30" fill="white" stroke="#ccc" rx="4"/><line x1="${width - 198}" y1="${margin.top + 26}" x2="${width - 178}" y2="${margin.top + 26}" stroke="#1f77b4" stroke-width="2.5"/><text x="${width - 170}" y="${margin.top + 30}" font-size="10" fill="#333">Total Bugs (Line)</text>`;
          svgChart = buildGridAndAxis(yAxisMax, xLabelSvg, `Line-only Bug Trend${trend.queryName ? ` - ${trend.queryName}` : ''}`, series, legend);
        } else if (effectiveChartType === 'stacked-bar') {
          const yAxisMax = Math.ceil(Math.max(1, ...points.map((p) => p.total)) * 1.15);
          const yScale = (v: number) => margin.top + plotH - (v / yAxisMax) * plotH;
          const barW = Math.max(10, Math.min(30, plotW / Math.max(1, n * 2)));
          const series = points
            .map((p, i) => {
              const x = xScale(i) - barW / 2;
              const other = Math.max(0, p.total - p.active - p.resolved);
              const yResolved = yScale(p.resolved);
              const yActive = yScale(p.resolved + p.active);
              const yOther = yScale(p.total);
              return [
                `<rect x="${x}" y="${yResolved}" width="${barW}" height="${Math.max(0, yScale(0) - yResolved)}" fill="#2ca02c"/>`,
                `<rect x="${x}" y="${yActive}" width="${barW}" height="${Math.max(0, yResolved - yActive)}" fill="#d62728"/>`,
                `<rect x="${x}" y="${yOther}" width="${barW}" height="${Math.max(0, yActive - yOther)}" fill="#ffbf00"/>`,
                `<text x="${xScale(i)}" y="${yOther - 6}" text-anchor="middle" font-size="9" fill="#444">${p.total}</text>`,
                `<text x="${xScale(i)}" y="${margin.top + plotH + 28}" text-anchor="middle" font-size="8" fill="#777">O:${other}</text>`,
              ].join('');
            })
            .join('');
          const legend = `<rect x="${width - 230}" y="${margin.top + 10}" width="190" height="68" fill="white" stroke="#ccc" rx="4"/><rect x="${width - 218}" y="${margin.top + 16}" width="12" height="12" fill="#2ca02c"/><text x="${width - 200}" y="${margin.top + 26}" font-size="10" fill="#333">Resolved/Closed</text><rect x="${width - 218}" y="${margin.top + 36}" width="12" height="12" fill="#d62728"/><text x="${width - 200}" y="${margin.top + 46}" font-size="10" fill="#333">Active/Open</text><rect x="${width - 218}" y="${margin.top + 56}" width="12" height="12" fill="#ffbf00"/><text x="${width - 200}" y="${margin.top + 66}" font-size="10" fill="#333">Other States</text>`;
          svgChart = buildGridAndAxis(yAxisMax, xLabelSvg, `Stacked Bug Trend${trend.queryName ? ` - ${trend.queryName}` : ''}`, series, legend);
        } else if (effectiveChartType === 'cumulative') {
          let running = 0;
          const cumulative = points.map((p) => {
            running += p.total;
            return running;
          });
          const yAxisMax = Math.ceil(Math.max(1, ...cumulative) * 1.15);
          const yScale = (v: number) => margin.top + plotH - (v / yAxisMax) * plotH;
          const line = cumulative.map((v, i) => `${xScale(i)},${yScale(v)}`).join(' ');
          const dots = cumulative.map((v, i) => `<circle cx="${xScale(i)}" cy="${yScale(v)}" r="4" fill="#9467bd"/>`).join('');
          const labels = cumulative.map((v, i) => `<text x="${xScale(i)}" y="${yScale(v) - 8}" text-anchor="middle" font-size="9" fill="#9467bd">${v}</text>`).join('');
          const series = `<polyline points="${line}" fill="none" stroke="#9467bd" stroke-width="2.8"/>${dots}${labels}`;
          const legend = `<rect x="${width - 240}" y="${margin.top + 10}" width="200" height="30" fill="white" stroke="#ccc" rx="4"/><line x1="${width - 228}" y1="${margin.top + 26}" x2="${width - 208}" y2="${margin.top + 26}" stroke="#9467bd" stroke-width="2.8"/><text x="${width - 200}" y="${margin.top + 30}" font-size="10" fill="#333">Cumulative Total Bugs</text>`;
          svgChart = buildGridAndAxis(yAxisMax, xLabelSvg, `Cumulative Bug Trend${trend.queryName ? ` - ${trend.queryName}` : ''}`, series, legend, 'Running Bug Total');
        } else if (effectiveChartType === 'release-family') {
          const familyAgg = [
            { family: 'VA-series', total: 0, resolved: 0 },
            { family: 'V1.x-series', total: 0, resolved: 0 },
            { family: 'Other/Untagged', total: 0, resolved: 0 },
          ];
          for (const p of points) {
            if (/^VA/i.test(p.release)) {
              familyAgg[0].total += p.total;
              familyAgg[0].resolved += p.resolved;
            } else if (/^V1\./i.test(p.release)) {
              familyAgg[1].total += p.total;
              familyAgg[1].resolved += p.resolved;
            } else {
              familyAgg[2].total += p.total;
              familyAgg[2].resolved += p.resolved;
            }
          }

          const yAxisMax = Math.ceil(Math.max(1, ...familyAgg.map((f) => Math.max(f.total, f.resolved))) * 1.2);
          const yScale = (v: number) => margin.top + plotH - (v / yAxisMax) * plotH;
          const fn = familyAgg.length;
          const fx = (i: number) => margin.left + (fn === 1 ? plotW / 2 : (i / (fn - 1)) * plotW);
          const barW = Math.max(18, Math.min(45, plotW / 12));
          const xLabelsFamily = familyAgg
            .map((f, i) => `<text x="${fx(i)}" y="${margin.top + plotH + 20}" text-anchor="middle" font-size="10" fill="#333">${xmlEscape(f.family)}</text>`)
            .join('');
          const series = familyAgg
            .map((f, i) => {
              const cx = fx(i);
              const x1 = cx - barW - 3;
              const x2 = cx + 3;
              const y1 = yScale(f.total);
              const y2 = yScale(f.resolved);
              return [
                `<rect x="${x1}" y="${y1}" width="${barW}" height="${Math.max(0, yScale(0) - y1)}" fill="#1f77b4"/>`,
                `<rect x="${x2}" y="${y2}" width="${barW}" height="${Math.max(0, yScale(0) - y2)}" fill="#2ca02c"/>`,
                `<text x="${x1 + barW / 2}" y="${y1 - 6}" text-anchor="middle" font-size="9" fill="#1f77b4">${f.total}</text>`,
                `<text x="${x2 + barW / 2}" y="${y2 - 6}" text-anchor="middle" font-size="9" fill="#2ca02c">${f.resolved}</text>`,
              ].join('');
            })
            .join('');
          const legend = `<rect x="${width - 240}" y="${margin.top + 10}" width="200" height="48" fill="white" stroke="#ccc" rx="4"/><rect x="${width - 228}" y="${margin.top + 16}" width="12" height="12" fill="#1f77b4"/><text x="${width - 210}" y="${margin.top + 26}" font-size="10" fill="#333">Total Bugs</text><rect x="${width - 228}" y="${margin.top + 36}" width="12" height="12" fill="#2ca02c"/><text x="${width - 210}" y="${margin.top + 46}" font-size="10" fill="#333">Resolved Bugs</text>`;
          svgChart = buildGridAndAxis(yAxisMax, xLabelsFamily, `Bug Trend by Release Family${trend.queryName ? ` - ${trend.queryName}` : ''}`, series, legend);
        } else {
          const yAxisMax = Math.ceil(Math.max(1, ...points.map((p) => Math.max(p.total, p.resolved))) * 1.15);
          const yScale = (v: number) => margin.top + plotH - (v / yAxisMax) * plotH;

          let series = '';
          if (effectiveChartType === 'comparison') {
            const barW = Math.max(8, Math.min(18, plotW / Math.max(1, n * 3.5)));
            series = points
              .map((p, i) => {
                const cx = xScale(i);
                const x1 = cx - barW - 2;
                const x2 = cx + 2;
                const y1 = yScale(p.total);
                const y2 = yScale(p.resolved);
                return [
                  `<rect x="${x1}" y="${y1}" width="${barW}" height="${Math.max(0, yScale(0) - y1)}" fill="#7f7f7f"/>`,
                  `<rect x="${x2}" y="${y2}" width="${barW}" height="${Math.max(0, yScale(0) - y2)}" fill="#2ca02c"/>`,
                ].join('');
              })
              .join('');
            const resolvedLine = points.map((p, i) => `${xScale(i)},${yScale(p.resolved)}`).join(' ');
            series += `<polyline points="${resolvedLine}" fill="none" stroke="#2ca02c" stroke-width="2" stroke-dasharray="4 3"/>`;
          } else {
            const totalLine = points.map((p, i) => `${xScale(i)},${yScale(p.total)}`).join(' ');
            const activeLine = points.map((p, i) => `${xScale(i)},${yScale(p.active)}`).join(' ');
            const resolvedLine = points.map((p, i) => `${xScale(i)},${yScale(p.resolved)}`).join(' ');
            const area = `${xScale(0)},${yScale(0)} ${totalLine} ${xScale(n - 1)},${yScale(0)}`;
            series = [
              `<polygon points="${area}" fill="#9ecae1" opacity="0.25"/>`,
              `<polyline points="${totalLine}" fill="none" stroke="#1f77b4" stroke-width="3"/>`,
              `<polyline points="${activeLine}" fill="none" stroke="#ff7f0e" stroke-width="2.2"/>`,
              `<polyline points="${resolvedLine}" fill="none" stroke="#2ca02c" stroke-width="2.2"/>`,
              ...points.map((p, i) => `<circle cx="${xScale(i)}" cy="${yScale(p.total)}" r="4" fill="#1f77b4"/>`),
            ].join('');
          }

          const legend = effectiveChartType === 'comparison'
            ? `<rect x="${width - 220}" y="${margin.top + 10}" width="180" height="48" fill="white" stroke="#ccc" rx="4"/><rect x="${width - 208}" y="${margin.top + 16}" width="12" height="12" fill="#7f7f7f"/><text x="${width - 190}" y="${margin.top + 26}" font-size="10" fill="#333">Total Bugs</text><rect x="${width - 208}" y="${margin.top + 36}" width="12" height="12" fill="#2ca02c"/><text x="${width - 190}" y="${margin.top + 46}" font-size="10" fill="#333">Resolved/Closed</text>`
            : `<rect x="${width - 240}" y="${margin.top + 10}" width="200" height="68" fill="white" stroke="#ccc" rx="4"/><line x1="${width - 228}" y1="${margin.top + 18}" x2="${width - 208}" y2="${margin.top + 18}" stroke="#1f77b4" stroke-width="3"/><text x="${width - 200}" y="${margin.top + 22}" font-size="10" fill="#333">Total Bugs</text><line x1="${width - 228}" y1="${margin.top + 38}" x2="${width - 208}" y2="${margin.top + 38}" stroke="#ff7f0e" stroke-width="2.2"/><text x="${width - 200}" y="${margin.top + 42}" font-size="10" fill="#333">Active/Open</text><line x1="${width - 228}" y1="${margin.top + 58}" x2="${width - 208}" y2="${margin.top + 58}" stroke="#2ca02c" stroke-width="2.2"/><text x="${width - 200}" y="${margin.top + 62}" font-size="10" fill="#333">Resolved/Closed</text>`;

          const title = effectiveChartType === 'comparison'
            ? `Comparison Trend: Bugs vs Resolved${trend.queryName ? ` - ${trend.queryName}` : ''}`
            : `Regenerated Bug Trend (Styled)${trend.queryName ? ` - ${trend.queryName}` : ''}`;
          svgChart = buildGridAndAxis(yAxisMax, xLabelSvg, title, series, legend);
        }
      }

      // ── CSV Export ──────────────────────────────────────────────────────
      let csvTempPath: string | undefined;
      if (includeCsv) {
        const csvHeader = 'release,iterationPath,total,active,resolved';
        const csvRows = trend.points.map((p) =>
          `"${p.release}","${p.iterationPath}",${p.total},${p.active},${p.resolved}`
        ).join('\n');
        csvTempPath = path.join(os.tmpdir(), 'bug_trend_data.csv');
        fs.writeFileSync(csvTempPath, `${csvHeader}\n${csvRows}`, 'utf-8');
      }

      // ── Build text summary ──────────────────────────────────────────────
      const nonUntagged = trend.points.filter((p) => p.release !== 'Untagged');
      const untaggedPoint = trend.points.find((p) => p.release === 'Untagged');
      const maxCount = trend.points.length > 0 ? Math.max(...trend.points.map((p) => p.total)) : 0;

      const getTrendLabel = (p: { release: string; total: number }): string => {
        if (p.release === 'Untagged') return '⚪ N/A';
        if (p.total === maxCount && maxCount > 0) return '🔴 **Peak**';
        if (p.total >= 20) return '🔴 High';
        if (p.total >= 10) return '🟡 Medium';
        return '🟢 Low';
      };

      const isPeak = (p: { release: string; total: number }) =>
        p.total === maxCount && p.release !== 'Untagged' && maxCount > 0;

      const tableRows = trend.points
        .map((p) => {
          const rel = isPeak(p) ? `**${p.release}**` : p.release;
          const cnt = isPeak(p) ? `**${p.total}**` : `${p.total}`;
          return `| ${rel} | ${cnt} | ${getTrendLabel(p)} |`;
        })
        .join('\n');

      // Key Insights
      const sortedByCount = [...nonUntagged].sort((a, b) => b.total - a.total);
      const [top1, top2, top3] = sortedByCount;
      const recent = nonUntagged.slice(-3);
      const recentDecline =
        recent.length >= 2 && recent[recent.length - 1].total < recent[0].total;

      const keyInsights: string[] = [];
      if (top1)
        keyInsights.push(
          `- 🚨 **Highest bug count: ${top1.release}** with **${top1.total} bugs** — peak release requiring root cause analysis`
        );
      if (top2)
        keyInsights.push(`- 🚨 **Second highest: ${top2.release}** with **${top2.total} bugs**`);
      if (top3)
        keyInsights.push(`- 🔥 **${top3.release}** with **${top3.total} bugs**`);
      if (recentDecline) {
        const recentNames = recent.map((p) => p.release).join(', ');
        keyInsights.push(
          `- ✅ **Improvement trend:** Recent releases (${recentNames}) show reduced bug counts, indicating stabilization`
        );
      }
      if (untaggedPoint)
        keyInsights.push(
          `- ⚠️ **${untaggedPoint.total} Untagged bug(s)** — action needed to add release tags for better traceability`
        );

      // Trend Observations
      const peaks = nonUntagged.filter((p) => p.total >= 20);
      const trendObs: string[] = [];
      if (peaks.length > 0) {
        const peakList = peaks.map((p) => `**${p.release} (${p.total})**`).join(' and ');
        trendObs.push(
          `1. **${peaks.length > 1 ? peaks.length + ' peaks' : 'A peak'}** visible: ${peakList} — these releases may warrant deeper root cause analysis`
        );
      }
      trendObs.push(
        `${trendObs.length + 1}. **Recovery pattern:** After each peak, subsequent releases show reduced defects, indicating effective bug remediation`
      );
      if (recentDecline) {
        trendObs.push(
          `${trendObs.length + 1}. **Recent releases** (ending at ${recent[recent.length - 1].release}) demonstrate a **declining trend** — a positive quality signal`
        );
      }

      // Recommendations
      const recoms: string[] = [
        `- 🔎 Investigate root causes for **${top1?.release || 'peak releases'}** peak(s) (potential retrospective topic)`,
      ];
      if (untaggedPoint)
        recoms.push(
          `- 🏷️ Tag the **${untaggedPoint.total} Untagged bug(s)** with appropriate release labels`
        );
      recoms.push(`- 📊 Continue tracking the trend into upcoming releases`);
      recoms.push(`- 🧪 Consider strengthening test coverage in areas most frequently affected`);

      const summaryText = [
        `Retrieved and analyzed **${trend.totalBugs} bug work items** from the query based on release tags.`,
        shouldRenderChart && selectedChartType
          ? `**Visualization selected:** ${chartTypeLabelMap[selectedChartType]}`
          : `**Visualization:** Not generated yet`,
        '',
        `#### 📊 Bug Distribution Summary`,
        '',
        '| Release | Bug Count | Trend |',
        '|:--------|----------:|:------|',
        tableRows,
        '',
        `#### 🔍 Key Insights`,
        '',
        ...keyInsights,
        '',
        `#### 📈 Trend Observations`,
        '',
        ...trendObs,
        '',
        `#### 💡 Recommendations`,
        '',
        ...recoms,
      ].join('\n');

      // ── Assemble content blocks ─────────────────────────────────────────
      const contentBlocks: { type: string; text?: string; data?: string; mimeType?: string }[] = [];

      let chartTempPath: string | undefined;
      if (svgChart) {
        const pngBuffer = await sharp(Buffer.from(svgChart, 'utf-8')).png().toBuffer();
        chartTempPath = path.join(os.tmpdir(), 'bug_trend_chart.png');
        fs.writeFileSync(chartTempPath, pngBuffer);
      }

      const pathNotes: string[] = [];
      if (chartTempPath) pathNotes.push(`> **Chart saved to:** \`${chartTempPath}\``);
      if (csvTempPath)   pathNotes.push(`> **CSV saved to:** \`${csvTempPath}\``);

      const basePrompt = shouldRenderChart
        ? [
            'Would you like me to create another trend chart?',
            '',
            '1. **📉 Line-only trend chart**',
            '2. **📊 Stacked bar chart**',
            '3. **🔀 Comparison chart**',
            '4. **📈 Cumulative trend**',
            '5. **🎨 Grouped by release family**',
            '6. **🔄 Regenerate the same chart**',
            '',
            'Reply with a number (1-6) or chart name.',
          ].join('\n')
        : [
            'Would you like me to create a visualization chart for this trend?',
            '',
            '1. **📉 Line-only trend chart** — cleaner line chart without bars (pure trend visualization)',
            '2. **📊 Stacked bar chart** — breakdown by defect category (Active/Resolved/Other) per release',
            '3. **🔀 Comparison chart** — bugs vs. resolved/closed per release',
            '4. **📈 Cumulative trend** — running total of bugs across releases',
            '5. **🎨 Grouped by release family** — VA-series vs. V1.x-series side-by-side',
            '6. **🔄 Regenerate the same chart** — with different styling (colors, layout, annotations)',
            '',
            'Reply with a number (1-6) or chart name.',
          ].join('\n');

      const textPayload = [summaryText, '', basePrompt, '', ...pathNotes].join('\n');
      contentBlocks.push({ type: 'text' as const, text: textPayload });

      if (svgChart && chartTempPath) {
        const pngBuffer = fs.readFileSync(chartTempPath);
        contentBlocks.push({ type: 'image' as const, data: pngBuffer.toString('base64'), mimeType: 'image/png' });
      }

      return { content: contentBlocks as any };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error generating bug trend chart: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Sprint History (for carryover detection)
server.tool(
  'get_sprint_history',
  'Detect user stories that have been carried over across multiple sprints. Flags stories in 2+ sprints as recurring carryovers.',
  {},
  async () => {
    try {
      const currentSprint = await client.getCurrentSprint();
      const carryovers = await client.getCarryoverStories(currentSprint.path);

      const flagged = carryovers.map(item => ({
        ...item,
        severity: item.sprintCount >= 3 ? '🚨 CRITICAL' : item.sprintCount >= 2 ? '⚠️ WARNING' : 'ℹ️ INFO',
        recommendation:
          item.sprintCount >= 3
            ? 'ACTION REQUIRED: Story has been carried over 3+ sprints. Consider splitting, re-estimating, or escalating blockers.'
            : item.sprintCount >= 2
            ? 'Monitor closely. Story carried over from previous sprint.'
            : 'Normal progression.',
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(flagged, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Team Capacity (from SharePoint)
server.tool(
  'get_team_capacity',
  'Get team member capacity and allocation for the current or specified sprint. Data is fetched from the SharePoint "Team Capacity" folder.',
  {
    sprintNumber: z.string().optional().describe('Sprint number (e.g. "13", "14"). If not provided, auto-detects from current sprint name.'),
  },
  async ({ sprintNumber }) => {
    try {
      const siteUrl = process.env.SHAREPOINT_SITE_URL;
      if (!siteUrl) {
        return { content: [{ type: 'text' as const, text: 'Error: SHAREPOINT_SITE_URL env var is not set.' }], isError: true };
      }

      // Determine sprint number from current sprint if not provided
      let targetSprint = sprintNumber;
      if (!targetSprint) {
        const currentSprint = await client.getCurrentSprint();
        // Extract sprint number from sprint name (e.g. "Sprint 14" -> "14")
        const match = currentSprint.name.match(/(\d+)/);
        if (match) {
          targetSprint = match[1];
        } else {
          return { content: [{ type: 'text' as const, text: `Error: Could not extract sprint number from "${currentSprint.name}". Please provide sprintNumber explicitly.` }], isError: true };
        }
      }

      // List files in Team Capacity folder to find the matching sprint file
      const capacityFolderPath = 'PDS Team/Agent/Avengers/Team Capacity';
      const docs = await listDocuments(siteUrl, 'Documents', capacityFolderPath, 50);

      // Find matching file (e.g. "Sprint 13.xlsx")
      const matchingFile = docs.find(doc =>
        doc.name.toLowerCase().includes(`sprint ${targetSprint}`) ||
        doc.name.toLowerCase().includes(`sprint${targetSprint}`)
      );

      if (!matchingFile) {
        const available = docs.filter(d => d.type !== 'folder').map(d => d.name).join(', ');
        return { content: [{ type: 'text' as const, text: `No capacity file found for Sprint ${targetSprint}. Available files: ${available}` }], isError: true };
      }

      // Fetch the document content
      const content = await getDocumentContent(matchingFile.url, false);
      return {
        content: [
          {
            type: 'text' as const,
            text: `## Team Capacity - Sprint ${targetSprint}\n\nSource: ${matchingFile.name} (last modified: ${new Date(matchingFile.lastModified).toLocaleDateString()} by ${matchingFile.modifiedBy})\n\n${content}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get All Iterations
server.tool(
  'get_iterations',
  'List all sprint iterations for the team (past, current, and future)',
  {},
  async () => {
    try {
      const iterations = await client.getIterations();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(iterations, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Developer Performance Summary
server.tool(
  'get_developer_performance',
  'Analyze developer performance in the current sprint: stories assigned, completed, in-progress, and story points delivered',
  {},
  async () => {
    try {
      const currentSprint = await client.getCurrentSprint();
      const workItems = await client.getSprintWorkItems(currentSprint.id);

      // Group by developer
      const devMap: Record<string, {
        assigned: number;
        completed: number;
        inProgress: number;
        storyPointsTotal: number;
        storyPointsCompleted: number;
        items: { id: number; title: string; state: string; storyPoints: number | null }[];
      }> = {};

      for (const item of workItems) {
        if (item.workItemType !== 'User Story' && item.workItemType !== 'Product Backlog Item' && item.workItemType !== 'Bug') {
          continue;
        }

        const dev = item.assignedTo;
        if (!devMap[dev]) {
          devMap[dev] = { assigned: 0, completed: 0, inProgress: 0, storyPointsTotal: 0, storyPointsCompleted: 0, items: [] };
        }

        devMap[dev].assigned++;
        devMap[dev].storyPointsTotal += item.storyPoints || 0;

        if (item.state === 'Done' || item.state === 'Closed' || item.state === 'Resolved') {
          devMap[dev].completed++;
          devMap[dev].storyPointsCompleted += item.storyPoints || 0;
        } else if (item.state === 'Active' || item.state === 'In Progress') {
          devMap[dev].inProgress++;
        }

        devMap[dev].items.push({
          id: item.id,
          title: item.title,
          state: item.state,
          storyPoints: item.storyPoints,
        });
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              sprint: currentSprint.name,
              developers: devMap,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Draft Sprint Analysis Email in Outlook
server.tool(
  'draft_sprint_email',
  'Create a draft email in Outlook with the sprint analysis report. The email is saved as a draft and NOT sent. Requires Outlook desktop to be installed.',
  {
    subject: z.string().describe('Email subject line, e.g. "Sprint 14 Review - PDS_Avengers"'),
    body: z.string().describe('The full sprint analysis content in HTML format. Use HTML tables, headings, and formatting.'),
    to: z.string().optional().describe('Recipient email addresses, semicolon-separated. Leave empty to add recipients manually.'),
    chartImagePath: z.string().optional().describe('Absolute path to a PNG chart image (returned by get_sprint_burndown). When provided, embeds the burndown chart visually in the email.'),
  },
  async ({ subject, body, to, chartImagePath }) => {
    try {
      const scriptPath = path.resolve(__dirname, '..', 'scripts', 'create-outlook-draft.ps1');

      // Optionally embed burndown chart PNG
      let chartImgTag = '';
      if (chartImagePath && fs.existsSync(chartImagePath)) {
        const pngData = fs.readFileSync(chartImagePath);
        const pngBase64 = pngData.toString('base64');
        chartImgTag = `<div style="margin:16px 0;"><img src="data:image/png;base64,${pngBase64}" width="860" style="max-width:100%;border:1px solid #dce3ef;border-radius:4px;display:block;"/></div>`;
      }

      // Inject chart after first <h3> or at the start of body if no heading found
      let bodyWithChart = body;
      if (chartImgTag) {
        // Insert chart right after the first </h2> or </h3>, or prepend
        const insertAfter = body.match(/<\/h[23]>/i);
        if (insertAfter && insertAfter.index !== undefined) {
          const insertIdx = insertAfter.index + insertAfter[0].length;
          bodyWithChart = body.slice(0, insertIdx) + chartImgTag + body.slice(insertIdx);
        } else {
          bodyWithChart = chartImgTag + body;
        }
      }

      // Wrap the body in a styled HTML template
      const htmlBody = `
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: Calibri, Segoe UI, sans-serif; font-size: 11pt; color: #333; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 10pt; }
  th { background-color: #0078d4; color: white; }
  tr:nth-child(even) { background-color: #f9f9f9; }
  h2 { color: #0078d4; border-bottom: 2px solid #0078d4; padding-bottom: 5px; }
  h3 { color: #333; }
  .critical { color: #d13438; font-weight: bold; }
  .warning { color: #f7630c; font-weight: bold; }
  .good { color: #107c10; font-weight: bold; }
</style>
</head>
<body>
${bodyWithChart}
<br/><hr/>
<p style="font-size:9pt;color:#888;">Generated by Sprint Review Analyst Agent on ${new Date().toLocaleDateString()}</p>
</body>
</html>`;

      const args = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Subject', subject,
        '-Body', htmlBody,
        '-BodyFormat', 'HTML',
      ];

      if (to) {
        args.push('-To', to);
      }

      const { stdout } = await execFileAsync('powershell.exe', args, {
        timeout: 30000,
      });

      const result = JSON.parse(stdout.trim());

      if (result.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Draft email created successfully in Outlook!\n\nSubject: ${subject}\nTo: ${result.to}\n\nOpen Outlook → Drafts folder to review and send.`,
            },
          ],
        };
      } else {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${result.message}` }],
          isError: true,
        };
      }
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error creating draft email: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Query Work Items
server.tool(
  'query_work_items',
  'Search for work items matching a query string. Searches by title and description across the project.',
  {
    query: z.string().describe('Search text to find work items by title or description (e.g. "login bug", "payment feature")'),
  },
  async ({ query }) => {
    try {
      const workItems = await client.queryWorkItems(query);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              query,
              totalResults: workItems.length,
              workItems,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Link Work Items
server.tool(
  'link_work_items',
  'Add a link between two work items in Azure DevOps. Supports different link types like Related, Parent/Child, Predecessor/Successor.',
  {
    sourceWorkItemId: z.number().describe('The ID of the source work item to add the link FROM'),
    targetWorkItemId: z.number().describe('The ID of the target work item to link TO'),
    linkType: z.enum([
      'System.LinkTypes.Related',
      'System.LinkTypes.Hierarchy-Forward',
      'System.LinkTypes.Hierarchy-Reverse',
      'System.LinkTypes.Dependency-Forward',
      'System.LinkTypes.Dependency-Reverse',
    ]).optional().describe(
      'Type of link: Related (default), Hierarchy-Forward (Parent→Child), Hierarchy-Reverse (Child→Parent), Dependency-Forward (Predecessor→Successor), Dependency-Reverse (Successor→Predecessor)'
    ),
    comment: z.string().optional().describe('Optional comment describing why the items are linked'),
  },
  async ({ sourceWorkItemId, targetWorkItemId, linkType, comment }) => {
    try {
      const result = await client.addWorkItemLink(
        sourceWorkItemId,
        targetWorkItemId,
        linkType || 'System.LinkTypes.Related',
        comment
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: `✅ Link added successfully!\n\nSource: Work Item #${sourceWorkItemId}\nTarget: Work Item #${targetWorkItemId} (${result.title})\nLink Type: ${linkType || 'Related'}${comment ? `\nComment: ${comment}` : ''}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Create Work Item
server.tool(
  'create_work_item',
  'Create a new work item in Azure DevOps. Requires at minimum: work item type and title. Will prompt for other fields if not provided. Returns the link to the created work item.',
  {
    workItemType: z.enum(['User Story', 'Bug', 'Task', 'Feature', 'Epic', 'Product Backlog Item', 'Test Case'])
      .describe('The type of work item to create'),
    title: z.string().describe('Title of the work item'),
    description: z.string().optional().describe('Detailed description of the work item (supports HTML)'),
    acceptanceCriteria: z.string().optional().describe('Acceptance criteria for the work item (supports HTML, use Given/When/Then format)'),
    assignedTo: z.string().optional().describe('Display name or email of the person to assign the work item to'),
    iterationPath: z.string().optional()
      .describe('Iteration path (e.g. "PLM\\PDS\\2026\\Avengers\\Q4\\Sprint 14"). If not provided, defaults to the project root iteration.'),
    areaPath: z.string().optional().describe('Area path for the work item'),
    state: z.string().optional().describe('Initial state (e.g. "New", "Active"). Defaults to "New".'),
    storyPoints: z.number().optional().describe('Story points estimate (for User Stories/PBIs)'),
    priority: z.number().optional().describe('Priority (1=Critical, 2=High, 3=Medium, 4=Low)'),
    tags: z.string().optional().describe('Semicolon-separated tags (e.g. "Frontend; Bug; Sprint14")'),
    parentId: z.number().optional().describe('ID of the parent work item to link this as a child of'),
  },
  async ({ workItemType, title, description, acceptanceCriteria, assignedTo, iterationPath, areaPath, state, storyPoints, priority, tags, parentId }) => {
    try {
      const result = await client.createWorkItem(workItemType, title, {
        description,
        acceptanceCriteria,
        assignedTo,
        iterationPath,
        areaPath,
        state,
        storyPoints,
        priority,
        tags,
        parentId,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `✅ Work item created successfully!\n\n` +
              `**ID:** #${result.id}\n` +
              `**Type:** ${workItemType}\n` +
              `**Title:** ${result.title}\n` +
              (assignedTo ? `**Assigned To:** ${assignedTo}\n` : '') +
              (iterationPath ? `**Iteration:** ${iterationPath}\n` : '') +
              (storyPoints !== undefined ? `**Story Points:** ${storyPoints}\n` : '') +
              (parentId ? `**Parent:** #${parentId}\n` : '') +
              `\n**Link:** ${result.url}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error creating work item: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Work Item Attachments
server.tool(
  'get_work_item_attachments',
  'List all attachments on a work item. Returns attachment names, sizes, and IDs that can be used with get_attachment_content to read file contents.',
  {
    workItemId: z.number().describe('The ID of the work item to get attachments for'),
  },
  async ({ workItemId }) => {
    try {
      const attachments = await client.getWorkItemAttachments(workItemId);

      if (attachments.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No attachments found on work item #${workItemId}.` }],
        };
      }

      let text = `**Attachments on Work Item #${workItemId}** (${attachments.length} total):\n\n`;
      text += '| # | Name | Size | Date | Attachment ID |\n';
      text += '|---|------|------|------|---------------|\n';
      attachments.forEach((a, i) => {
        const sizeKB = (a.size / 1024).toFixed(1);
        const date = a.createdDate ? new Date(a.createdDate).toLocaleDateString() : 'N/A';
        text += `| ${i + 1} | ${a.name} | ${sizeKB} KB | ${date} | ${a.id} |\n`;
      });
      text += `\nTo read an attachment's content, use the **get_attachment_content** tool with the Attachment ID.`;

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error fetching attachments: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Attachment Content
server.tool(
  'get_attachment_content',
  'Read the content of a specific attachment from a work item. Use get_work_item_attachments first to get the attachment ID. Supports text-based files (txt, csv, json, xml, html, etc.). Binary files will return metadata only.',
  {
    attachmentId: z.string().describe('The attachment ID (GUID) from get_work_item_attachments'),
    fileName: z.string().optional().describe('Optional: the file name for display purposes'),
  },
  async ({ attachmentId, fileName }) => {
    try {
      const result = await client.getAttachmentContent(attachmentId, fileName);
      const displayName = fileName || attachmentId;

      if (result.isText) {
        return {
          content: [{
            type: 'text' as const,
            text: `**Content of: ${displayName}**\n\n\`\`\`\n${result.content}\n\`\`\``,
          }],
        };
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: `**${displayName}**: ${result.content}\n\nThis is a binary file and cannot be displayed as text.`,
          }],
        };
      }
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error reading attachment: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Work Item Children
server.tool(
  'get_work_item_children',
  'Get all child work items of a given work item. Returns details of each child including ID, title, type, state, and assigned to.',
  {
    workItemId: z.number().describe('The ID of the parent work item'),
  },
  async ({ workItemId }) => {
    try {
      const children = await client.getWorkItemChildren(workItemId);

      if (children.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No child work items found for #${workItemId}.` }],
        };
      }

      let text = `**Child Work Items of #${workItemId}** (${children.length} total):\n\n`;
      text += '| ID | Type | Title | State | Assigned To | Story Points |\n';
      text += '|----|------|-------|-------|-------------|-------------|\n';
      for (const child of children) {
        text += `| #${child.id} | ${child.workItemType} | ${child.title} | ${child.state} | ${child.assignedTo} | ${child.storyPoints ?? '-'} |\n`;
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error fetching children: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Work Item Comments
server.tool(
  'get_work_item_comments',
  'Get all comments/discussion from a work item. Returns each comment with author and date.',
  {
    workItemId: z.number().describe('The ID of the work item to get comments for'),
  },
  async ({ workItemId }) => {
    try {
      const comments = await client.getWorkItemComments(workItemId);

      if (comments.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No comments found on work item #${workItemId}.` }],
        };
      }

      let text = `**Comments on Work Item #${workItemId}** (${comments.length} total):\n\n`;
      for (const comment of comments) {
        const date = comment.createdDate ? new Date(comment.createdDate).toLocaleString() : 'N/A';
        text += `---\n**Comment ID: ${comment.id}** | **${comment.createdBy}** — ${date}\n\n${comment.text}\n\n`;
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error fetching comments: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Pipelines
server.tool(
  'get_pipelines',
  'List all pipelines in the Azure DevOps project with their IDs, names, folders, and links.',
  {},
  async () => {
    try {
      const pipelines = await client.getPipelines();

      if (pipelines.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No pipelines found in this project.' }],
        };
      }

      let text = `**Pipelines in Project** (${pipelines.length} total):\n\n`;
      text += '| ID | Name | Folder | Link |\n';
      text += '|----|------|--------|------|\n';
      for (const p of pipelines) {
        text += `| ${p.id} | ${p.name} | ${p.folder} | [Open](${p.url}) |\n`;
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error fetching pipelines: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Pipeline Runs
server.tool(
  'get_pipeline_runs',
  'Get recent runs of a specific pipeline. Shows build status, result, duration, branch, and links.',
  {
    pipelineId: z.number().describe('The pipeline/definition ID'),
    top: z.number().optional().describe('Number of recent runs to fetch (default 10, max 25)'),
  },
  async ({ pipelineId, top }) => {
    try {
      const runs = await client.getPipelineRuns(pipelineId, top || 10);

      if (runs.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No runs found for pipeline ${pipelineId}.` }],
        };
      }

      let text = `**Recent Runs for Pipeline ${runs[0].name || pipelineId}** (${runs.length} shown):\n\n`;
      text += '| Build ID | Result | Branch | Started | Duration | Link |\n';
      text += '|----------|--------|--------|---------|----------|------|\n';
      for (const r of runs) {
        const resultIcon = r.result === 'succeeded' ? '✅' : r.result === 'failed' ? '❌' : r.result === 'canceled' ? '⚪' : '⚠️';
        const started = r.startTime ? new Date(r.startTime).toLocaleString() : 'N/A';
        let duration = '';
        if (r.startTime && r.finishTime) {
          const mins = Math.round((new Date(r.finishTime).getTime() - new Date(r.startTime).getTime()) / 60000);
          duration = `${mins} min`;
        }
        const branch = r.sourceBranch.replace('refs/heads/', '');
        text += `| #${r.id} | ${resultIcon} ${r.result} | ${branch} | ${started} | ${duration} | [Open](${r.url}) |\n`;
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error fetching pipeline runs: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Pipeline Health
server.tool(
  'get_pipeline_health',
  'Get health and reliability metrics for a pipeline: success rate, current streak (consecutive failures/successes), last successful/failed run, average duration, and recent run history.',
  {
    pipelineId: z.number().describe('The pipeline/definition ID to check health for'),
  },
  async ({ pipelineId }) => {
    try {
      const health = await client.getPipelineHealth(pipelineId);

      let text = `## Pipeline Health: ${health.pipelineName}\n\n`;
      text += `| Metric | Value |\n`;
      text += `|--------|-------|\n`;
      text += `| Total Runs (last 25) | ${health.totalRuns} |\n`;
      text += `| ✅ Succeeded | ${health.succeeded} |\n`;
      text += `| ❌ Failed | ${health.failed} |\n`;
      text += `| ⚪ Canceled | ${health.canceled} |\n`;
      text += `| ⚠️ Partially Succeeded | ${health.partiallySucceeded} |\n`;
      text += `| **Success Rate** | **${health.successRate}%** |\n`;
      text += `| Avg Duration | ${health.averageDurationMinutes} min |\n`;

      text += `\n### Current Streak\n\n`;
      const streakIcon = health.currentStreak.result === 'succeeded' ? '✅' : health.currentStreak.result === 'failed' ? '❌' : '⚪';
      const streakSince = health.currentStreak.since ? new Date(health.currentStreak.since).toLocaleString() : 'N/A';
      text += `${streakIcon} **${health.currentStreak.count} consecutive ${health.currentStreak.result}** runs (since ${streakSince})\n\n`;

      if (health.currentStreak.result === 'failed' && health.currentStreak.count >= 3) {
        text += `⚠️ **WARNING:** Pipeline has been failing continuously for ${health.currentStreak.count} runs!\n\n`;
      }

      text += `### Key Dates\n\n`;
      text += `- **Last Successful:** ${health.lastSuccessful ? new Date(health.lastSuccessful).toLocaleString() : 'Never (in recent history)'}\n`;
      text += `- **Last Failed:** ${health.lastFailed ? new Date(health.lastFailed).toLocaleString() : 'Never (in recent history)'}\n\n`;

      text += `### Recent Runs\n\n`;
      text += '| Build | Result | Branch | Time |\n';
      text += '|-------|--------|--------|------|\n';
      for (const r of health.recentRuns) {
        const icon = r.result === 'succeeded' ? '✅' : r.result === 'failed' ? '❌' : '⚪';
        const time = r.startTime ? new Date(r.startTime).toLocaleString() : 'N/A';
        const branch = r.sourceBranch.replace('refs/heads/', '');
        text += `| #${r.id} | ${icon} ${r.result} | ${branch} | ${time} |\n`;
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error fetching pipeline health: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Work Item Fields
server.tool(
  'get_work_item_fields',
  'Get all fields and their values for a given work item. Returns a rich structured summary with key attributes, people, dates, description, acceptance criteria, and SARA insights.',
  {
    workItemId: z.number().describe('The ID of the work item to get fields for'),
  },
  async ({ workItemId }) => {
    try {
      const fields = await client.getWorkItemFields(workItemId);

      if (fields.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No fields found for work item ${workItemId}.` }],
        };
      }

      // Build a lookup map
      const f: Record<string, any> = {};
      for (const field of fields) {
        let val = field.value;
        if (val && typeof val === 'object') {
          val = val.displayName || val.name || JSON.stringify(val);
        }
        f[field.referenceName] = val ?? '';
      }

      const title = f['System.Title'] || 'Untitled';
      const workItemType = f['System.WorkItemType'] || 'Work Item';
      const state = f['System.State'] || '';
      const reason = f['System.Reason'] || '';
      const assignedTo = f['System.AssignedTo'] || 'Unassigned';
      const createdBy = f['System.CreatedBy'] || '';
      const changedBy = f['System.ChangedBy'] || '';
      const activatedBy = f['Microsoft.VSTS.Common.ActivatedBy'] || '';
      const priority = f['Microsoft.VSTS.Common.Priority'] || '';
      const storyPoints = f['Microsoft.VSTS.Scheduling.StoryPoints'] || '';
      const effort = f['Microsoft.VSTS.Scheduling.Effort'] || '';
      const originalEstimate = f['Microsoft.VSTS.Scheduling.OriginalEstimate'] || '';
      const remainingWork = f['Microsoft.VSTS.Scheduling.RemainingWork'] || '';
      const areaPath = f['System.AreaPath'] || '';
      const iterationPath = f['System.IterationPath'] || '';
      const teamProject = f['System.TeamProject'] || '';
      const boardColumn = f['System.BoardColumn'] || '';
      const boardLane = f['System.BoardLane'] || '';
      const tags = f['System.Tags'] || '';
      const description = f['System.Description'] || '';
      const acceptanceCriteria = f['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';
      const commentCount = f['System.CommentCount'] || 0;
      const parent = f['System.Parent'] || '';
      const valueArea = f['Microsoft.VSTS.Common.ValueArea'] || '';
      const rev = f['System.Rev'] || '';

      const createdDate = f['System.CreatedDate'] || '';
      const changedDate = f['System.ChangedDate'] || '';
      const stateChangeDate = f['Microsoft.VSTS.Common.StateChangeDate'] || '';
      const activatedDate = f['Microsoft.VSTS.Common.ActivatedDate'] || '';
      const waitingSince = f['Custom.WaitingSince'] || '';

      const formatDate = (d: string) => d ? d.substring(0, 10) : 'N/A';

      // State icon
      const stateIcon = state === 'Active' ? '🟢' : state === 'Resolved' ? '🔵' : state === 'Closed' ? '⚫' : state === 'New' ? '⚪' : '🟡';

      // HTML to Markdown helper
      const htmlToMarkdown = (html: string) => {
        let md = html;
        // Replace <br> and <br/> with newlines
        md = md.replace(/<br\s*\/?>/gi, '\n');
        // Replace </p><p> with double newline
        md = md.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
        // Replace <p> and </p>
        md = md.replace(/<p[^>]*>/gi, '');
        md = md.replace(/<\/p>/gi, '\n\n');
        // Replace <strong> and <b> with markdown bold
        md = md.replace(/<(strong|b)>/gi, '**');
        md = md.replace(/<\/(strong|b)>/gi, '**');
        // Replace <em> and <i> with markdown italic
        md = md.replace(/<(em|i)>/gi, '*');
        md = md.replace(/<\/(em|i)>/gi, '*');
        // Replace <li> with bullet points
        md = md.replace(/<li[^>]*>/gi, '- ');
        md = md.replace(/<\/li>/gi, '\n');
        // Remove <ul>, <ol>, and other container tags
        md = md.replace(/<\/?(ul|ol|div|span|table|tr|td|th|thead|tbody)[^>]*>/gi, '');
        // Remove images
        md = md.replace(/<img[^>]*>/gi, '');
        // Remove remaining HTML tags
        md = md.replace(/<[^>]*>/g, '');
        // Replace HTML entities
        md = md.replace(/&nbsp;/g, ' ');
        md = md.replace(/&amp;/g, '&');
        md = md.replace(/&lt;/g, '<');
        md = md.replace(/&gt;/g, '>');
        md = md.replace(/&quot;/g, '"');
        // Clean up extra whitespace but preserve intentional newlines
        md = md.replace(/[ \t]+/g, ' ');
        md = md.replace(/\n /g, '\n');
        md = md.replace(/\n{3,}/g, '\n\n');
        return md.trim();
      };

      // Format acceptance criteria as bullet list
      const formatAcceptanceCriteria = (html: string) => {
        const text = htmlToMarkdown(html);
        // Try to detect AC patterns like "AC1:", "AC2:", etc.
        const acPattern = /\b(AC\s*\d+)\s*:/gi;
        if (acPattern.test(text)) {
          // Split on AC patterns and format as bullets
          const parts = text.split(/\b(AC\s*\d+)\s*:/i);
          let result = '';
          for (let i = 1; i < parts.length; i += 2) {
            const label = parts[i].replace(/\s+/g, '');
            const content = (parts[i + 1] || '').trim();
            result += `- **${label}:** ${content}\n`;
          }
          return result.trim();
        }
        return text;
      };

      const orgUrl = process.env.AZURE_DEVOPS_ORG_URL || 'https://dev.azure.com/SHS-CT-ProcessTooling';
      const url = `${orgUrl}/_apis/wit/workItems/${workItemId}`;

      let text = '';

      // Header
      text += `# **📋 ${workItemType} ${workItemId} – Details**\n\n`;
      text += `## **🏷️ Title**\n`;
      text += `**${title}**\n\n`;
      text += `🔗 [Open in Azure DevOps](${url})\n\n`;
      text += `---\n\n`;

      // Key Attributes
      text += `## **🔑 Key Attributes**\n\n`;
      text += `| Field | Value |\n`;
      text += `|-------|-------|\n`;
      text += `| **ID** | ${workItemId} |\n`;
      text += `| **Type** | ${workItemType} |\n`;
      text += `| **State** | ${stateIcon} ${state} |\n`;
      text += `| **Reason** | ${reason} |\n`;
      if (boardColumn) text += `| **Board Column** | ⏳ ${boardColumn} |\n`;
      if (boardLane) text += `| **Board Lane** | ${boardLane} |\n`;
      text += `| **Priority** | ${priority} |\n`;
      if (valueArea) text += `| **Value Area** | ${valueArea} |\n`;
      if (storyPoints) text += `| **Story Points** | ${storyPoints} |\n`;
      const effortLine = [effort, originalEstimate, remainingWork].filter(Boolean).join(' / ');
      if (effortLine) text += `| **Effort / Original Estimate / Remaining Work** | ${effortLine} |\n`;
      text += `| **Revision** | ${rev} |\n`;
      text += `\n---\n\n`;

      // People
      text += `## **👥 People**\n\n`;
      text += `| Role | Name |\n`;
      text += `|------|------|\n`;
      if (createdBy) text += `| **Created By** | ${createdBy} |\n`;
      text += `| **Assigned To** | ${assignedTo} |\n`;
      if (activatedBy) text += `| **Activated By** | ${activatedBy} |\n`;
      if (changedBy) text += `| **Last Changed By** | ${changedBy} |\n`;
      if (parent) text += `| **Parent Work Item** | ${parent} |\n`;
      text += `\n---\n\n`;

      // Dates
      text += `## **🗓️ Dates**\n\n`;
      text += `| Event | Date (UTC) |\n`;
      text += `|-------|------------|\n`;
      text += `| **Created** | ${formatDate(createdDate)} |\n`;
      if (activatedDate) text += `| **Activated** | ${formatDate(activatedDate)} |\n`;
      if (stateChangeDate) text += `| **State Change** | ${formatDate(stateChangeDate)} |\n`;
      if (waitingSince) text += `| **Waiting Since** | ${formatDate(waitingSince)} |\n`;
      text += `| **Last Changed** | ${formatDate(changedDate)} |\n`;
      text += `\n---\n\n`;

      // Classification
      text += `## **📂 Classification**\n\n`;
      text += `- **Area Path:** \`${areaPath.replace(/\\/g, ' \\ ')}\`\n`;
      text += `- **Iteration Path:** \`${iterationPath.replace(/\\/g, ' \\ ')}\`\n`;
      text += `- **Team Project:** ${teamProject}\n`;
      text += `\n---\n\n`;

      // Tags
      if (tags) {
        const tagList = tags.split(';').map((t: string) => `\`${t.trim()}\``).join(' · ');
        text += `## **🏷️ Tags**\n${tagList}\n\n---\n\n`;
      }

      // Description
      if (description) {
        text += `## **📝 Description**\n${htmlToMarkdown(description)}\n\n---\n\n`;
      }

      // Acceptance Criteria
      if (acceptanceCriteria) {
        text += `## **✅ Acceptance Criteria**\n\n${formatAcceptanceCriteria(acceptanceCriteria)}\n\n---\n\n`;
      }

      // Comments
      if (commentCount) {
        text += `## **💬 Comments**\nThere are **${commentCount} comments** on this work item. Let me know if you'd like me to fetch them.\n\n---\n\n`;
      }

      // SARA Insights
      text += `## **⚠️ Observations (SARA Insights)**\n\n`;
      const insights: string[] = [];

      // Check for blocked tag
      const tagLower = tags.toLowerCase();
      if (tagLower.includes('blocked')) {
        insights.push(`🚩 **Blocked${waitingSince ? ` & Waiting since ${formatDate(waitingSince)}` : ''}** — item has been in a waiting/blocked state for a prolonged period; consider escalation or a dependency check.`);
      }

      // Check for carry-over (multiple sprint tags)
      const sprintTags = tags.split(';').map((t: string) => t.trim()).filter((t: string) => /^\d{4}_\d{2}$/.test(t));
      if (sprintTags.length > 3) {
        insights.push(`🔁 **Tagged across ${sprintTags.length} sprints (${sprintTags[0]} → ${sprintTags[sprintTags.length - 1]})** — indicates recurring carry-over; recommend a root-cause review in the next retrospective.`);
      }

      // Check for low effort + long cycle time
      const sp = Number(storyPoints) || Number(effort) || 0;
      if (sp > 0 && sp <= 2 && createdDate) {
        const ageDays = Math.floor((Date.now() - new Date(createdDate).getTime()) / (1000 * 60 * 60 * 24));
        if (ageDays > 60) {
          insights.push(`📌 Low effort (${sp} SP) but long cycle time — suggests the blocker is **external dependency**, not implementation complexity.`);
        }
      }

      if (insights.length === 0) {
        insights.push(`✅ No significant concerns detected. Item appears healthy.`);
      }

      for (const insight of insights) {
        text += `- ${insight}\n`;
      }

      text += `\nWould you like me to also pull the **comments**, **linked items**, or **parent Feature (${parent})** details?`;

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error fetching work item fields: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Check Work Item Exists
server.tool(
  'check_work_item',
  'Check if a work item exists by ID. If it exists, returns basic information (title, type, state, assigned to, dates) along with a direct link to the work item.',
  {
    workItemId: z.number().describe('The ID of the work item to check'),
  },
  async ({ workItemId }) => {
    try {
      const result = await client.checkWorkItemExists(workItemId);

      if (!result.exists) {
        return {
          content: [{ type: 'text' as const, text: `❌ Work item #${workItemId} does **not exist** or has been deleted.` }],
        };
      }

      let text = `✅ **Work Item #${result.id} exists**\n\n`;
      text += `| Field | Value |\n`;
      text += `|-------|-------|\n`;
      text += `| **Title** | ${result.title} |\n`;
      text += `| **Type** | ${result.workItemType} |\n`;
      text += `| **State** | ${result.state} |\n`;
      text += `| **Assigned To** | ${result.assignedTo} |\n`;
      text += `| **Area Path** | ${result.areaPath} |\n`;
      text += `| **Iteration Path** | ${result.iterationPath} |\n`;
      text += `| **Created** | ${result.createdDate ? new Date(result.createdDate).toLocaleString() : 'N/A'} |\n`;
      text += `| **Last Updated** | ${result.changedDate ? new Date(result.changedDate).toLocaleString() : 'N/A'} |\n`;
      text += `\n🔗 **Link:** [Open Work Item #${result.id}](${result.url})\n`;

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error checking work item: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Update Work Item Fields
server.tool(
  'update_work_item',
  `Update one or more fields on a work item. Supports all standard fields including title, description, state, assigned to, effort/story points, priority, area path, iteration path, tags, and any custom fields.

Common field reference names:
- System.Title
- System.Description
- System.State (New, Active, Resolved, Closed)
- System.AssignedTo (use display name or email)
- System.AreaPath
- System.IterationPath
- System.Tags (semicolon-separated)
- Microsoft.VSTS.Common.Priority (1-4)
- Microsoft.VSTS.Scheduling.StoryPoints
- Microsoft.VSTS.Scheduling.Effort
- Microsoft.VSTS.Scheduling.RemainingWork
- Microsoft.VSTS.Scheduling.CompletedWork
- Microsoft.VSTS.Scheduling.OriginalEstimate
- Microsoft.VSTS.Common.ValueArea
- Microsoft.VSTS.Common.Risk
- Microsoft.VSTS.Common.Severity

Note: Does NOT update comments — use a separate tool for that.`,
  {
    workItemId: z.number().describe('The ID of the work item to update'),
    fields: z.array(
      z.object({
        referenceName: z.string().describe('The field reference name, e.g. System.Title, Microsoft.VSTS.Scheduling.StoryPoints'),
        value: z.union([z.string(), z.number(), z.null()]).describe('The new value for the field. Use null to clear a field.'),
      })
    ).describe('Array of fields to update with their new values'),
  },
  async ({ workItemId, fields }) => {
    try {
      const result = await client.updateWorkItemFields(workItemId, fields);

      const succeeded: { ref: string; requested: any; actual: any }[] = [];
      const unchanged: { ref: string; requested: any; reason: string }[] = [];
      const failed: { ref: string; requested: any; actual: any; reason: string }[] = [];

      const normalizeValue = (val: any): string => {
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return (val.displayName || val.name || JSON.stringify(val)).toString().trim().toLowerCase();
        return String(val).trim().toLowerCase();
      };

      for (const field of fields) {
        const actualValue = result.actualFields[field.referenceName];
        const previousValue = result.previousFields[field.referenceName];
        const requested = field.value;

        const actualNorm = normalizeValue(actualValue);
        const previousNorm = normalizeValue(previousValue);
        const requestedNorm = normalizeValue(requested);

        // Check if the actual value matches the requested value
        let matchesRequested = false;
        if (requested === null) {
          matchesRequested = actualNorm === '' || actualValue === null || actualValue === undefined || actualValue === 0;
        } else if (typeof requested === 'number') {
          matchesRequested = Number(actualNorm) === requested || actualNorm === requestedNorm;
        } else if (field.referenceName === 'System.Description' || field.referenceName === 'System.History') {
          matchesRequested = actualNorm.includes(requestedNorm) || actualNorm.replace(/<[^>]*>/g, '').includes(requestedNorm);
        } else {
          matchesRequested = actualNorm === requestedNorm || actualNorm.includes(requestedNorm);
        }

        // Check if the value actually changed from before
        let valueChanged = previousNorm !== actualNorm;
        // Check if the previous value already matched what was requested
        let previousMatchedRequested = false;
        if (requested === null) {
          previousMatchedRequested = previousNorm === '' || previousValue === null || previousValue === undefined || previousValue === 0;
        } else if (typeof requested === 'number') {
          previousMatchedRequested = Number(previousNorm) === requested || previousNorm === requestedNorm;
        } else if (field.referenceName === 'System.Description' || field.referenceName === 'System.History') {
          previousMatchedRequested = previousNorm.includes(requestedNorm) || previousNorm.replace(/<[^>]*>/g, '').includes(requestedNorm);
        } else {
          previousMatchedRequested = previousNorm === requestedNorm || previousNorm.includes(requestedNorm);
        }

        if (matchesRequested && valueChanged) {
          // Value changed to what we requested — genuine success
          succeeded.push({ ref: field.referenceName, requested, actual: actualValue });
        } else if (matchesRequested && !valueChanged && previousMatchedRequested) {
          // Before == After == Requested — field already had this value, no change was needed
          unchanged.push({
            ref: field.referenceName,
            requested,
            reason: 'Field already had this value — no change was needed',
          });
        } else if (!matchesRequested && !valueChanged) {
          // Before == After != Requested — update was rejected (field is locked/read-only)
          const actualDisplay = actualValue === undefined || actualValue === null || actualValue === ''
            ? '(empty)' : (typeof actualValue === 'object' ? normalizeValue(actualValue) : actualValue);
          failed.push({
            ref: field.referenceName,
            requested,
            actual: actualDisplay,
            reason: 'Update rejected — field is likely locked or read-only',
          });
        } else if (!matchesRequested && valueChanged) {
          // Value changed but not to what we requested
          failed.push({
            ref: field.referenceName,
            requested,
            actual: actualValue === undefined ? '(empty)' : (typeof actualValue === 'object' ? normalizeValue(actualValue) : actualValue),
            reason: actualValue === undefined
              ? 'Field not found in response — may be an invalid field name'
              : 'Value changed but does not match the requested value',
          });
        } else {
          // matchesRequested && !valueChanged && !previousMatchedRequested
          // Edge case: actual matches requested but value didn't change and previous didn't match
          // This shouldn't normally happen, but treat as suspicious
          failed.push({
            ref: field.referenceName,
            requested,
            actual: actualValue === undefined ? '(empty)' : (typeof actualValue === 'object' ? normalizeValue(actualValue) : actualValue),
            reason: 'Unexpected state — field may be locked or read-only',
          });
        }
      }

      let text = '';

      if (failed.length === 0 && unchanged.length === 0) {
        text += `✅ **Work Item #${result.id} — All ${fields.length} field(s) updated and verified successfully**\n\n`;
      } else if (failed.length === 0 && succeeded.length === 0) {
        text += `⚠️ **Work Item #${result.id} — No fields were actually changed**\n\n`;
      } else {
        text += `⚠️ **Work Item #${result.id} — ${succeeded.length} updated, ${unchanged.length} unchanged, ${failed.length} failed (out of ${fields.length})**\n\n`;
      }

      text += `**Title:** ${result.title}\n\n`;

      if (succeeded.length > 0) {
        text += `### ✅ Successfully Updated\n`;
        for (const s of succeeded) {
          const displayValue = s.requested === null ? '(cleared)' : String(s.requested);
          text += `- \`${s.ref}\` → ${displayValue}\n`;
        }
        text += `\n`;
      }

      if (unchanged.length > 0) {
        text += `### ⚠️ Unchanged\n`;
        text += `| Field | Requested Value | Reason |\n`;
        text += `|-------|----------------|--------|\n`;
        for (const u of unchanged) {
          const reqDisplay = u.requested === null ? '(clear)' : String(u.requested);
          text += `| \`${u.ref}\` | ${reqDisplay} | ${u.reason} |\n`;
        }
        text += `\n`;
      }

      if (failed.length > 0) {
        text += `### ❌ Failed Updates\n`;
        text += `| Field | Requested Value | Actual Value | Reason |\n`;
        text += `|-------|----------------|--------------|--------|\n`;
        for (const f of failed) {
          const reqDisplay = f.requested === null ? '(clear)' : String(f.requested);
          text += `| \`${f.ref}\` | ${reqDisplay} | ${f.actual} | ${f.reason} |\n`;
        }
        text += `\n`;
      }

      text += `🔗 [Open Work Item #${result.id}](${result.url})`;

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error updating work item: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Retrospective Boards
server.tool(
  'get_retrospective_boards',
  'List all retrospective boards for a team in your Azure DevOps project. Use this to find board IDs before fetching board details. If no teamName is specified, uses the configured team.',
  {
    teamName: z.string().optional().describe('Team name to fetch boards for (e.g. "Code4", "PDS_Avengers"). If not provided, uses the configured team.'),
  },
  async ({ teamName }) => {
    try {
      let teamId: string | undefined;
      if (teamName) {
        // Resolve custom team name to GUID
        const teamUrl = `${process.env.AZURE_DEVOPS_ORG_URL}/_apis/projects/${process.env.AZURE_DEVOPS_PROJECT}/teams/${encodeURIComponent(teamName)}?api-version=7.0`;
        const token = Buffer.from(`:${process.env.AZURE_DEVOPS_PAT}`).toString('base64');
        const resp = await fetch(teamUrl, { headers: { 'Authorization': `Basic ${token}`, 'Content-Type': 'application/json' } });
        if (!resp.ok) {
          return {
            content: [{ type: 'text' as const, text: `Error: Team "${teamName}" not found in project. Check the team name.` }],
            isError: true,
          };
        }
        const teamData = await resp.json() as any;
        teamId = teamData.id;
      }

      const boards = await client.getRetrospectiveBoards(teamId);

      if (boards.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No retrospective boards found for team "${teamName || process.env.AZURE_DEVOPS_TEAM}".` +
              (teamId ? ` (Team ID: ${teamId})` : '') +
              ` Ensure the "Retrospectives" extension is installed and at least one retro board has been created.` +
              `\n\nTip: If boards exist under a different team, try specifying the team name explicitly.`,
          }],
        };
      }

      let text = `**Retrospective Boards for Team: ${teamName || process.env.AZURE_DEVOPS_TEAM}** (${boards.length} total):\n\n`;
      text += '| # | Title | Created | Columns | Board ID |\n';
      text += '|---|-------|---------|---------|----------|\n';
      boards.forEach((b, i) => {
        const date = b.createdDate ? new Date(b.createdDate).toLocaleDateString() : 'N/A';
        const cols = b.columns.map(c => c.title).join(', ') || 'N/A';
        text += `| ${i + 1} | ${b.title} | ${date} | ${cols} | ${b.id} |\n`;
      });
      text += `\nUse **get_retrospective_analysis** with a Board ID to get full retrospective insights.`;

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error fetching retrospective boards: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Retrospective Analysis
server.tool(
  'get_retrospective_analysis',
  'Get full retrospective analysis for a board: what went well, what didn\'t go well, action items, team sentiment insights, and SARA recommendations. Provides categorized feedback with upvote counts and contributor analysis.',
  {
    boardId: z.string().describe('The retrospective board ID. Use get_retrospective_boards to find it.'),
  },
  async ({ boardId }) => {
    try {
      const analysis = await client.getRetrospectiveAnalysis(boardId);

      let text = '';

      // Header
      text += `# 🔄 Retrospective Analysis: ${analysis.board.title}\n\n`;
      if (analysis.board.createdDate) {
        text += `📅 **Board Created:** ${new Date(analysis.board.createdDate).toLocaleDateString()}\n`;
      }
      text += `📊 **Total Feedback Items:** ${analysis.totalItems}\n`;
      text += `📋 **Columns:** ${analysis.columns.join(' | ')}\n\n`;
      text += `---\n\n`;

      // What Went Well
      text += `## 🤝 What Went Well (${analysis.wentWell.length} items)\n\n`;
      if (analysis.wentWell.length > 0) {
        for (const item of analysis.wentWell) {
          const votes = item.upvotes > 0 ? ` (👍 ${item.upvotes})` : '';
          text += `- **${item.createdBy}**: ${item.title}${votes}\n`;
        }
      } else {
        text += `_No items in "What Went Well" category._\n`;
      }
      text += `\n---\n\n`;

      // What Didn't Go Well
      text += `## ⚠️ What Didn't Go Well (${analysis.didntGoWell.length} items)\n\n`;
      if (analysis.didntGoWell.length > 0) {
        for (const item of analysis.didntGoWell) {
          const votes = item.upvotes > 0 ? ` (👍 ${item.upvotes})` : '';
          text += `- **${item.createdBy}**: ${item.title}${votes}\n`;
        }
      } else {
        text += `_No items in "What Didn't Go Well" category._\n`;
      }
      text += `\n---\n\n`;

      // Action Items
      if (analysis.actionItems.length > 0) {
        text += `## 📌 Action Items / Try Next (${analysis.actionItems.length} items)\n\n`;
        for (const item of analysis.actionItems) {
          const votes = item.upvotes > 0 ? ` (👍 ${item.upvotes})` : '';
          text += `- **${item.createdBy}**: ${item.title}${votes}\n`;
        }
        text += `\n---\n\n`;
      }

      // Full breakdown by column (for any custom columns)
      const knownColumns = [...analysis.wentWell, ...analysis.didntGoWell, ...analysis.actionItems].map(i => i.id);
      const uncategorized = Object.entries(analysis.categorizedItems).filter(([colTitle]) => {
        const lower = colTitle.toLowerCase();
        const isKnown = ['what went well', 'went well', 'good', 'keep doing', 'liked', 'positives', 'start',
          'what didn\'t go well', 'didn\'t go well', 'improve', 'stop doing', 'disliked', 'negatives', 'stop', 'issues', 'problems',
          'action', 'todo', 'try'].some(n => lower.includes(n));
        return !isKnown;
      });

      if (uncategorized.length > 0) {
        text += `## 📂 Other Columns\n\n`;
        for (const [colTitle, colItems] of uncategorized) {
          text += `### ${colTitle} (${colItems.length} items)\n`;
          for (const item of colItems) {
            const votes = item.upvotes > 0 ? ` (👍 ${item.upvotes})` : '';
            text += `- **${item.createdBy}**: ${item.title}${votes}\n`;
          }
          text += `\n`;
        }
        text += `---\n\n`;
      }

      // ─── SARA Insights ───────────────────────────────────────────────────────
      text += `## 💡 SARA Insights & Recommendations\n\n`;

      const insights: string[] = [];

      // Team participation analysis
      const allItems = Object.values(analysis.categorizedItems).flat();
      const contributors = [...new Set(allItems.map(i => i.createdBy))];
      insights.push(`👥 **Team Participation:** ${contributors.length} contributor(s) provided feedback`);

      // Sentiment balance
      const wellCount = analysis.wentWell.length;
      const notWellCount = analysis.didntGoWell.length;
      const total = wellCount + notWellCount;
      if (total > 0) {
        const positiveRatio = Math.round((wellCount / total) * 100);
        if (positiveRatio >= 70) {
          insights.push(`🌟 **Positive Sprint Sentiment** — ${positiveRatio}% of feedback is positive. Team morale appears strong.`);
        } else if (positiveRatio <= 30) {
          insights.push(`🚨 **Low Sprint Sentiment** — Only ${positiveRatio}% positive feedback. Consider a focused improvement session.`);
        } else {
          insights.push(`⚖️ **Balanced Sentiment** — ${positiveRatio}% positive / ${100 - positiveRatio}% improvement areas. Healthy retrospective balance.`);
        }
      }

      // Most upvoted concerns
      const topConcerns = analysis.didntGoWell.filter(i => i.upvotes >= 2);
      if (topConcerns.length > 0) {
        insights.push(`🔥 **Top Team Concerns (2+ votes):**`);
        for (const concern of topConcerns.slice(0, 3)) {
          insights.push(`   - "${concern.title}" (👍 ${concern.upvotes} votes)`);
        }
      }

      // Most celebrated successes
      const topSuccesses = analysis.wentWell.filter(i => i.upvotes >= 2);
      if (topSuccesses.length > 0) {
        insights.push(`🏆 **Top Celebrations (2+ votes):**`);
        for (const success of topSuccesses.slice(0, 3)) {
          insights.push(`   - "${success.title}" (👍 ${success.upvotes} votes)`);
        }
      }

      // Action items coverage
      if (analysis.actionItems.length === 0 && notWellCount > 0) {
        insights.push(`⚠️ **No Action Items Defined** — There are ${notWellCount} improvement areas but no action items. Recommend defining at least 1-2 concrete actions for next sprint.`);
      } else if (analysis.actionItems.length > 0) {
        insights.push(`✅ **${analysis.actionItems.length} Action Item(s)** defined for improvement.`);
      }

      // Carryover risk
      const carryovers = allItems.filter(i => i.isGroupedCarryOver);
      if (carryovers.length > 0) {
        insights.push(`🔁 **${carryovers.length} carried-over item(s)** from previous retrospectives — indicates recurring unresolved issues.`);
      }

      for (const insight of insights) {
        text += `- ${insight}\n`;
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error analyzing retrospective board: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Manage Work Item Comment (Add / Update / Delete)
server.tool(
  'manage_work_item_comment',
  'Add, update, or delete a comment on a work item. Use action "add" to create a new comment, "update" to edit an existing comment (requires commentId), or "delete" to remove a comment (requires commentId). Use get_work_item_comments first to find comment IDs.',
  {
    workItemId: z.number().describe('The ID of the work item'),
    action: z.enum(['add', 'update', 'delete']).describe('The action to perform: add, update, or delete'),
    text: z.string().optional().describe('The comment text (required for add and update)'),
    commentId: z.number().optional().describe('The comment ID (required for update and delete). Use get_work_item_comments to find it.'),
  },
  async ({ workItemId, action, text, commentId }) => {
    try {
      if (action === 'add') {
        if (!text) {
          return {
            content: [{ type: 'text' as const, text: 'Error: "text" is required to add a comment.' }],
            isError: true,
          };
        }
        const comment = await client.addWorkItemComment(workItemId, text);
        return {
          content: [{
            type: 'text' as const,
            text: `✅ **Comment added to Work Item #${workItemId}**\n\n**Comment ID:** ${comment.id}\n**By:** ${comment.createdBy}\n**Date:** ${new Date(comment.createdDate).toLocaleString()}\n\n**Text:**\n${comment.text}\n\n🔗 [Open Work Item #${workItemId}](https://dev.azure.com/SHS-CT-ProcessTooling/PLM/_workitems/edit/${workItemId})`,
          }],
        };
      } else if (action === 'update') {
        if (!commentId) {
          return {
            content: [{ type: 'text' as const, text: 'Error: "commentId" is required to update a comment. Use get_work_item_comments to find comment IDs.' }],
            isError: true,
          };
        }
        if (!text) {
          return {
            content: [{ type: 'text' as const, text: 'Error: "text" is required to update a comment.' }],
            isError: true,
          };
        }
        const updated = await client.updateWorkItemComment(workItemId, commentId, text);
        return {
          content: [{
            type: 'text' as const,
            text: `✅ **Comment #${updated.id} updated on Work Item #${workItemId}**\n\n**Modified by:** ${updated.modifiedBy}\n**Date:** ${new Date(updated.modifiedDate).toLocaleString()}\n\n**New text:**\n${updated.text}\n\n🔗 [Open Work Item #${workItemId}](https://dev.azure.com/SHS-CT-ProcessTooling/PLM/_workitems/edit/${workItemId})`,
          }],
        };
      } else if (action === 'delete') {
        if (!commentId) {
          return {
            content: [{ type: 'text' as const, text: 'Error: "commentId" is required to delete a comment. Use get_work_item_comments to find comment IDs.' }],
            isError: true,
          };
        }
        await client.deleteWorkItemComment(workItemId, commentId);
        return {
          content: [{
            type: 'text' as const,
            text: `✅ **Comment #${commentId} deleted from Work Item #${workItemId}**\n\n🔗 [Open Work Item #${workItemId}](https://dev.azure.com/SHS-CT-ProcessTooling/PLM/_workitems/edit/${workItemId})`,
          }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Error: Unknown action "${action}". Use "add", "update", or "delete".` }],
        isError: true,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error managing comment: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Decompose Work Item (fetch Epic/Feature details for decomposition)
server.tool(
  'decompose_work_item',
  'Fetch full details of an Epic or Feature work item to analyze and decompose into child Features/User Stories. Returns the work item title, description, acceptance criteria, existing children, and metadata needed for intelligent decomposition. After analyzing, present the proposed breakdown to the user and wait for confirmation before creating.',
  {
    workItemId: z.number().describe('The ID of the Epic or Feature work item to decompose'),
  },
  async ({ workItemId }) => {
    try {
      const fields = await client.getWorkItemFields(workItemId);

      // Build a field map
      const f: Record<string, any> = {};
      for (const field of fields) {
        let val = field.value;
        if (val && typeof val === 'object') {
          val = val.displayName || val.name || JSON.stringify(val);
        }
        f[field.referenceName] = val ?? '';
      }

      const title = f['System.Title'] || '';
      const workItemType = f['System.WorkItemType'] || '';
      const description = f['System.Description'] || '';
      const acceptanceCriteria = f['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';
      const state = f['System.State'] || '';
      const areaPath = f['System.AreaPath'] || '';
      const iterationPath = f['System.IterationPath'] || '';
      const tags = f['System.Tags'] || '';
      const priority = f['Microsoft.VSTS.Common.Priority'] || '';
      const storyPoints = f['Microsoft.VSTS.Scheduling.StoryPoints'] || '';
      const assignedTo = f['System.AssignedTo'] || 'Unassigned';

      // Validate work item type
      const validTypes = ['Epic', 'Feature'];
      if (!validTypes.includes(workItemType)) {
        return {
          content: [{
            type: 'text' as const,
            text: `⚠️ Work item #${workItemId} is a **${workItemType}**, not an Epic or Feature. Decomposition works best with Epics (→ Features → User Stories) or Features (→ User Stories). Proceed with caution or provide an Epic/Feature ID.`,
          }],
        };
      }

      // Get existing children
      let existingChildren: any[] = [];
      try {
        existingChildren = await client.getWorkItemChildren(workItemId);
      } catch {
        // No children or error fetching
      }

      // HTML to plain text helper
      const stripHtml = (html: string) => {
        if (!html) return '';
        let text = html;
        text = text.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
        text = text.replace(/<p[^>]*>/gi, '');
        text = text.replace(/<\/p>/gi, '\n');
        text = text.replace(/<(strong|b)>/gi, '**');
        text = text.replace(/<\/(strong|b)>/gi, '**');
        text = text.replace(/<(em|i)>/gi, '*');
        text = text.replace(/<\/(em|i)>/gi, '*');
        text = text.replace(/<li[^>]*>/gi, '- ');
        text = text.replace(/<\/li>/gi, '\n');
        text = text.replace(/<\/?(ul|ol|div|span|table|tr|td|th|thead|tbody|h[1-6])[^>]*>/gi, '');
        text = text.replace(/<img[^>]*>/gi, '');
        text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
        text = text.replace(/<[^>]*>/g, '');
        text = text.replace(/&nbsp;/g, ' ');
        text = text.replace(/&amp;/g, '&');
        text = text.replace(/&lt;/g, '<');
        text = text.replace(/&gt;/g, '>');
        text = text.replace(/&quot;/g, '"');
        text = text.replace(/[ \t]+/g, ' ');
        text = text.replace(/\n{3,}/g, '\n\n');
        return text.trim();
      };

      const descriptionText = stripHtml(description);
      const acText = stripHtml(acceptanceCriteria);

      let output = `# 📋 Work Item for Decomposition\n\n`;
      output += `## Basic Info\n`;
      output += `| Field | Value |\n|-------|-------|\n`;
      output += `| **ID** | #${workItemId} |\n`;
      output += `| **Type** | ${workItemType} |\n`;
      output += `| **Title** | ${title} |\n`;
      output += `| **State** | ${state} |\n`;
      output += `| **Assigned To** | ${assignedTo} |\n`;
      output += `| **Area Path** | ${areaPath} |\n`;
      output += `| **Iteration Path** | ${iterationPath} |\n`;
      if (priority) output += `| **Priority** | ${priority} |\n`;
      if (storyPoints) output += `| **Story Points** | ${storyPoints} |\n`;
      if (tags) output += `| **Tags** | ${tags} |\n`;
      output += `\n---\n\n`;

      if (descriptionText) {
        output += `## Description\n\n${descriptionText}\n\n---\n\n`;
      } else {
        output += `## Description\n\n_No description provided._\n\n---\n\n`;
      }

      if (acText) {
        output += `## Acceptance Criteria\n\n${acText}\n\n---\n\n`;
      }

      if (existingChildren.length > 0) {
        output += `## Existing Children (${existingChildren.length})\n\n`;
        output += `| ID | Type | Title | State |\n|-----|------|-------|-------|\n`;
        for (const child of existingChildren) {
          output += `| #${child.id} | ${child.workItemType || ''} | ${child.title || ''} | ${child.state || ''} |\n`;
        }
        output += `\n---\n\n`;
      }

      output += `## Decomposition Instructions\n\n`;
      if (workItemType === 'Epic') {
        output += `This is an **Epic**. Decompose into **Features** first, then each Feature into **User Stories** with acceptance criteria.\n`;
      } else {
        output += `This is a **Feature**. Decompose into **User Stories** with proper acceptance criteria (Given/When/Then format).\n`;
      }
      output += `\nUse the INVEST model for each User Story:\n`;
      output += `- **I**ndependent — self-contained, no inherent dependency on another story\n`;
      output += `- **N**egotiable — not an explicit contract; leave room for discussion\n`;
      output += `- **V**aluable — delivers value to the end user\n`;
      output += `- **E**stimable — can be estimated in story points\n`;
      output += `- **S**mall — fits within a single sprint\n`;
      output += `- **T**estable — has clear acceptance criteria\n`;
      output += `\nAfter analysis, present the full decomposition to the user. Only create work items after user confirmation.`;

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error fetching work item #${workItemId}: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Bulk Create Work Items (create multiple child work items at once)
server.tool(
  'bulk_create_work_items',
  'Create multiple work items in Azure DevOps at once (e.g., User Stories under a Feature, or Features under an Epic). Each item can have title, description, acceptance criteria, story points, and will be linked as a child of the specified parent. Use this after user confirms the proposed decomposition.',
  {
    parentId: z.number().describe('The parent work item ID to link all created items under'),
    items: z.array(z.object({
      workItemType: z.enum(['User Story', 'Feature', 'Task', 'Bug'])
        .describe('Type of work item to create'),
      title: z.string().describe('Title of the work item'),
      description: z.string().optional().describe('Description in HTML format'),
      acceptanceCriteria: z.string().optional().describe('Acceptance criteria in HTML format (Given/When/Then)'),
      storyPoints: z.number().optional().describe('Story points estimate'),
      priority: z.number().optional().describe('Priority (1=Critical, 2=High, 3=Medium, 4=Low)'),
      tags: z.string().optional().describe('Semicolon-separated tags'),
    })).describe('Array of work items to create'),
    iterationPath: z.string().optional().describe('Iteration path for all items (if same)'),
    areaPath: z.string().optional().describe('Area path for all items (if same)'),
  },
  async ({ parentId, items, iterationPath, areaPath }) => {
    try {
      // Validate parent exists
      const parentCheck = await client.checkWorkItemExists(parentId);
      if (!parentCheck.exists) {
        return {
          content: [{ type: 'text' as const, text: `❌ Parent work item #${parentId} does not exist.` }],
          isError: true,
        };
      }

      const results: { id: number; type: string; title: string; url: string; success: boolean; error?: string }[] = [];

      for (const item of items) {
        try {
          const result = await client.createWorkItem(item.workItemType, item.title, {
            description: item.description,
            acceptanceCriteria: item.acceptanceCriteria,
            storyPoints: item.storyPoints,
            priority: item.priority,
            tags: item.tags,
            parentId,
            iterationPath,
            areaPath,
          });
          results.push({
            id: result.id,
            type: item.workItemType,
            title: item.title,
            url: result.url,
            success: true,
          });
        } catch (err: any) {
          results.push({
            id: 0,
            type: item.workItemType,
            title: item.title,
            url: '',
            success: false,
            error: err.message,
          });
        }
      }

      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);

      let output = `# ✅ Bulk Work Item Creation Summary\n\n`;
      output += `**Parent:** ${parentCheck.workItemType} #${parentId} — ${parentCheck.title}\n\n`;
      output += `**Created:** ${successful.length} / ${items.length} items\n\n`;

      if (successful.length > 0) {
        output += `## Successfully Created\n\n`;
        output += `| # | Type | ID | Title | Link |\n`;
        output += `|---|------|----|-------|------|\n`;
        successful.forEach((r, i) => {
          output += `| ${i + 1} | ${r.type} | #${r.id} | ${r.title} | [Open](${r.url}) |\n`;
        });
        output += `\n`;
      }

      if (failed.length > 0) {
        output += `## ❌ Failed\n\n`;
        output += `| # | Type | Title | Error |\n`;
        output += `|---|------|-------|-------|\n`;
        failed.forEach((r, i) => {
          output += `| ${i + 1} | ${r.type} | ${r.title} | ${r.error} |\n`;
        });
        output += `\n`;
      }

      const totalSP = items.reduce((sum, item) => sum + (item.storyPoints || 0), 0);
      output += `---\n\n`;
      output += `**📊 Total Story Points:** ${totalSP}\n`;
      output += `**🔗 All items linked as children of #${parentId}**\n`;

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Error in bulk creation: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// SHAREPOINT TOOLS
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'sharepoint_login',
  'Check SharePoint authentication status. If not signed in, triggers device code login and returns instructions.',
  {},
  async () => {
    try {
      const status = await getAuthStatus();
      if (status.authenticated) {
        return { content: [{ type: 'text' as const, text: `✅ Authenticated as **${status.user}**` }] };
      }
      const loginResult = await triggerLogin();
      if (loginResult.authenticated) {
        return { content: [{ type: 'text' as const, text: `✅ Authenticated as **${loginResult.user}**` }] };
      }
      return {
        content: [{
          type: 'text' as const,
          text: loginResult.deviceCodeMessage
            ? `🔐 **Login Required**\n\n${loginResult.deviceCodeMessage}\n\n**After signing in, try your search again.**`
            : '❌ Authentication failed. Please try again.',
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
    }
  }
);

server.tool(
  'sharepoint_logout',
  'Sign out of SharePoint and clear cached credentials',
  {},
  async () => {
    try {
      await logout();
      return { content: [{ type: 'text' as const, text: '✅ Signed out. Token cache cleared.' }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
    }
  }
);

server.tool(
  'sharepoint_status',
  'Check if currently signed in to SharePoint',
  {},
  async () => {
    try {
      const status = await getAuthStatus();
      return {
        content: [{
          type: 'text' as const,
          text: status.authenticated
            ? `✅ Signed in as **${status.user}**`
            : '❌ Not signed in. Use sharepoint_login to authenticate.',
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
    }
  }
);

server.tool(
  'sharepoint_list_documents',
  'List documents in a SharePoint document library',
  {
    siteUrl: z.string().default(process.env.SHAREPOINT_SITE_URL || '').describe('SharePoint site URL (defaults to SHAREPOINT_SITE_URL env var)'),
    library: z.string().default(process.env.SHAREPOINT_DEFAULT_LIBRARY || 'Shared Documents').describe('Document library name'),
    folderPath: z.string().optional().describe('Folder path within the library'),
    count: z.number().min(1).max(100).default(25).describe('Maximum documents to return'),
  },
  async ({ siteUrl, library, folderPath, count }) => {
    try {
      if (!siteUrl) return { content: [{ type: 'text' as const, text: 'Error: No siteUrl provided and SHAREPOINT_SITE_URL env var is not set.' }], isError: true };
      const docs = await listDocuments(siteUrl, library, folderPath, count);
      return { content: [{ type: 'text' as const, text: formatDocumentList(docs, library) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
    }
  }
);

server.tool(
  'sharepoint_search_documents',
  'Search for documents across SharePoint sites by keyword',
  {
    query: z.string().describe('Search query'),
    siteUrl: z.string().default(process.env.SHAREPOINT_SITE_URL || '').describe('Limit search to a specific site URL (defaults to SHAREPOINT_SITE_URL env var)'),
    fileType: z.string().optional().describe("Filter by file type (e.g., 'docx', 'pdf', 'xlsx')"),
    count: z.number().min(1).max(50).default(20).describe('Maximum results'),
  },
  async ({ query, siteUrl, fileType, count }) => {
    try {
      const results = await searchDocuments(query, siteUrl || undefined, fileType, count);
      return { content: [{ type: 'text' as const, text: formatSearchResults(results, query) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
    }
  }
);

server.tool(
  'sharepoint_get_document',
  'Get content or metadata of a specific document',
  {
    documentUrl: z.string().describe('Full URL or path to the document'),
    metadataOnly: z.boolean().default(false).describe('If true, return only metadata without content'),
  },
  async ({ documentUrl, metadataOnly }) => {
    try {
      const doc = await getDocumentContent(documentUrl, metadataOnly);
      return { content: [{ type: 'text' as const, text: doc }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
    }
  }
);

server.tool(
  'sharepoint_list_sites',
  'List accessible SharePoint sites',
  {
    query: z.string().optional().describe('Filter sites by name'),
  },
  async ({ query }) => {
    try {
      const sites = await listSites(query);
      const rows = sites.map((s: any) => `| ${s.name} | ${s.url} | ${s.description || '-'} |`).join('\n');
      const text = `## SharePoint Sites\n\n| Name | URL | Description |\n|------|-----|-------------|\n${rows}`;
      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
    }
  }
);

server.tool(
  'sharepoint_get_list_items',
  'Get items from a SharePoint list (e.g., Action Items, Tasks, Issues)',
  {
    siteUrl: z.string().default(process.env.SHAREPOINT_SITE_URL || '').describe('SharePoint site URL (defaults to SHAREPOINT_SITE_URL env var)'),
    listName: z.string().describe('Name of the list'),
    filter: z.string().optional().describe('OData filter expression'),
    count: z.number().min(1).max(100).default(50).describe('Maximum items'),
  },
  async ({ siteUrl, listName, filter, count }) => {
    try {
      if (!siteUrl) return { content: [{ type: 'text' as const, text: 'Error: No siteUrl provided and SHAREPOINT_SITE_URL env var is not set.' }], isError: true };
      const items = await getListItems(siteUrl, listName, filter, count);
      return { content: [{ type: 'text' as const, text: formatListItems(items, listName) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
    }
  }
);

server.tool(
  'sharepoint_recent_changes',
  'Get recently modified documents and list items in a site',
  {
    siteUrl: z.string().default(process.env.SHAREPOINT_SITE_URL || '').describe('SharePoint site URL (defaults to SHAREPOINT_SITE_URL env var)'),
    days: z.number().min(1).max(30).default(7).describe('Look back N days'),
  },
  async ({ siteUrl, days }) => {
    try {
      if (!siteUrl) return { content: [{ type: 'text' as const, text: 'Error: No siteUrl provided and SHAREPOINT_SITE_URL env var is not set.' }], isError: true };
      const changes = await getRecentChanges(siteUrl, days);
      return { content: [{ type: 'text' as const, text: changes }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Azure DevOps MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
