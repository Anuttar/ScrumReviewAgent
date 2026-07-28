import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const PAT_SECRET_KEY = 'sara.azureDevOpsPat';

export function activate(context: vscode.ExtensionContext) {
  const didChangeEmitter = new vscode.EventEmitter<void>();

  // --- Register the bundled Azure DevOps MCP server ---
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider('sara.azuredevopsMcpProvider', {
      onDidChangeMcpServerDefinitions: didChangeEmitter.event,
      provideMcpServerDefinitions: async () => {
        const config = vscode.workspace.getConfiguration('sara');
        const orgUrl = config.get<string>('azureDevOpsOrgUrl', '');
        const project = config.get<string>('azureDevOpsProject', '');
        const team = config.get<string>('azureDevOpsTeam', '');
        const sharepointSiteUrl = config.get<string>('sharepointSiteUrl', '');
        const graphTenantId = config.get<string>('graphTenantId', '');
        const pat = (await context.secrets.get(PAT_SECRET_KEY)) ?? '';

        const serverEntry = context.asAbsolutePath(
          path.join('server', 'mcp-server', 'dist', 'index.js')
        );

        return [
          new vscode.McpStdioServerDefinition(
            'azuredevops',
            'node',
            [serverEntry],
            {
              AZURE_DEVOPS_ORG_URL: orgUrl,
              AZURE_DEVOPS_PROJECT: project,
              AZURE_DEVOPS_TEAM: team,
              AZURE_DEVOPS_PAT: pat,
              SHAREPOINT_SITE_URL: sharepointSiteUrl,
              GRAPH_TENANT_ID: graphTenantId,
            }
          ),
        ];
      },
      resolveMcpServerDefinition: async (server) => {
        const pat = await context.secrets.get(PAT_SECRET_KEY);
        if (!pat) {
          await vscode.commands.executeCommand('sara.configureCredentials');
        }
        return server;
      },
    })
  );

  // --- Command: configure Azure DevOps credentials ---
  context.subscriptions.push(
    vscode.commands.registerCommand('sara.configureCredentials', async () => {
      const config = vscode.workspace.getConfiguration('sara');

      const orgUrl = await vscode.window.showInputBox({
        title: 'SARA Setup (1/4)',
        prompt: 'Azure DevOps Organization URL',
        placeHolder: 'https://dev.azure.com/your-org',
        value: config.get<string>('azureDevOpsOrgUrl', ''),
        ignoreFocusOut: true,
      });
      if (orgUrl === undefined) return;

      const project = await vscode.window.showInputBox({
        title: 'SARA Setup (2/4)',
        prompt: 'Azure DevOps Project name',
        value: config.get<string>('azureDevOpsProject', ''),
        ignoreFocusOut: true,
      });
      if (project === undefined) return;

      const team = await vscode.window.showInputBox({
        title: 'SARA Setup (3/4)',
        prompt: 'Azure DevOps Team name',
        value: config.get<string>('azureDevOpsTeam', ''),
        ignoreFocusOut: true,
      });
      if (team === undefined) return;

      const pat = await vscode.window.showInputBox({
        title: 'SARA Setup (4/4)',
        prompt: 'Azure DevOps Personal Access Token (Work Items Read scope). Leave blank to keep existing token.',
        password: true,
        ignoreFocusOut: true,
      });
      if (pat === undefined) return;

      await config.update('azureDevOpsOrgUrl', orgUrl, vscode.ConfigurationTarget.Global);
      await config.update('azureDevOpsProject', project, vscode.ConfigurationTarget.Global);
      await config.update('azureDevOpsTeam', team, vscode.ConfigurationTarget.Global);
      if (pat) {
        await context.secrets.store(PAT_SECRET_KEY, pat);
      }

      didChangeEmitter.fire();
      vscode.window.showInformationMessage('SARA: Azure DevOps credentials saved.');
    })
  );

  // --- Command: install the Sprint Review Analyst custom agent into the workspace ---
  context.subscriptions.push(
    vscode.commands.registerCommand('sara.installAgent', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('SARA: Open a workspace folder before installing the agent.');
        return;
      }

      const targetDir = path.join(folders[0].uri.fsPath, '.github', 'agents');
      const targetFile = path.join(targetDir, 'sprint-review.agent.md');
      const sourceFile = context.asAbsolutePath(path.join('resources', 'sprint-review.agent.md'));

      if (!fs.existsSync(sourceFile)) {
        vscode.window.showErrorMessage('SARA: Bundled agent definition not found in this extension package.');
        return;
      }

      if (fs.existsSync(targetFile)) {
        const overwrite = await vscode.window.showWarningMessage(
          'sprint-review.agent.md already exists in this workspace. Overwrite?',
          'Overwrite',
          'Cancel'
        );
        if (overwrite !== 'Overwrite') return;
      }

      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(sourceFile, targetFile);
      vscode.window.showInformationMessage(
        'SARA: Sprint Review Analyst agent installed. Select it from the Chat agent picker.'
      );
    })
  );

  // --- Prompt for setup on first activation if credentials are missing ---
  void (async () => {
    const pat = await context.secrets.get(PAT_SECRET_KEY);
    const config = vscode.workspace.getConfiguration('sara');
    if (!pat || !config.get<string>('azureDevOpsOrgUrl')) {
      const choice = await vscode.window.showInformationMessage(
        'SARA needs Azure DevOps credentials to get started.',
        'Configure Now'
      );
      if (choice === 'Configure Now') {
        await vscode.commands.executeCommand('sara.configureCredentials');
      }
    }
  })();
}

export function deactivate() {}
