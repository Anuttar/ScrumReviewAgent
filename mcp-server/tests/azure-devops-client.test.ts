import { describe, test, expect, vi, beforeEach } from 'vitest';
import { AzureDevOpsClient } from '../src/azure-devops-client.js';

// `node-fetch`'s default export is mocked so we can serve canned JSON
// responses keyed by URL pattern, without hitting the real Azure DevOps API.
vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

import fetch from 'node-fetch';

const mockedFetch = fetch as unknown as ReturnType<typeof vi.fn>;

type Route = { test: RegExp; handler: (url: string, init?: any) => any };

/** Build a fetch mock that resolves canned JSON based on which URL pattern matches. */
function routeFetch(routes: Route[], options: { okByDefault?: boolean } = {}) {
  mockedFetch.mockImplementation(async (url: string, init?: any) => {
    for (const route of routes) {
      if (route.test.test(url)) {
        const result = route.handler(url, init);
        if (result && result.__raw) {
          return result.response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => result,
          text: async () => JSON.stringify(result),
        };
      }
    }
    throw new Error(`No mock route matched for URL: ${url}`);
  });
}

function errorResponse(status: number, body: string) {
  return {
    __raw: true,
    response: {
      ok: false,
      status,
      json: async () => JSON.parse(body),
      text: async () => body,
    },
  };
}

const config = {
  orgUrl: 'https://dev.azure.com/test-org',
  project: 'TestProject',
  team: 'TestTeam',
  pat: 'test-pat',
};

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('AzureDevOpsClient — request()', () => {
  test('throws a descriptive error when the API responds with a non-2xx status', async () => {
    routeFetch([
      { test: /teams\/TestTeam/, handler: () => errorResponse(401, 'Unauthorized: bad PAT') },
    ]);
    const client = new AzureDevOpsClient(config);

    await expect(client.getTeamId()).rejects.toThrow('Azure DevOps API error (401): Unauthorized: bad PAT');
  });
});

describe('AzureDevOpsClient — getTeamId', () => {
  test('resolves the team GUID from the Teams API', async () => {
    routeFetch([
      { test: /_apis\/projects\/TestProject\/teams\/TestTeam/, handler: () => ({ id: 'team-guid-123', name: 'TestTeam' }) },
    ]);
    const client = new AzureDevOpsClient(config);

    await expect(client.getTeamId()).resolves.toBe('team-guid-123');
  });
});

describe('AzureDevOpsClient — getCurrentSprint / getIterations', () => {
  test('normalizes the current sprint, pulling dates from attributes when top-level fields are absent', async () => {
    routeFetch([
      {
        test: /teamsettings\/iterations\?\$timeframe=current/,
        handler: () => ({
          value: [
            {
              id: 'iter-1',
              name: 'Sprint 14',
              path: 'TestProject\\TestTeam\\Sprint 14',
              attributes: { startDate: '2026-07-06T00:00:00Z', finishDate: '2026-07-10T00:00:00Z', timeFrame: 'current' },
            },
          ],
        }),
      },
    ]);
    const client = new AzureDevOpsClient(config);

    const sprint = await client.getCurrentSprint();
    expect(sprint).toEqual({
      id: 'iter-1',
      name: 'Sprint 14',
      path: 'TestProject\\TestTeam\\Sprint 14',
      startDate: '2026-07-06T00:00:00Z',
      finishDate: '2026-07-10T00:00:00Z',
      timeFrame: 'current',
    });
  });

  test('throws when no current sprint is returned', async () => {
    routeFetch([
      { test: /teamsettings\/iterations\?\$timeframe=current/, handler: () => ({ value: [] }) },
    ]);
    const client = new AzureDevOpsClient(config);

    await expect(client.getCurrentSprint()).rejects.toThrow('No current sprint found');
  });

  test('getIterations returns all iterations normalized', async () => {
    routeFetch([
      {
        test: /teamsettings\/iterations\?api-version/,
        handler: () => ({
          value: [
            { id: 'iter-1', name: 'Sprint 13', path: 'P\\T\\Sprint 13', attributes: { startDate: '2026-06-15', finishDate: '2026-06-26', timeFrame: 'past' } },
            { id: 'iter-2', name: 'Sprint 14', path: 'P\\T\\Sprint 14', attributes: { startDate: '2026-07-06', finishDate: '2026-07-10', timeFrame: 'current' } },
          ],
        }),
      },
    ]);
    const client = new AzureDevOpsClient(config);

    const iterations = await client.getIterations();
    expect(iterations).toHaveLength(2);
    expect(iterations.map((i) => i.name)).toEqual(['Sprint 13', 'Sprint 14']);
  });
});

