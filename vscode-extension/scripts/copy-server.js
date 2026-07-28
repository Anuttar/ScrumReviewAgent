// Bundles the built mcp-server (and the Sprint Review Analyst agent definition)
// into this extension so the packaged .vsix is self-contained.
// Run via `npm run copy-server` (also runs automatically before packaging).
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const mcpServerRoot = path.join(repoRoot, 'mcp-server');
const destServerRoot = path.join(__dirname, '..', 'server', 'mcp-server');

const includes = ['dist', 'scripts', 'package.json', 'node_modules'];

if (!fs.existsSync(path.join(mcpServerRoot, 'dist'))) {
  console.error(
    `[copy-server] ${path.join(mcpServerRoot, 'dist')} not found. Run "npm run build" in mcp-server/ first.`
  );
  process.exit(1);
}

fs.rmSync(destServerRoot, { recursive: true, force: true });
fs.mkdirSync(destServerRoot, { recursive: true });

for (const name of includes) {
  const src = path.join(mcpServerRoot, name);
  const dest = path.join(destServerRoot, name);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-server] Skipping missing path: ${src}`);
    continue;
  }
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[copy-server] Copied mcp-server/${name}`);
}

// Bundle the custom agent definition so it can be installed into a user's workspace.
const agentSrc = path.join(repoRoot, '.github', 'agents', 'sprint-review.agent.md');
const resourcesDir = path.join(__dirname, '..', 'resources');
fs.mkdirSync(resourcesDir, { recursive: true });
if (fs.existsSync(agentSrc)) {
  fs.copyFileSync(agentSrc, path.join(resourcesDir, 'sprint-review.agent.md'));
  console.log('[copy-server] Copied sprint-review.agent.md');
} else {
  console.warn(`[copy-server] Agent definition not found at ${agentSrc}`);
}
