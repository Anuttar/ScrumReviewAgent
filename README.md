# Sprint Review Agent

An AI-powered Scrum Sprint Review agent that connects to Azure DevOps Server via MCP (Model Context Protocol) to analyze your team's sprint board.

## Project Structure

```
ScrumReviewAgent/
├── .github/
│   └── agents/
│       └── sprint-review.agent.md    # Custom Copilot agent definition
├── .vscode/
│   └── mcp.json                      # MCP server configuration for VS Code
├── mcp-server/
│   ├── src/
│   │   ├── index.ts                  # MCP server entry point (tool definitions)
│   │   └── azure-devops-client.ts    # Azure DevOps REST API client
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   └── .gitignore
└── README.md
```

## Quick Setup

### 1. Install Dependencies

```bash
cd mcp-server
npm install
```

### 2. Build the MCP Server

```bash
npm run build
```

### 3. Configure Environment

Copy `.env.example` to `.env` and fill in your Azure DevOps credentials:

```
AZURE_DEVOPS_ORG_URL=https://dev.azure.com/your-org
AZURE_DEVOPS_PROJECT=YourProject
AZURE_DEVOPS_TEAM=YourTeam
AZURE_DEVOPS_PAT=your-personal-access-token
```

### 4. Use the Agent

In VS Code Copilot Chat, select the **Sprint Review Analyst** agent from the agent picker, then ask:

- "Analyze the current sprint"
- "Show me developer performance this sprint"
- "Which stories have been carried over?"
- "Give me a sprint health report"

---

## How to Create a Personal Access Token (PAT)

1. Go to Azure DevOps → User Settings → Personal Access Tokens
2. Click **New Token**
3. Set scope: `Work Items (Read)` — this is the minimum required
4. Copy the token and store it securely

---

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `get_current_sprint` | Fetches the active sprint's name, dates, and timeframe |
| `get_sprint_work_items` | Retrieves all work items in the sprint (stories, tasks, bugs) |
| `get_sprint_history` | Detects carryover stories and flags recurring carryovers |
| `get_team_capacity` | Gets team member allocation and days off |
| `get_iterations` | Lists all past, current, and future sprint iterations |
| `get_developer_performance` | Analyzes per-developer metrics (assigned, completed, story points) |

---

## What is MCP (Model Context Protocol)?

MCP is a protocol that lets AI assistants (like GitHub Copilot) communicate with external tools and data sources through a standardized interface. Think of it as a "USB port" for AI — any MCP server can plug into any MCP-compatible AI client.

### Key Concepts

| Concept | Description |
|---------|-------------|
| **MCP Server** | A process that exposes tools/resources to AI clients via the MCP protocol |
| **Transport** | Communication channel (stdio, HTTP/SSE) between client and server |
| **Tools** | Functions the AI can call (like `get_sprint_work_items`) |
| **Resources** | Data endpoints the AI can read (like files or API responses) |
| **Prompts** | Pre-defined prompt templates the server can offer |

### How It Works

```
┌─────────────┐     stdio/HTTP      ┌─────────────────┐      REST API      ┌──────────────┐
│  VS Code    │◄───────────────────►│  MCP Server     │◄──────────────────►│ Azure DevOps │
│  Copilot    │   MCP Protocol      │  (Node.js)      │   Azure DevOps API │ Server       │
└─────────────┘                     └─────────────────┘                    └──────────────┘
```

1. **VS Code** starts the MCP server as a child process (stdio transport)
2. **Copilot** discovers available tools by calling `tools/list`
3. When the agent needs data, it calls a tool (e.g., `get_sprint_work_items`)
4. The **MCP server** translates this into Azure DevOps REST API calls
5. Results flow back to Copilot for analysis

### Creating Your Own MCP Server

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// 1. Create server instance
const server = new McpServer({
  name: 'my-server',
  version: '1.0.0',
});

// 2. Define tools with input schema validation
server.tool(
  'tool_name',                          // Tool identifier
  'Description of what this tool does', // Shown to the AI
  { param: z.string().describe('...') }, // Input schema (zod)
  async ({ param }) => {                // Handler function
    // Your logic here
    return {
      content: [{ type: 'text', text: 'result' }],
    };
  }
);

// 3. Connect via stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Registering in VS Code

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "my-server": {
      "type": "stdio",
      "command": "node",
      "args": ["path/to/server.js"],
      "env": {
        "API_KEY": "${input:apiKey}"
      }
    }
  }
}
```

### MCP Server Functions/Capabilities

| Function | Purpose |
|----------|---------|
| `server.tool(name, desc, schema, handler)` | Register a callable tool |
| `server.resource(uri, handler)` | Expose a readable resource |
| `server.prompt(name, desc, handler)` | Offer a prompt template |
| `server.connect(transport)` | Start listening for connections |

---

## Future Enhancements (Planned)

- [ ] Create user stories directly from the agent
- [ ] Update work item states
- [ ] Sprint planning assistance
- [ ] Velocity trend analysis across multiple sprints
- [ ] Integration with team notifications