describe('AzureDevOpsClient — getWorkItemDetails', () => {
  test('maps raw fields to WorkItem shape, defaulting missing assignee/story points', async () => {
    routeFetch([
      {
        test: /_apis\/wit\/workitems\?ids=1,2/,
        handler: () => ({
          value: [
            {
              id: 1,
              fields: {
                'System.Title': 'Implement login',
                'System.State': 'Active',
                'System.AssignedTo': { displayName: 'Alice' },
                'Microsoft.VSTS.Scheduling.StoryPoints': 5,
                'System.WorkItemType': 'User Story',
                'System.IterationPath': 'P\\T\\Sprint 14',
                'System.CreatedDate': '2026-07-01T00:00:00Z',
                'System.ChangedDate': '2026-07-05T00:00:00Z',
                'System.Tags': 'Frontend',
                'System.BoardColumn': 'Doing',
              },
            },
            {
              id: 2,
              fields: {
                'System.Title': 'Unassigned bug',
                'System.State': 'New',
                'System.WorkItemType': 'Bug',
              },
            },
          ],
        }),
      },
    ]);
    const client = new AzureDevOpsClient(config);

    const items = await client.getWorkItemDetails([1, 2]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 1, title: 'Implement login', assignedTo: 'Alice', storyPoints: 5 });
    expect(items[1]).toMatchObject({ id: 2, title: 'Unassigned bug', assignedTo: 'Unassigned', storyPoints: null });
  });

  test('returns an empty array without calling the API when given no ids', async () => {
    const client = new AzureDevOpsClient(config);
    const items = await client.getWorkItemDetails([]);
    expect(items).toEqual([]);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test('batches requests in groups of 200 ids', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const calls: string[] = [];
    routeFetch([
      {
        test: /_apis\/wit\/workitems\?ids=/,
        handler: (url: string) => {
          calls.push(url);
          const idsParam = new URL(url).searchParams.get('ids')!;
          const batchIds = idsParam.split(',').map(Number);
          return { value: batchIds.map((id) => ({ id, fields: { 'System.Title': `Item ${id}` } })) };
        },
      },
    ]);
    const client = new AzureDevOpsClient(config);

    const items = await client.getWorkItemDetails(ids);
    expect(calls).toHaveLength(2);
    expect(items).toHaveLength(250);
  });
});

describe('AzureDevOpsClient — getSprintWorkItems', () => {
  test('returns [] when the iteration has no work item relations', async () => {
    routeFetch([
      { test: /iterations\/iter-1\/workitems/, handler: () => ({ workItemRelations: [] }) },
    ]);
    const client = new AzureDevOpsClient(config);

    const items = await client.getSprintWorkItems('iter-1');
    expect(items).toEqual([]);
  });

  test('resolves work item ids from the iteration then fetches their details', async () => {
    routeFetch([
      { test: /iterations\/iter-1\/workitems/, handler: () => ({ workItemRelations: [{ target: { id: 1 } }, { target: { id: 2 } }] }) },
      {
        test: /_apis\/wit\/workitems\?ids=1,2/,
        handler: () => ({
          value: [
            { id: 1, fields: { 'System.Title': 'A', 'System.WorkItemType': 'User Story' } },
            { id: 2, fields: { 'System.Title': 'B', 'System.WorkItemType': 'Bug' } },
          ],
        }),
      },
    ]);
    const client = new AzureDevOpsClient(config);

    const items = await client.getSprintWorkItems('iter-1');
    expect(items.map((i) => i.id)).toEqual([1, 2]);
  });
});

describe('AzureDevOpsClient — getTeamCapacity', () => {
  test('maps capacity entries, defaulting unknown team members', async () => {
    routeFetch([
      {
        test: /iterations\/iter-1\/capacities/,
        handler: () => ({
          value: [
            { teamMember: { displayName: 'Bob' }, activities: [{ name: 'Development', capacityPerDay: 6 }], daysOff: [] },
            { activities: [], daysOff: [{ start: '2026-07-07', end: '2026-07-08' }] },
          ],
        }),
      },
    ]);
    const client = new AzureDevOpsClient(config);

    const capacity = await client.getTeamCapacity('iter-1');
    expect(capacity[0]).toMatchObject({ teamMember: 'Bob' });
    expect(capacity[1]).toMatchObject({ teamMember: 'Unknown' });
    expect(capacity[1].daysOff).toHaveLength(1);
  });
});

