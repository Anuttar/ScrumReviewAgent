import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fetch from 'node-fetch';
import { AzureDevOpsClient, AzureDevOpsConfig } from './azure-devops-client.js';

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

// Tool: Get Team Capacity
server.tool(
  'get_team_capacity',
  'Get team member capacity and allocation for the current sprint',
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

      const capacity = await client.getTeamCapacity(sprintId);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(capacity, null, 2),
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
  },
  async ({ subject, body, to }) => {
    try {
      const scriptPath = path.resolve(__dirname, '..', 'scripts', 'create-outlook-draft.ps1');

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
${body}
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
    assignedTo: z.string().optional().describe('Display name or email of the person to assign the work item to'),
    iterationPath: z.string().optional()
      .describe('Iteration path (e.g. "PLM\\PDS\\2026\\Avengers\\Q4\\Sprint 14"). If not provided, defaults to the project root iteration.'),
    areaPath: z.string().optional().describe('Area path for the work item'),
    state: z.string().optional().describe('Initial state (e.g. "New", "Active"). Defaults to "New".'),
    storyPoints: z.number().optional().describe('Story points estimate (for User Stories/PBIs)'),
    tags: z.string().optional().describe('Semicolon-separated tags (e.g. "Frontend; Bug; Sprint14")'),
    parentId: z.number().optional().describe('ID of the parent work item to link this as a child of'),
  },
  async ({ workItemType, title, description, assignedTo, iterationPath, areaPath, state, storyPoints, tags, parentId }) => {
    try {
      const result = await client.createWorkItem(workItemType, title, {
        description,
        assignedTo,
        iterationPath,
        areaPath,
        state,
        storyPoints,
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
