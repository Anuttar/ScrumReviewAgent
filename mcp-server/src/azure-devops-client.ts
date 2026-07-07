import fetch from 'node-fetch';

export interface AzureDevOpsConfig {
  orgUrl: string;        // e.g., "https://dev.azure.com/yourorg" or "http://your-server:8080/tfs/collection"
  project: string;
  team: string;
  pat: string;           // Personal Access Token
}

export interface WorkItem {
  id: number;
  title: string;
  state: string;
  assignedTo: string;
  storyPoints: number | null;
  workItemType: string;
  iterationPath: string;
  createdDate: string;
  changedDate: string;
  tags: string;
  boardColumn: string;
}

export interface SprintInfo {
  id: string;
  name: string;
  path: string;
  startDate: string;
  finishDate: string;
  timeFrame: string;
}

export interface TeamMemberCapacity {
  teamMember: string;
  activities: { name: string; capacityPerDay: number }[];
  daysOff: { start: string; end: string }[];
}

export class AzureDevOpsClient {
  private config: AzureDevOpsConfig;
  private headers: Record<string, string>;

  constructor(config: AzureDevOpsConfig) {
    this.config = config;
    const token = Buffer.from(`:${config.pat}`).toString('base64');
    this.headers = {
      'Authorization': `Basic ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private get baseUrl(): string {
    return `${this.config.orgUrl}/${this.config.project}/${this.config.team}`;
  }

  private get projectUrl(): string {
    return `${this.config.orgUrl}/${this.config.project}`;
  }

  private async request<T>(url: string, method: string = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps API error (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  async getCurrentSprint(): Promise<SprintInfo> {
    const url = `${this.baseUrl}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.0`;
    const result = await this.request<{ value: SprintInfo[] }>(url);

    if (!result.value || result.value.length === 0) {
      throw new Error('No current sprint found');
    }

    return result.value[0];
  }

  async getIterations(): Promise<SprintInfo[]> {
    const url = `${this.baseUrl}/_apis/work/teamsettings/iterations?api-version=7.0`;
    const result = await this.request<{ value: SprintInfo[] }>(url);
    return result.value || [];
  }

  async getSprintWorkItems(iterationId: string): Promise<WorkItem[]> {
    // Get work item IDs from the iteration
    const url = `${this.baseUrl}/_apis/work/teamsettings/iterations/${iterationId}/workitems?api-version=7.0`;
    const result = await this.request<{ workItemRelations: { target: { id: number } }[] }>(url);

    if (!result.workItemRelations || result.workItemRelations.length === 0) {
      return [];
    }

    const ids = result.workItemRelations.map(r => r.target.id);
    return this.getWorkItemDetails(ids);
  }

  async getWorkItemDetails(ids: number[]): Promise<WorkItem[]> {
    if (ids.length === 0) return [];

    // Batch in groups of 200 (API limit)
    const batches: number[][] = [];
    for (let i = 0; i < ids.length; i += 200) {
      batches.push(ids.slice(i, i + 200));
    }

    const allItems: WorkItem[] = [];

    for (const batch of batches) {
      const idsParam = batch.join(',');
      const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.AssignedTo',
        'Microsoft.VSTS.Scheduling.StoryPoints',
        'System.WorkItemType',
        'System.IterationPath',
        'System.CreatedDate',
        'System.ChangedDate',
        'System.Tags',
        'System.BoardColumn',
      ].join(',');

      const url = `${this.projectUrl}/_apis/wit/workitems?ids=${idsParam}&fields=${fields}&api-version=7.0`;
      const result = await this.request<{ value: any[] }>(url);

      for (const item of result.value) {
        allItems.push({
          id: item.id,
          title: item.fields['System.Title'] || '',
          state: item.fields['System.State'] || '',
          assignedTo: item.fields['System.AssignedTo']?.displayName || 'Unassigned',
          storyPoints: item.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || null,
          workItemType: item.fields['System.WorkItemType'] || '',
          iterationPath: item.fields['System.IterationPath'] || '',
          createdDate: item.fields['System.CreatedDate'] || '',
          changedDate: item.fields['System.ChangedDate'] || '',
          tags: item.fields['System.Tags'] || '',
          boardColumn: item.fields['System.BoardColumn'] || '',
        });
      }
    }

    return allItems;
  }

  async getTeamCapacity(iterationId: string): Promise<TeamMemberCapacity[]> {
    const url = `${this.baseUrl}/_apis/work/teamsettings/iterations/${iterationId}/capacities?api-version=7.0`;
    const result = await this.request<{ value: any[] }>(url);

    return (result.value || []).map((item: any) => ({
      teamMember: item.teamMember?.displayName || 'Unknown',
      activities: item.activities || [],
      daysOff: item.daysOff || [],
    }));
  }

  async getWorkItemHistory(workItemId: number): Promise<{ iterationPath: string; changedDate: string }[]> {
    const url = `${this.projectUrl}/_apis/wit/workitems/${workItemId}/updates?api-version=7.0`;
    const result = await this.request<{ value: any[] }>(url);

    const iterationChanges: { iterationPath: string; changedDate: string }[] = [];

    for (const update of result.value) {
      if (update.fields?.['System.IterationPath']) {
        iterationChanges.push({
          iterationPath: update.fields['System.IterationPath'].newValue || '',
          changedDate: update.revisedDate || '',
        });
      }
    }

    return iterationChanges;
  }

  async getCarryoverStories(currentIterationPath: string): Promise<{ workItemId: number; sprintCount: number; sprints: string[] }[]> {
    // Query for items in current sprint that have been in previous sprints
    const iterations = await this.getIterations();
    const currentSprint = await this.getCurrentSprint();
    const workItems = await this.getSprintWorkItems(currentSprint.id);

    const carryovers: { workItemId: number; sprintCount: number; sprints: string[] }[] = [];

    for (const item of workItems) {
      if (item.workItemType === 'User Story' || item.workItemType === 'Product Backlog Item') {
        const history = await this.getWorkItemHistory(item.id);
        const uniqueSprints = [...new Set(history.map(h => h.iterationPath))];

        if (uniqueSprints.length > 1) {
          carryovers.push({
            workItemId: item.id,
            sprintCount: uniqueSprints.length,
            sprints: uniqueSprints,
          });
        }
      }
    }

    return carryovers;
  }

  async queryWorkItems(query: string): Promise<WorkItem[]> {
    // Use WIQL to search work items by title/description containing the query text
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.config.project}' AND ([System.Title] CONTAINS '${query}' OR [System.Description] CONTAINS '${query}') ORDER BY [System.ChangedDate] DESC`;

    const url = `${this.projectUrl}/_apis/wit/wiql?api-version=7.0`;
    const result = await this.request<{ workItems: { id: number }[] }>(url, 'POST', { query: wiql });

    if (!result.workItems || result.workItems.length === 0) {
      return [];
    }

    const ids = result.workItems.map(wi => wi.id);
    return this.getWorkItemDetails(ids);
  }
}