describe('AzureDevOpsClient — checkWorkItemExists', () => {
  test('returns exists:true with mapped fields when the work item is found', async () => {
    routeFetch([
      {
        test: /_apis\/wit\/workitems\/42\?api-version/,
        handler: () => ({
          id: 42,
          fields: {
            'System.Title': 'Fix crash',
            'System.State': 'Active',
            'System.WorkItemType': 'Bug',
            'System.AssignedTo': { displayName: 'Carol' },
          },
        }),
      },
    ]);
    const client = new AzureDevOpsClient(config);

    const result = await client.checkWorkItemExists(42);
    expect(result).toMatchObject({ exists: true, id: 42, title: 'Fix crash', assignedTo: 'Carol' });
  });

  test('returns exists:false when the API responds 404', async () => {
    routeFetch([
      { test: /_apis\/wit\/workitems\/999/, handler: () => errorResponse(404, 'TF401232: Work item does not exist') },
    ]);
    const client = new AzureDevOpsClient(config);

    await expect(client.checkWorkItemExists(999)).resolves.toEqual({ exists: false });
  });

  test('re-throws non-404 errors', async () => {
    routeFetch([
      { test: /_apis\/wit\/workitems\/500/, handler: () => errorResponse(500, 'Internal Server Error') },
    ]);
    const client = new AzureDevOpsClient(config);

    await expect(client.checkWorkItemExists(500)).rejects.toThrow('Azure DevOps API error (500)');
  });
});

describe('AzureDevOpsClient — createWorkItem', () => {
  test('builds a JSON-patch document with only the provided optional fields', async () => {
    let capturedBody: any;
    mockedFetch.mockImplementation(async (url: string, init?: any) => {
      capturedBody = init?.body ? JSON.parse(init.body) : undefined;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 101, fields: { 'System.Title': 'New Story' } }),
        text: async () => '',
      };
    });
    const client = new AzureDevOpsClient(config);

    const result = await client.createWorkItem('User Story', 'New Story', { storyPoints: 3, assignedTo: 'Dave' });

    expect(result).toEqual({
      id: 101,
      title: 'New Story',
      url: 'https://dev.azure.com/test-org/TestProject/_workitems/edit/101',
    });
    expect(capturedBody).toContainEqual({ op: 'add', path: '/fields/System.Title', value: 'New Story' });
    expect(capturedBody).toContainEqual({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: 3 });
    expect(capturedBody).toContainEqual({ op: 'add', path: '/fields/System.AssignedTo', value: 'Dave' });
    expect(capturedBody.find((p: any) => p.path === '/fields/System.Description')).toBeUndefined();
  });

  test('throws when the API rejects the creation', async () => {
    mockedFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'TF401320: invalid field',
    });
    const client = new AzureDevOpsClient(config);

    await expect(client.createWorkItem('Bug', 'Bad request')).rejects.toThrow('Failed to create work item (400)');
  });
});

describe('AzureDevOpsClient — queryWorkItems', () => {
  test('runs a WIQL search and hydrates the matching work items', async () => {
    routeFetch([
      { test: /_apis\/wit\/wiql\?api-version/, handler: () => ({ workItems: [{ id: 7 }] }) },
      { test: /_apis\/wit\/workitems\?ids=7/, handler: () => ({ value: [{ id: 7, fields: { 'System.Title': 'Payment bug' } }] }) },
    ]);
    const client = new AzureDevOpsClient(config);

    const results = await client.queryWorkItems('payment');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Payment bug');
  });

  test('returns [] when WIQL finds no matches', async () => {
    routeFetch([{ test: /_apis\/wit\/wiql/, handler: () => ({ workItems: [] }) }]);
    const client = new AzureDevOpsClient(config);

    await expect(client.queryWorkItems('nonexistent')).resolves.toEqual([]);
  });
});

