import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Client as ClientType } from '@modelcontextprotocol/sdk/client/index.js';

// ─── Hoisted shared state (accessible both inside vi.mock factories and in tests) ──
const clientMockRef = vi.hoisted(() => ({ instance: {} as Record<string, any> }));
const transportsRef = vi.hoisted(() => ({ pair: null as any }));
const execFileImplRef = vi.hoisted(() => ({ impl: vi.fn() }));

// Replace the real AzureDevOpsClient with a fully-controllable fake so we can
// drive every MCP tool handler's business logic without hitting a real API.
vi.mock('../src/azure-devops-client.js', () => ({
  AzureDevOpsClient: vi.fn().mockImplementation(() => clientMockRef.instance),
}));

// The SharePoint modules perform MSAL / Graph setup at import time; stub them
// out entirely since none of the tool-integration tests below exercise SharePoint tools.
vi.mock('../src/sharepoint/auth.js', () => ({
  getAuthStatus: vi.fn(),
  logout: vi.fn(),
  triggerLogin: vi.fn(),
}));

vi.mock('../src/sharepoint/sharepoint.js', () => ({
  listDocuments: vi.fn(),
  searchDocuments: vi.fn(),
  getDocumentContent: vi.fn(),
  listSites: vi.fn(),
  getListItems: vi.fn(),
  getRecentChanges: vi.fn(),
}));

// `draft_sprint_email` shells out via `promisify(execFile)`. We replicate Node's
// custom-promisify hook (the well-known symbol child_process.execFile normally
// carries) so `await execFileAsync(...)` resolves exactly like the real API.
vi.mock('node:child_process', () => {
  const customSymbol = Symbol.for('nodejs.util.promisify.custom');
  function execFile(...args: any[]) {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb(new Error('callback-style execFile is not implemented in this test mock'));
  }
  (execFile as any)[customSymbol] = (...args: any[]) => execFileImplRef.impl(...args);
  return { execFile };
});

// `src/index.ts` unconditionally connects to a StdioServerTransport and calls
// process.stdin/stdout. We swap it for one end of an InMemoryTransport pair so
// the real McpServer instance can be driven directly by a real SDK Client in tests.
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', async () => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const pair = InMemoryTransport.createLinkedPair();
  transportsRef.pair = pair;
  return {
    StdioServerTransport: vi.fn(() => pair[0]),
  };
});

let client: ClientType;

function resetAzureClientMock() {
  Object.assign(clientMockRef.instance, {
    getCurrentSprint: vi.fn(),
    getSprintWorkItems: vi.fn(),
    getIterations: vi.fn(),
    getCarryoverStories: vi.fn(),
    getDeliveryAnalysis: vi.fn(),
    createWorkItem: vi.fn(),
    checkWorkItemExists: vi.fn(),
    getTeamCapacity: vi.fn(),
    getWorkItemChildren: vi.fn(),
    getWorkItemComments: vi.fn(),
    getWorkItemAttachments: vi.fn(),
    getPipelines: vi.fn(),
    getPipelineRuns: vi.fn(),
    getPipelineHealth: vi.fn(),
    queryWorkItems: vi.fn(),
  });
}

beforeAll(async () => {
  resetAzureClientMock();

  // Importing index.ts triggers `main()`, which connects the real McpServer to
  // our in-memory transport (see the stdio mock above).
  await import('../src/index.js');

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transportsRef.pair[1]);
});

afterAll(async () => {
  await client?.close();
});

describe('MCP tool registration (smoke test)', () => {
  test('registers all 37 tools with a name, description, and input schema', async () => {
    const { tools } = await client.listTools();

    expect(tools.length).toBe(37);
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }

    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate tool names

    // Spot-check a representative cross-section of core Sprint Review tools.
    expect(names).toEqual(
      expect.arrayContaining([
        'get_current_sprint',
        'get_sprint_work_items',
        'get_sprint_burndown',
        'get_delivery_analysis',
        'get_bug_trend_chart',
        'get_sprint_history',
        'get_team_capacity',
        'get_iterations',
        'get_developer_performance',
        'draft_sprint_email',
        'query_work_items',
        'link_work_items',
        'create_work_item',
        'get_work_item_attachments',
        'get_attachment_content',
        'get_work_item_children',
        'get_work_item_comments',
        'get_pipelines',
        'get_pipeline_runs',
        'get_pipeline_health',
        'check_work_item',
        'update_work_item',
        'get_retrospective_boards',
        'get_retrospective_analysis',
      ])
    );
  });
});

