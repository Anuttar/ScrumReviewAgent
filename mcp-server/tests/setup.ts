// Test environment setup — runs once before the test suite.
// Provides fake-but-valid Azure DevOps env vars so that `getConfig()` and the
// module-scope `new AzureDevOpsClient(...)` in src/index.ts don't throw / exit
// when the server module is imported during tests.
process.env.AZURE_DEVOPS_ORG_URL = process.env.AZURE_DEVOPS_ORG_URL || 'https://dev.azure.com/test-org';
process.env.AZURE_DEVOPS_PROJECT = process.env.AZURE_DEVOPS_PROJECT || 'TestProject';
process.env.AZURE_DEVOPS_TEAM = process.env.AZURE_DEVOPS_TEAM || 'TestTeam';
process.env.AZURE_DEVOPS_PAT = process.env.AZURE_DEVOPS_PAT || 'test-pat-token';
