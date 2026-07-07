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
