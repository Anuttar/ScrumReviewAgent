import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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
        text += `---\n**${comment.createdBy}** — ${date}\n\n${comment.text}\n\n`;
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