describe('AzureDevOpsClient — getCarryoverStories', () => {
  test('flags stories that have appeared under more than one iteration path', async () => {
    routeFetch([
      { test: /teamsettings\/iterations\?api-version/, handler: () => ({ value: [{ id: 'iter-1', name: 'Sprint 14', path: 'P\\T\\Sprint 14', attributes: {} }] }) },
      { test: /teamsettings\/iterations\?\$timeframe=current/, handler: () => ({ value: [{ id: 'iter-1', name: 'Sprint 14', path: 'P\\T\\Sprint 14', attributes: {} }] }) },
      { test: /iterations\/iter-1\/workitems/, handler: () => ({ workItemRelations: [{ target: { id: 1 } }, { target: { id: 2 } }] }) },
      {
        test: /_apis\/wit\/workitems\?ids=1,2/,
        handler: () => ({
          value: [
            { id: 1, fields: { 'System.Title': 'Carried over', 'System.WorkItemType': 'User Story' } },
            { id: 2, fields: { 'System.Title': 'Fresh story', 'System.WorkItemType': 'User Story' } },
          ],
        }),
      },
      {
        test: /workitems\/1\/updates/,
        handler: () => ({
          value: [
            { fields: { 'System.IterationPath': { newValue: 'P\\T\\Sprint 13' } }, revisedDate: '2026-06-20' },
            { fields: { 'System.IterationPath': { newValue: 'P\\T\\Sprint 14' } }, revisedDate: '2026-07-06' },
          ],
        }),
      },
      { test: /workitems\/2\/updates/, handler: () => ({ value: [{ fields: { 'System.IterationPath': { newValue: 'P\\T\\Sprint 14' } }, revisedDate: '2026-07-06' } ] }) },
    ]);
    const client = new AzureDevOpsClient(config);

    const carryovers = await client.getCarryoverStories('P\\T\\Sprint 14');
    expect(carryovers).toEqual([{ workItemId: 1, sprintCount: 2, sprints: ['P\\T\\Sprint 13', 'P\\T\\Sprint 14'] }]);
  });
});

describe('AzureDevOpsClient — getSprintBurndown', () => {
  test('computes scope/completed/remaining/ideal for a 5-working-day sprint', async () => {
    routeFetch([
      {
        test: /teamsettings\/iterations\?\$timeframe=current/,
        handler: () => ({
          value: [{ id: 'iter-1', name: 'Sprint 14', path: 'P\\T\\Sprint 14', attributes: { startDate: '2026-07-06T00:00:00Z', finishDate: '2026-07-10T00:00:00Z' } }],
        }),
      },
      { test: /iterations\/iter-1\/workitems/, handler: () => ({ workItemRelations: [{ target: { id: 1 } }, { target: { id: 2 } }] }) },
      {
        test: /_apis\/wit\/workitems\?ids=1,2/,
        handler: () => ({
          value: [
            {
              id: 1,
              fields: {
                'System.Title': 'Story A', 'System.WorkItemType': 'User Story', 'System.State': 'Done',
                'Microsoft.VSTS.Scheduling.StoryPoints': 5,
                'System.CreatedDate': '2026-07-01T00:00:00Z', 'System.ChangedDate': '2026-07-08T00:00:00Z',
              },
            },
            {
              id: 2,
              fields: {
                'System.Title': 'Story B', 'System.WorkItemType': 'User Story', 'System.State': 'New',
                'Microsoft.VSTS.Scheduling.StoryPoints': 3,
                'System.CreatedDate': '2026-07-06T00:00:00Z', 'System.ChangedDate': '2026-07-06T00:00:00Z',
              },
            },
          ],
        }),
      },
      {
        test: /workitems\/1\/updates/,
        handler: () => ({ value: [{ fields: { 'System.State': { newValue: 'Done' } }, revisedDate: '2026-07-08T00:00:00Z' }] }),
      },
      { test: /workitems\/2\/updates/, handler: () => ({ value: [] }) },
    ]);
    const client = new AzureDevOpsClient(config);

    const burndown = await client.getSprintBurndown(undefined, '2026-07-10');

    expect(burndown.totalDays).toBe(5);
    expect(burndown.totalScope).toBe(8);
    expect(burndown.currentRemaining).toBe(3);
    expect(burndown.completedScope).toBe(5);
    expect(burndown.points).toHaveLength(5);
    expect(burndown.points[0]).toMatchObject({ scope: 8, completed: 0, remaining: 8, idealRemaining: 8 });
    expect(burndown.points[2]).toMatchObject({ scope: 8, completed: 5, remaining: 3, idealRemaining: 4 });
    expect(burndown.points[4]).toMatchObject({ scope: 8, completed: 5, remaining: 3, idealRemaining: 0, isQueryDate: true });
  });

  test('throws when the requested iteration has no matching sprint', async () => {
    routeFetch([{ test: /teamsettings\/iterations\?api-version/, handler: () => ({ value: [] }) }]);
    const client = new AzureDevOpsClient(config);

    await expect(client.getSprintBurndown('missing-iter')).rejects.toThrow('Sprint iteration not found');
  });
});