describe('tool: get_current_sprint', () => {
  test('returns the current sprint as JSON', async () => {
    resetAzureClientMock();
    clientMockRef.instance.getCurrentSprint.mockResolvedValue({
      id: 'iter-1', name: 'Sprint 14', path: 'P\\T\\Sprint 14', startDate: '2026-07-06', finishDate: '2026-07-10', timeFrame: 'current',
    });

    const result: any = await client.callTool({ name: 'get_current_sprint', arguments: {} });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain('Sprint 14');
  });

  test('surfaces client errors as an MCP tool error', async () => {
    resetAzureClientMock();
    clientMockRef.instance.getCurrentSprint.mockRejectedValue(new Error('No current sprint found'));

    const result: any = await client.callTool({ name: 'get_current_sprint', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No current sprint found');
  });
});

describe('tool: get_sprint_history', () => {
  test('flags recurring carryover stories by severity', async () => {
    resetAzureClientMock();
    clientMockRef.instance.getCurrentSprint.mockResolvedValue({ id: 'iter-1', name: 'Sprint 14', path: 'P\\T\\Sprint 14' });
    clientMockRef.instance.getCarryoverStories.mockResolvedValue([
      { workItemId: 1, sprintCount: 3, sprints: ['S12', 'S13', 'S14'] },
      { workItemId: 2, sprintCount: 2, sprints: ['S13', 'S14'] },
    ]);

    const result: any = await client.callTool({ name: 'get_sprint_history', arguments: {} });
    const flagged = JSON.parse(result.content[0].text);

    expect(flagged[0]).toMatchObject({ workItemId: 1, severity: '🚨 CRITICAL' });
    expect(flagged[1]).toMatchObject({ workItemId: 2, severity: '⚠️ WARNING' });
  });
});

describe('tool: get_developer_performance', () => {
  test('groups sprint work items by developer with completed story points', async () => {
    resetAzureClientMock();
    clientMockRef.instance.getCurrentSprint.mockResolvedValue({ id: 'iter-1', name: 'Sprint 14' });
    clientMockRef.instance.getSprintWorkItems.mockResolvedValue([
      { id: 1, title: 'A', state: 'Done', assignedTo: 'Alice', storyPoints: 5, workItemType: 'User Story' },
      { id: 2, title: 'B', state: 'Active', assignedTo: 'Alice', storyPoints: 3, workItemType: 'User Story' },
      { id: 3, title: 'C', state: 'New', assignedTo: 'Bob', storyPoints: 2, workItemType: 'Bug' },
      { id: 4, title: 'D', state: 'Done', assignedTo: 'Bob', storyPoints: 1, workItemType: 'Task' }, // excluded type
    ]);

    const result: any = await client.callTool({ name: 'get_developer_performance', arguments: {} });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.developers.Alice).toMatchObject({ assigned: 2, completed: 1, inProgress: 1, storyPointsTotal: 8, storyPointsCompleted: 5 });
    expect(payload.developers.Bob).toMatchObject({ assigned: 1, storyPointsTotal: 2 }); // Task type excluded from assigned count
  });
});

describe('tool: get_iterations', () => {
  test('returns all iterations as JSON', async () => {
    resetAzureClientMock();
    clientMockRef.instance.getIterations.mockResolvedValue([
      { id: 'iter-1', name: 'Sprint 13', path: 'P\\T\\Sprint 13', startDate: '', finishDate: '', timeFrame: 'past' },
      { id: 'iter-2', name: 'Sprint 14', path: 'P\\T\\Sprint 14', startDate: '', finishDate: '', timeFrame: 'current' },
    ]);

    const result: any = await client.callTool({ name: 'get_iterations', arguments: {} });
    const iterations = JSON.parse(result.content[0].text);

    expect(iterations).toHaveLength(2);
    expect(iterations[1].name).toBe('Sprint 14');
  });
});

describe('tool: create_work_item', () => {
  test('creates a work item and reports its id/link', async () => {
    resetAzureClientMock();
    clientMockRef.instance.createWorkItem.mockResolvedValue({ id: 55, title: 'New Story', url: 'https://dev.azure.com/org/proj/_workitems/edit/55' });

    const result: any = await client.callTool({
      name: 'create_work_item',
      arguments: { workItemType: 'User Story', title: 'New Story', storyPoints: 5 },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('#55');
    expect(clientMockRef.instance.createWorkItem).toHaveBeenCalledWith('User Story', 'New Story', expect.objectContaining({ storyPoints: 5 }));
  });

  test('reports an error when creation fails', async () => {
    resetAzureClientMock();
    clientMockRef.instance.createWorkItem.mockRejectedValue(new Error('Failed to create work item (400): bad field'));

    const result: any = await client.callTool({
      name: 'create_work_item',
      arguments: { workItemType: 'Bug', title: 'Broken' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('bad field');
  });
});

describe('tool: check_work_item', () => {
  test('reports basic details for an existing work item', async () => {
    resetAzureClientMock();
    clientMockRef.instance.checkWorkItemExists.mockResolvedValue({
      exists: true, id: 42, title: 'Fix crash', state: 'Active', workItemType: 'Bug', assignedTo: 'Carol',
      areaPath: 'P\\Area', iterationPath: 'P\\T\\Sprint 14', url: 'https://dev.azure.com/org/proj/_workitems/edit/42',
    });

    const result: any = await client.callTool({ name: 'check_work_item', arguments: { workItemId: 42 } });
    expect(result.content[0].text).toContain('Fix crash');
    expect(result.content[0].text).toContain('exists');
  });

  test('reports non-existence for a missing work item', async () => {
    resetAzureClientMock();
    clientMockRef.instance.checkWorkItemExists.mockResolvedValue({ exists: false });

    const result: any = await client.callTool({ name: 'check_work_item', arguments: { workItemId: 999 } });
    expect(result.content[0].text).toContain('does **not exist**');
  });
});

describe('tool: get_delivery_analysis', () => {
  test('renders the 7-section delivery report from the analysis result', async () => {
    resetAzureClientMock();
    clientMockRef.instance.getDeliveryAnalysis.mockResolvedValue({
      parent: {
        id: 600, title: 'Feature X', type: 'Feature', state: 'Active', assignedTo: 'PO',
        iterationPath: 'P\\T\\Sprint 14', areaPath: 'P\\Area', startDate: '2026-06-01', targetDate: '2026-07-15',
        activatedDate: '2026-06-01', resolvedDate: '', priority: 2, risk: '2 - Medium', valueArea: 'Business', tags: '',
      },
      generatedAt: '2026-07-10T00:00:00Z',
      children: [
        { id: 1, title: 'Done child', type: 'User Story', state: 'Done', stateCategory: 'done', assignedTo: 'Alice', storyPoints: 5, completedWork: 0, risk: '', iterationPath: '', tags: '', stateChangeDate: '' },
      ],
      progress: { total: 1, done: 1, inProgress: 0, notStarted: 0, removed: 0, percentComplete: 100 },
      storyPoints: { total: 5, completed: 5, remaining: 0, unestimated: 0 },
      timeline: { startDate: '2026-06-01', targetDate: '2026-07-15', daysElapsed: 39, daysRemaining: 5, status: 'At Risk' },
      blockers: [],
      teamContribution: [{ name: 'Alice', totalItems: 1, completed: 1, inProgress: 0, storyPointsDelivered: 5 }],
    });

    const result: any = await client.callTool({ name: 'get_delivery_analysis', arguments: { workItemId: 600 } });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain('Feature X');
    expect(text).toContain('#600');
    expect(clientMockRef.instance.getDeliveryAnalysis).toHaveBeenCalledWith(600);
  });
});

describe('tool: draft_sprint_email', () => {
  test('creates a draft email successfully', async () => {
    execFileImplRef.impl.mockResolvedValue({ stdout: JSON.stringify({ success: true, to: 'team@example.com' }), stderr: '' });

    const result: any = await client.callTool({
      name: 'draft_sprint_email',
      arguments: { subject: 'Sprint 14 Review', body: '<h2>Overview</h2><p>All good</p>', to: 'team@example.com' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Draft email created successfully');
    expect(result.content[0].text).toContain('team@example.com');
  });

  test('reports failure when the Outlook script reports failure', async () => {
    execFileImplRef.impl.mockResolvedValue({ stdout: JSON.stringify({ success: false, message: 'Outlook is not installed' }), stderr: '' });

    const result: any = await client.callTool({
      name: 'draft_sprint_email',
      arguments: { subject: 'Sprint 14 Review', body: '<p>Body</p>' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Outlook is not installed');
  });

  test('reports an error when the PowerShell script throws', async () => {
    execFileImplRef.impl.mockRejectedValue(new Error('spawn powershell.exe ENOENT'));

    const result: any = await client.callTool({
      name: 'draft_sprint_email',
      arguments: { subject: 'Sprint 14 Review', body: '<p>Body</p>' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error creating draft email');
  });
});
