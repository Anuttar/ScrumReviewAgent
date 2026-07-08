import fetch from 'node-fetch';
import { PDFParse } from 'pdf-parse';

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

export interface RetrospectiveBoard {
  id: string;
  title: string;
  teamId: string;
  createdDate: string;
  columns: { id: string; title: string }[];
  rawData?: any;
}

export interface RetrospectiveFeedbackItem {
  id: string;
  boardId: string;
  title: string;
  columnId: string;
  createdBy: string;
  createdDate: string;
  upvotes: number;
  isGroupedCarryOver: boolean;
  childItems: number;
  actionItems: string[];
}

export interface RetrospectiveAnalysis {
  board: { id: string; title: string; createdDate: string };
  columns: string[];
  totalItems: number;
  categorizedItems: Record<string, RetrospectiveFeedbackItem[]>;
  wentWell: RetrospectiveFeedbackItem[];
  didntGoWell: RetrospectiveFeedbackItem[];
  actionItems: RetrospectiveFeedbackItem[];
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

  private get extMgmtUrl(): string {
    // Azure DevOps Services uses extmgmt.dev.azure.com for extension management APIs
    const orgUrl = this.config.orgUrl;
    if (orgUrl.includes('dev.azure.com')) {
      return orgUrl.replace('dev.azure.com', 'extmgmt.dev.azure.com');
    }
    // On-premises Azure DevOps Server uses the same base URL
    return orgUrl;
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

  async getTeamId(): Promise<string> {
    // Resolve team name to team ID (GUID) using the Teams API
    const url = `${this.config.orgUrl}/_apis/projects/${this.config.project}/teams/${encodeURIComponent(this.config.team)}?api-version=7.0`;
    const result = await this.request<{ id: string; name: string }>(url);
    return result.id;
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

  async addWorkItemLink(
    sourceId: number,
    targetId: number,
    linkType: string = 'System.LinkTypes.Related',
    comment?: string
  ): Promise<{ id: number; title: string }> {
    const targetUrl = `${this.projectUrl}/_apis/wit/workitems/${targetId}`;
    const patchDocument: any[] = [
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: linkType,
          url: targetUrl,
          attributes: {
            comment: comment || '',
          },
        },
      },
    ];

    const url = `${this.projectUrl}/_apis/wit/workitems/${sourceId}?api-version=7.0`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json-patch+json',
      },
      body: JSON.stringify(patchDocument),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to add link (${response.status}): ${errorText}`);
    }

    const result = await response.json() as any;
    return {
      id: result.id,
      title: result.fields?.['System.Title'] || '',
    };
  }

  async createWorkItem(
    workItemType: string,
    title: string,
    options?: {
      description?: string;
      assignedTo?: string;
      iterationPath?: string;
      areaPath?: string;
      state?: string;
      storyPoints?: number;
      tags?: string;
      parentId?: number;
    }
  ): Promise<{ id: number; title: string; url: string }> {
    const patchDocument: any[] = [
      { op: 'add', path: '/fields/System.Title', value: title },
    ];

    if (options?.description) {
      patchDocument.push({ op: 'add', path: '/fields/System.Description', value: options.description });
    }
    if (options?.assignedTo) {
      patchDocument.push({ op: 'add', path: '/fields/System.AssignedTo', value: options.assignedTo });
    }
    if (options?.iterationPath) {
      patchDocument.push({ op: 'add', path: '/fields/System.IterationPath', value: options.iterationPath });
    }
    if (options?.areaPath) {
      patchDocument.push({ op: 'add', path: '/fields/System.AreaPath', value: options.areaPath });
    }
    if (options?.state) {
      patchDocument.push({ op: 'add', path: '/fields/System.State', value: options.state });
    }
    if (options?.storyPoints !== undefined) {
      patchDocument.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: options.storyPoints });
    }
    if (options?.tags) {
      patchDocument.push({ op: 'add', path: '/fields/System.Tags', value: options.tags });
    }
    if (options?.parentId) {
      patchDocument.push({
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: `${this.projectUrl}/_apis/wit/workitems/${options.parentId}`,
        },
      });
    }

    const encodedType = encodeURIComponent(workItemType);
    const url = `${this.projectUrl}/_apis/wit/workitems/$${encodedType}?api-version=7.0`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json-patch+json',
      },
      body: JSON.stringify(patchDocument),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create work item (${response.status}): ${errorText}`);
    }

    const result = await response.json() as any;
    const orgUrl = this.config.orgUrl;
    const project = this.config.project;
    const workItemUrl = `${orgUrl}/${project}/_workitems/edit/${result.id}`;

    return {
      id: result.id,
      title: result.fields?.['System.Title'] || title,
      url: workItemUrl,
    };
  }

  async getWorkItemAttachments(
    workItemId: number
  ): Promise<{ id: string; name: string; url: string; size: number; createdDate: string }[]> {
    const url = `${this.projectUrl}/_apis/wit/workitems/${workItemId}?$expand=relations&api-version=7.0`;
    const response = await this.request<any>(url);

    const relations = response.relations || [];
    return relations
      .filter((r: any) => r.rel === 'AttachedFile')
      .map((r: any) => {
        const urlParts = r.url.split('/');
        const attachmentId = urlParts[urlParts.length - 1].split('?')[0];
        return {
          id: attachmentId,
          name: r.attributes?.name || 'unknown',
          url: r.url,
          size: r.attributes?.resourceSize || 0,
          createdDate: r.attributes?.resourceCreatedDate || '',
        };
      });
  }

  async getAttachmentContent(attachmentId: string, fileName?: string): Promise<{ content: string; isText: boolean }> {
    const url = `${this.config.orgUrl}/${this.config.project}/_apis/wit/attachments/${attachmentId}?api-version=7.0`;
    const response = await fetch(url, {
      headers: this.headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch attachment (${response.status}): ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const ext = fileName ? fileName.split('.').pop()?.toLowerCase() : '';
    const textExtensions = [
      'txt', 'csv', 'json', 'xml', 'html', 'htm', 'js', 'ts', 'py', 'java',
      'cs', 'css', 'scss', 'less', 'md', 'yaml', 'yml', 'toml', 'ini', 'cfg',
      'conf', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'sql', 'log', 'env',
      'jsx', 'tsx', 'vue', 'svelte', 'rb', 'php', 'go', 'rs', 'kt', 'swift',
      'c', 'cpp', 'h', 'hpp', 'r', 'scala', 'groovy', 'pl', 'pm',
    ];
    const isTextByExtension = ext ? textExtensions.includes(ext) : false;
    const isTextByContentType = contentType.includes('text') ||
      contentType.includes('json') ||
      contentType.includes('xml') ||
      contentType.includes('csv') ||
      contentType.includes('html') ||
      contentType.includes('javascript') ||
      contentType.includes('yaml') ||
      contentType.includes('markdown');
    const isText = isTextByContentType || isTextByExtension;
    const isPdf = ext === 'pdf' || contentType.includes('pdf');

    if (isPdf) {
      const buffer = await response.buffer();
      try {
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        const textResult = await parser.getText();
        await parser.destroy();
        return {
          content: textResult.text,
          isText: true,
        };
      } catch (e: any) {
        return {
          content: `[PDF file, ${buffer.length} bytes — failed to extract text: ${e.message}]`,
          isText: false,
        };
      }
    } else if (isText) {
      const text = await response.text();
      return { content: text, isText: true };
    } else {
      const buffer = await response.buffer();
      return {
        content: `[Binary file, ${buffer.length} bytes, Content-Type: ${contentType}]`,
        isText: false,
      };
    }
  }

  async getWorkItemChildren(workItemId: number): Promise<WorkItem[]> {
    const url = `${this.projectUrl}/_apis/wit/workitems/${workItemId}?$expand=relations&api-version=7.0`;
    const response = await this.request<any>(url);

    const relations = response.relations || [];
    const childIds = relations
      .filter((r: any) => r.rel === 'System.LinkTypes.Hierarchy-Forward')
      .map((r: any) => {
        const parts = r.url.split('/');
        return parseInt(parts[parts.length - 1], 10);
      })
      .filter((id: number) => !isNaN(id));

    if (childIds.length === 0) return [];
    return this.getWorkItemDetails(childIds);
  }

  async getWorkItemComments(workItemId: number): Promise<{ id: number; text: string; createdBy: string; createdDate: string }[]> {
    const url = `${this.projectUrl}/_apis/wit/workitems/${workItemId}/comments?api-version=7.0-preview.4`;
    const result = await this.request<{ comments: any[] }>(url);

    return (result.comments || []).map((c: any) => ({
      id: c.id,
      text: c.text || '',
      createdBy: c.createdBy?.displayName || 'Unknown',
      createdDate: c.createdDate || '',
    }));
  }

  async addWorkItemComment(workItemId: number, text: string): Promise<{ id: number; text: string; createdBy: string; createdDate: string }> {
    const url = `${this.projectUrl}/_apis/wit/workitems/${workItemId}/comments?api-version=7.0-preview.4`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Azure DevOps API error (${response.status}): ${errorBody}`);
    }

    const result = (await response.json()) as any;
    return {
      id: result.id,
      text: result.text || '',
      createdBy: result.createdBy?.displayName || 'Unknown',
      createdDate: result.createdDate || '',
    };
  }

  async updateWorkItemComment(workItemId: number, commentId: number, text: string): Promise<{ id: number; text: string; modifiedBy: string; modifiedDate: string }> {
    const url = `${this.projectUrl}/_apis/wit/workitems/${workItemId}/comments/${commentId}?api-version=7.0-preview.4`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Azure DevOps API error (${response.status}): ${errorBody}`);
    }

    const result = (await response.json()) as any;
    return {
      id: result.id,
      text: result.text || '',
      modifiedBy: result.modifiedBy?.displayName || 'Unknown',
      modifiedDate: result.modifiedDate || '',
    };
  }

  async deleteWorkItemComment(workItemId: number, commentId: number): Promise<void> {
    const url = `${this.projectUrl}/_apis/wit/workitems/${workItemId}/comments/${commentId}?api-version=7.0-preview.4`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.headers,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Azure DevOps API error (${response.status}): ${errorBody}`);
    }
  }

  async getPipelines(): Promise<{ id: number; name: string; folder: string; url: string }[]> {
    const url = `${this.projectUrl}/_apis/pipelines?api-version=7.0`;
    const result = await this.request<{ value: any[] }>(url);

    return (result.value || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      folder: p.folder || '\\',
      url: `${this.config.orgUrl}/${this.config.project}/_build?definitionId=${p.id}`,
    }));
  }

  async getPipelineRuns(
    pipelineId: number,
    top: number = 10
  ): Promise<{ id: number; name: string; state: string; result: string; startTime: string; finishTime: string; sourceBranch: string; url: string }[]> {
    const url = `${this.projectUrl}/_apis/build/builds?definitions=${pipelineId}&$top=${top}&api-version=7.0`;
    const result = await this.request<{ value: any[] }>(url);

    return (result.value || []).map((r: any) => ({
      id: r.id,
      name: r.definition?.name || '',
      state: r.status || '',
      result: r.result || 'inProgress',
      startTime: r.startTime || '',
      finishTime: r.finishTime || '',
      sourceBranch: r.sourceBranch || '',
      url: r._links?.web?.href || `${this.config.orgUrl}/${this.config.project}/_build/results?buildId=${r.id}`,
    }));
  }

  async getPipelineHealth(pipelineId: number): Promise<{
    pipelineName: string;
    totalRuns: number;
    succeeded: number;
    failed: number;
    canceled: number;
    partiallySucceeded: number;
    successRate: number;
    currentStreak: { result: string; count: number; since: string };
    lastSuccessful: string | null;
    lastFailed: string | null;
    averageDurationMinutes: number;
    recentRuns: { id: number; result: string; startTime: string; finishTime: string; sourceBranch: string }[];
  }> {
    const runs = await this.getPipelineRuns(pipelineId, 25);

    const pipelineName = runs.length > 0 ? runs[0].name : `Pipeline ${pipelineId}`;
    const completedRuns = runs.filter(r => r.state === 'completed');

    const succeeded = completedRuns.filter(r => r.result === 'succeeded').length;
    const failed = completedRuns.filter(r => r.result === 'failed').length;
    const canceled = completedRuns.filter(r => r.result === 'canceled').length;
    const partiallySucceeded = completedRuns.filter(r => r.result === 'partiallySucceeded').length;
    const totalRuns = completedRuns.length;
    const successRate = totalRuns > 0 ? Math.round((succeeded / totalRuns) * 100) : 0;

    // Calculate current streak
    let streakResult = completedRuns.length > 0 ? completedRuns[0].result : 'none';
    let streakCount = 0;
    let streakSince = '';
    for (const run of completedRuns) {
      if (run.result === streakResult) {
        streakCount++;
        streakSince = run.startTime;
      } else {
        break;
      }
    }

    // Last successful and last failed
    const lastSuccessfulRun = completedRuns.find(r => r.result === 'succeeded');
    const lastFailedRun = completedRuns.find(r => r.result === 'failed');

    // Average duration
    let totalDuration = 0;
    let durationCount = 0;
    for (const run of completedRuns) {
      if (run.startTime && run.finishTime) {
        const duration = new Date(run.finishTime).getTime() - new Date(run.startTime).getTime();
        if (duration > 0) {
          totalDuration += duration;
          durationCount++;
        }
      }
    }
    const averageDurationMinutes = durationCount > 0 ? Math.round(totalDuration / durationCount / 60000 * 10) / 10 : 0;

    return {
      pipelineName,
      totalRuns,
      succeeded,
      failed,
      canceled,
      partiallySucceeded,
      successRate,
      currentStreak: { result: streakResult, count: streakCount, since: streakSince },
      lastSuccessful: lastSuccessfulRun?.finishTime || null,
      lastFailed: lastFailedRun?.finishTime || null,
      averageDurationMinutes,
      recentRuns: completedRuns.slice(0, 10).map(r => ({
        id: r.id,
        result: r.result,
        startTime: r.startTime,
        finishTime: r.finishTime,
        sourceBranch: r.sourceBranch,
      })),
    };
  }

  async getWorkItemFields(workItemId: number): Promise<{ name: string; referenceName: string; value: any }[]> {
    const url = `${this.projectUrl}/_apis/wit/workitems/${workItemId}?$expand=all&api-version=7.0`;
    const result = await this.request<any>(url);

    const fields = result.fields || {};
    return Object.entries(fields).map(([referenceName, value]) => {
      const name = referenceName.split('.').pop() || referenceName;
      return { name, referenceName, value };
    });
  }

  async checkWorkItemExists(workItemId: number): Promise<{
    exists: boolean;
    id?: number;
    title?: string;
    state?: string;
    workItemType?: string;
    assignedTo?: string;
    createdDate?: string;
    changedDate?: string;
    areaPath?: string;
    iterationPath?: string;
    url?: string;
  }> {
    try {
      const url = `${this.projectUrl}/_apis/wit/workitems/${workItemId}?api-version=7.0`;
      const result = await this.request<any>(url);

      const fields = result.fields || {};
      return {
        exists: true,
        id: result.id,
        title: fields['System.Title'] || '',
        state: fields['System.State'] || '',
        workItemType: fields['System.WorkItemType'] || '',
        assignedTo: fields['System.AssignedTo']?.displayName || 'Unassigned',
        createdDate: fields['System.CreatedDate'] || '',
        changedDate: fields['System.ChangedDate'] || '',
        areaPath: fields['System.AreaPath'] || '',
        iterationPath: fields['System.IterationPath'] || '',
        url: `${this.config.orgUrl}/${this.config.project}/_workitems/edit/${result.id}`,
      };
    } catch (error: any) {
      if (error.message?.includes('404') || error.message?.includes('does not exist')) {
        return { exists: false };
      }
      throw error;
    }
  }

  // ─── Retrospective Board Methods ───────────────────────────────────────────

  async getRetrospectiveBoards(teamId?: string): Promise<RetrospectiveBoard[]> {
    // The Retrospectives extension uses the Team ID (GUID) as the collection name for boards
    const extPublisher = 'ms-devlabs';
    const extId = 'team-retrospectives';

    // Resolve team GUID if not provided
    const resolvedTeamId = teamId || await this.getTeamId();

    const url = `${this.extMgmtUrl}/_apis/ExtensionManagement/InstalledExtensions/${extPublisher}/${extId}/Data/Scopes/Default/Current/Collections/${resolvedTeamId}/Documents?api-version=7.0-preview.1`;

    try {
      const result = await this.request<any>(url);

      // Handle both response formats: { value: [...] } or direct array
      const documents: any[] = Array.isArray(result) ? result : (result.value || []);

      return documents.map((board: any) => ({
        id: board.id || board.__etag,
        title: board.title || 'Untitled Board',
        teamId: board.teamId || resolvedTeamId,
        createdDate: board.createdDate || '',
        columns: (board.columns || []).map((col: any) => ({
          id: col.id,
          title: col.title,
        })),
        rawData: board,
      }));
    } catch (error: any) {
      throw new Error(
        `Unable to fetch retrospective boards for team "${this.config.team}" (ID: ${resolvedTeamId}). ` +
        `Ensure the "Retrospectives" extension (ms-devlabs.team-retrospectives) is installed ` +
        `and at least one retro board exists. Error: ${error.message}`
      );
    }
  }

  async getRetrospectiveBoardItems(boardId: string): Promise<RetrospectiveFeedbackItem[]> {
    // The Retrospectives extension uses the Board ID (GUID) as the collection name for feedback items
    const extPublisher = 'ms-devlabs';
    const extId = 'team-retrospectives';

    const url = `${this.extMgmtUrl}/_apis/ExtensionManagement/InstalledExtensions/${extPublisher}/${extId}/Data/Scopes/Default/Current/Collections/${boardId}/Documents?api-version=7.0-preview.1`;

    try {
      const result = await this.request<any>(url);

      // Handle both response formats: { value: [...] } or direct array
      const documents: any[] = Array.isArray(result) ? result : (result.value || []);

      return documents.map((item: any) => ({
        id: item.id || '',
        boardId: item.boardId || boardId,
        title: item.title || item.feedbackText || '',
        columnId: item.columnId || '',
        createdBy: item.createdBy?.displayName || item.createdByProfileImage || 'Unknown',
        createdDate: item.createdDate || '',
        upvotes: item.upvotes || item.upVoteCount || 0,
        isGroupedCarryOver: item.isGroupedCarryOver || false,
        childItems: (item.childFeedbackItemIds || []).length,
        actionItems: item.associatedActionItemIds || [],
      }));
    } catch (error: any) {
      if (error.message?.includes('DocumentCollectionDoesNotExist')) {
        return []; // Board has no feedback items yet
      }
      throw new Error(`Unable to fetch feedback items for board "${boardId}". Error: ${error.message}`);
    }
  }

  async getRetrospectiveAnalysis(boardId: string): Promise<RetrospectiveAnalysis> {
    const boards = await this.getRetrospectiveBoards();
    const board = boards.find(b => b.id === boardId);

    if (!board) {
      throw new Error(`Retrospective board "${boardId}" not found. Available boards: ${boards.map(b => `${b.title} (${b.id})`).join(', ')}`);
    }

    const items = await this.getRetrospectiveBoardItems(boardId);

    // Map columns by ID
    const columnMap: Record<string, string> = {};
    for (const col of board.columns) {
      columnMap[col.id] = col.title;
    }

    // Categorize items into columns
    const categorizedItems: Record<string, RetrospectiveFeedbackItem[]> = {};
    for (const item of items) {
      const columnTitle = columnMap[item.columnId] || 'Uncategorized';
      if (!categorizedItems[columnTitle]) {
        categorizedItems[columnTitle] = [];
      }
      categorizedItems[columnTitle].push(item);
    }

    // Sort items by upvotes within each category
    for (const col of Object.keys(categorizedItems)) {
      categorizedItems[col].sort((a, b) => b.upvotes - a.upvotes);
    }

    // Identify "What Went Well" and "What Didn't Go Well" columns
    const wellColumnNames = ['what went well', 'went well', 'good', 'keep doing', 'liked', 'positives', 'start'];
    const notWellColumnNames = ['what didn\'t go well', 'didn\'t go well', 'improve', 'stop doing', 'disliked', 'negatives', 'stop', 'issues', 'problems'];

    let wentWell: RetrospectiveFeedbackItem[] = [];
    let didntGoWell: RetrospectiveFeedbackItem[] = [];
    let actionItems: RetrospectiveFeedbackItem[] = [];

    for (const [colTitle, colItems] of Object.entries(categorizedItems)) {
      const lower = colTitle.toLowerCase();
      if (wellColumnNames.some(n => lower.includes(n))) {
        wentWell = [...wentWell, ...colItems];
      } else if (notWellColumnNames.some(n => lower.includes(n))) {
        didntGoWell = [...didntGoWell, ...colItems];
      } else if (lower.includes('action') || lower.includes('todo') || lower.includes('try')) {
        actionItems = [...actionItems, ...colItems];
      }
    }

    return {
      board: {
        id: board.id,
        title: board.title,
        createdDate: board.createdDate,
      },
      columns: board.columns.map(c => c.title),
      totalItems: items.length,
      categorizedItems,
      wentWell,
      didntGoWell,
      actionItems,
    };
  }

  async updateWorkItemFields(
    workItemId: number,
    fields: { referenceName: string; value: any }[]
  ): Promise<{ id: number; title: string; url: string; previousFields: Record<string, any>; actualFields: Record<string, any> }> {
    // Fetch current field values before the update
    const preUrl = `${this.projectUrl}/_apis/wit/workitems/${workItemId}?$expand=all&api-version=7.0`;
    const preResponse = await fetch(preUrl, { method: 'GET', headers: this.headers });
    let previousFields: Record<string, any> = {};
    if (preResponse.ok) {
      const preResult = (await preResponse.json()) as any;
      previousFields = preResult.fields || {};
    }

    const url = `${this.projectUrl}/_apis/wit/workitems/${workItemId}?api-version=7.0`;

    const patchDocument = fields.map((f) => ({
      op: 'add',
      path: `/fields/${f.referenceName}`,
      value: f.value,
    }));

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json-patch+json',
      },
      body: JSON.stringify(patchDocument),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Azure DevOps API error (${response.status}): ${errorBody}`);
    }

    const patchResult = (await response.json()) as any;
    const workItemIdFromPatch = patchResult.id;

    // Do a fresh GET after the PATCH to read the truly persisted values
    // (PATCH response may echo back requested values for locked/read-only fields)
    const postUrl = `${this.projectUrl}/_apis/wit/workitems/${workItemIdFromPatch}?$expand=all&api-version=7.0`;
    const postResponse = await fetch(postUrl, { method: 'GET', headers: this.headers });
    let actualFields: Record<string, any> = {};
    if (postResponse.ok) {
      const postResult = (await postResponse.json()) as any;
      actualFields = postResult.fields || {};
    } else {
      // Fallback to PATCH response if GET fails
      actualFields = patchResult.fields || {};
    }

    return {
      id: workItemIdFromPatch,
      title: actualFields['System.Title'] || patchResult.fields?.['System.Title'] || '',
      url: `${this.config.orgUrl}/${this.config.project}/_workitems/edit/${workItemIdFromPatch}`,
      previousFields,
      actualFields,
    };
  }
}