describe('AzureDevOpsClient — getPipelineRuns / getPipelineHealth', () => {
  function buildRuns() {
    return {
      value: [
        { id: 5, definition: { name: 'CI' }, status: 'completed', result: 'succeeded', startTime: '2026-07-10T00:00:00Z', finishTime: '2026-07-10T00:10:00Z', sourceBranch: 'refs/heads/main' },
        { id: 4, definition: { name: 'CI' }, status: 'completed', result: 'succeeded', startTime: '2026-07-09T00:00:00Z', finishTime: '2026-07-09T00:08:00Z', sourceBranch: 'refs/heads/main' },
        { id: 3, definition: { name: 'CI' }, status: 'completed', result: 'failed', startTime: '2026-07-08T00:00:00Z', finishTime: '2026-07-08T00:05:00Z', sourceBranch: 'refs/heads/main' },
        { id: 2, definition: { name: 'CI' }, status: 'completed', result: 'failed', startTime: '2026-07-07T00:00:00Z', finishTime: '2026-07-07T00:05:00Z', sourceBranch: 'refs/heads/main' },
        { id: 1, definition: { name: 'CI' }, status: 'completed', result: 'succeeded', startTime: '2026-07-06T00:00:00Z', finishTime: '2026-07-06T00:10:00Z', sourceBranch: 'refs/heads/main' },
      ],
    };
  }

  test('getPipelineRuns maps raw build data', async () => {
    routeFetch([{ test: /_apis\/build\/builds\?definitions=9/, handler: () => buildRuns() }]);
    const client = new AzureDevOpsClient(config);

    const runs = await client.getPipelineRuns(9, 10);
    expect(runs).toHaveLength(5);
    expect(runs[0]).toMatchObject({ id: 5, name: 'CI', result: 'succeeded' });
  });

  test('getPipelineHealth computes success rate, streak, and average duration', async () => {
    routeFetch([{ test: /_apis\/build\/builds\?definitions=9/, handler: () => buildRuns() }]);
    const client = new AzureDevOpsClient(config);

    const health = await client.getPipelineHealth(9);
    expect(health.totalRuns).toBe(5);
    expect(health.succeeded).toBe(3);
    expect(health.failed).toBe(2);
    expect(health.successRate).toBe(60);
    // Most recent run (id 5) succeeded, followed by another success (id 4), then failures -> streak of 2.
    expect(health.currentStreak).toMatchObject({ result: 'succeeded', count: 2 });
    expect(health.averageDurationMinutes).toBeCloseTo(7.6, 1);
  });
});

describe('AzureDevOpsClient — getBugTrendData', () => {
  test('groups bugs by iteration release label and buckets active/resolved counts', async () => {
    routeFetch([
      { test: /_apis\/wit\/queries\//, handler: () => ({ name: 'All Bugs' }) },
      { test: /_apis\/wit\/wiql\//, handler: () => ({ workItems: [{ id: 1 }, { id: 2 }, { id: 3 }] }) },
      {
        test: /_apis\/wit\/workitems\?ids=1,2,3/,
        handler: () => ({
          value: [
            { id: 1, fields: { 'System.State': 'Active', 'System.IterationPath': 'P\\T\\Sprint 14' } },
            { id: 2, fields: { 'System.State': 'Closed', 'System.IterationPath': 'P\\T\\Sprint 14' } },
            { id: 3, fields: { 'System.State': 'New', 'System.IterationPath': 'P\\T\\Sprint 15' } },
          ],
        }),
      },
    ]);
    const client = new AzureDevOpsClient(config);

    const trend = await client.getBugTrendData('some-query-id');
    expect(trend.totalBugs).toBe(3);
    expect(trend.queryName).toBe('All Bugs');
    expect(trend.points).toEqual([
      { release: 'Sprint 14', iterationPath: 'P\\T\\Sprint 14', total: 2, active: 1, resolved: 1 },
      { release: 'Sprint 15', iterationPath: 'P\\T\\Sprint 15', total: 1, active: 1, resolved: 0 },
    ]);
  });

  test('returns an empty result set when the query has no matches', async () => {
    routeFetch([
      { test: /_apis\/wit\/queries\//, handler: () => ({ name: 'Empty Query' }) },
      { test: /_apis\/wit\/wiql\//, handler: () => ({ workItems: [] }) },
    ]);
    const client = new AzureDevOpsClient(config);

    const trend = await client.getBugTrendData('empty-query-id');
    expect(trend).toMatchObject({ totalBugs: 0, points: [] });
  });
});

describe('AzureDevOpsClient — getDeliveryAnalysis', () => {
  test('returns a "No children" timeline when the parent has no child links', async () => {
    routeFetch([
      {
        test: /_apis\/wit\/workitems\/500\?\$expand=relations/,
        handler: () => ({
          id: 500,
          fields: {
            'System.Title': 'Epic with no children',
            'System.WorkItemType': 'Epic',
            'System.State': 'New',
          },
        }),
      },
    ]);
    const client = new AzureDevOpsClient(config);

    const analysis = await client.getDeliveryAnalysis(500);
    expect(analysis.children).toEqual([]);
    expect(analysis.timeline.status).toBe('No children');
    expect(analysis.progress).toEqual({ total: 0, done: 0, inProgress: 0, notStarted: 0, removed: 0, percentComplete: 0 });
  });

  test('classifies children, computes progress/story points, blockers, and team contribution', async () => {
    routeFetch([
      {
        test: /_apis\/wit\/workitems\/600\?\$expand=relations/,
        handler: () => ({
          id: 600,
          fields: {
            'System.Title': 'Feature X',
            'System.WorkItemType': 'Feature',
            'System.State': 'Active',
            'System.AssignedTo': { displayName: 'PO' },
          },
          relations: [
            { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/test-org/_apis/wit/workItems/1' },
            { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/test-org/_apis/wit/workItems/2' },
            { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/test-org/_apis/wit/workItems/3' },
            { rel: 'AttachedFile', url: 'https://dev.azure.com/test-org/_apis/wit/attachments/abc' },
          ],
        }),
      },
      {
        test: /_apis\/wit\/workitems\?ids=1,2,3/,
        handler: () => ({
          value: [
            {
              id: 1,
              fields: {
                'System.Title': 'Done child', 'System.WorkItemType': 'User Story', 'System.State': 'Done',
                'System.AssignedTo': { displayName: 'Alice' }, 'Microsoft.VSTS.Scheduling.StoryPoints': 5,
              },
            },
            {
              id: 2,
              fields: {
                'System.Title': 'Blocked child', 'System.WorkItemType': 'User Story', 'System.State': 'Active',
                'System.AssignedTo': { displayName: 'Bob' }, 'Microsoft.VSTS.Scheduling.StoryPoints': 3,
                'System.Tags': 'Blocked; Frontend',
              },
            },
            {
              id: 3,
              fields: {
                'System.Title': 'Removed child', 'System.WorkItemType': 'User Story', 'System.State': 'Removed',
                'System.AssignedTo': { displayName: 'Carol' }, 'Microsoft.VSTS.Scheduling.StoryPoints': 2,
              },
            },
          ],
        }),
      },
    ]);
    const client = new AzureDevOpsClient(config);

    const analysis = await client.getDeliveryAnalysis(600);

    // Removed items are excluded from "active" progress totals.
    expect(analysis.progress).toMatchObject({ total: 2, done: 1, inProgress: 1, notStarted: 0, removed: 1, percentComplete: 50 });
    expect(analysis.storyPoints).toMatchObject({ total: 8, completed: 5, remaining: 3, unestimated: 0 });
    expect(analysis.blockers.some((b) => b.id === 2 && b.reason === 'Tagged as Blocked')).toBe(true);
    expect(analysis.teamContribution).toEqual([
      { name: 'Alice', totalItems: 1, completed: 1, inProgress: 0, storyPointsDelivered: 5 },
      { name: 'Bob', totalItems: 1, completed: 0, inProgress: 1, storyPointsDelivered: 0 },
    ]);
  });
});
