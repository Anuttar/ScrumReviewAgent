// ═══════════════════════════════════════════════════════════════════════════
// SharePoint Authentication — MSAL Device Code Flow
// Uses a well-known Microsoft first-party client ID so no
// custom Azure AD app registration is needed.
// Token is cached to disk and silently refreshed on subsequent calls.
// ═══════════════════════════════════════════════════════════════════════════

import {
  PublicClientApplication,
  type Configuration,
  LogLevel,
} from "@azure/msal-node";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

// Microsoft Graph PowerShell — widely pre-consented first-party app
const DEFAULT_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const AUTHORITY = "https://login.microsoftonline.com/common";

const DEFAULT_SCOPES = [
  "User.Read",
  "Sites.Read.All",
  "Files.Read.All",
];

const SCOPES = (process.env.GRAPH_SHAREPOINT_SCOPES || process.env.GRAPH_SCOPES)
  ?.split(/[\s,]+/)
  .map((scope) => scope.trim())
  .filter(Boolean) || DEFAULT_SCOPES;

// Shared token cache — same file across all Graph API MCPs (outlook, teams, sharepoint)
const TOKEN_CACHE_FILE = process.env.GRAPH_TOKEN_CACHE_FILE
  ? resolve(process.env.GRAPH_TOKEN_CACHE_FILE)
  : resolve(homedir(), ".graph_mcp_token_cache.json");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ── MSAL app singleton ───────────────────────────────────────────────

let _pca: PublicClientApplication | null = null;

function getPca(): PublicClientApplication {
  if (_pca) return _pca;

  const config: Configuration = {
    auth: {
      clientId: process.env.GRAPH_CLIENT_ID || DEFAULT_CLIENT_ID,
      authority: process.env.GRAPH_TENANT_ID
        ? `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}`
        : AUTHORITY,
    },
    system: {
      loggerOptions: {
        logLevel: LogLevel.Warning,
        loggerCallback: (_level, message) => console.error(`[msal] ${message}`),
      },
    },
  };

  _pca = new PublicClientApplication(config);

  // Load persisted token cache
  if (existsSync(TOKEN_CACHE_FILE)) {
    try {
      const cacheData = readFileSync(TOKEN_CACHE_FILE, "utf-8");
      _pca.getTokenCache().deserialize(cacheData);
    } catch {
      console.error("[sharepoint] Could not load token cache, starting fresh");
    }
  }

  return _pca;
}

function saveCache(): void {
  try {
    const pca = getPca();
    const cacheData = pca.getTokenCache().serialize();
    writeFileSync(TOKEN_CACHE_FILE, cacheData, { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(TOKEN_CACHE_FILE, 0o600); } catch { /* best-effort on Windows */ }
  } catch {
    console.error("[sharepoint] Could not save token cache");
  }
}

// ── Public API ───────────────────────────────────────────────────────

export async function getAccessToken(): Promise<string> {
  const pca = getPca();

  // Try silent auth only — don't block on device code
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({
        scopes: SCOPES,
        account: accounts[0],
      });
      if (result?.accessToken) {
        saveCache();
        return result.accessToken;
      }
    } catch {
      // Silent failed
    }
  }

  throw new Error("Not authenticated. Please use the **sharepoint_login** tool first to sign in.");
}

export async function getAuthStatus(): Promise<{
  authenticated: boolean;
  user?: string;
}> {
  const pca = getPca();
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length === 0) {
    return { authenticated: false };
  }

  try {
    await pca.acquireTokenSilent({
      scopes: SCOPES,
      account: accounts[0],
    });
    saveCache();
    return { authenticated: true, user: accounts[0].username };
  } catch {
    return { authenticated: false };
  }
}

/**
 * Trigger login and return the result including device code instructions.
 * If already authenticated, returns immediately.
 * If device-code flow is needed, returns the device code message immediately
 * WITHOUT waiting for the user to complete login (non-blocking).
 */
export async function triggerLogin(): Promise<{
  authenticated: boolean;
  user?: string;
  deviceCodeMessage?: string;
}> {
  const pca = getPca();

  // Try silent auth first
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({
        scopes: SCOPES,
        account: accounts[0],
      });
      if (result?.accessToken) {
        saveCache();
        return { authenticated: true, user: accounts[0].username };
      }
    } catch {
      // Silent failed — fall through to device code
    }
  }

  // Non-blocking device code: return instructions immediately, complete in background
  return new Promise((resolve) => {
    pca.acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (response) => {
        // Return the device code message immediately so the MCP tool can show it
        resolve({
          authenticated: false,
          deviceCodeMessage: response.message,
        });
        console.error(`\n🔐 ${response.message}\n`);
      },
    }).then((result) => {
      if (result?.accessToken) {
        saveCache();
        console.error("[sharepoint] ✅ Login completed successfully!");
      }
    }).catch((err) => {
      console.error(`[sharepoint] Login error: ${err}`);
    });
  });
}

export async function logout(): Promise<void> {
  const pca = getPca();
  const accounts = await pca.getTokenCache().getAllAccounts();
  for (const account of accounts) {
    await pca.getTokenCache().removeAccount(account);
  }
  saveCache();
}

// ── Graph API helper ─────────────────────────────────────────────────

export async function graphRequest(
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>
): Promise<any> {
  const token = await getAccessToken();
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;

  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (res.status === 204 || res.status === 202) return {};
  if (!res.ok) {
    const text = await res.text();
    // Retry once on transient errors (429 throttled, 503 service unavailable, 504 gateway timeout)
    if (res.status === 429 || res.status === 503 || res.status === 504) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      const retryRes = await fetch(url, opts);
      if (retryRes.status === 204 || retryRes.status === 202) return {};
      if (!retryRes.ok) {
        const statusCode = retryRes.status;
        throw new Error(`Graph API ${method} ${path} failed after retry (HTTP ${statusCode})`);
      }
      return retryRes.json();
    }
    // Sanitize error: don't expose full response body which may contain tokens/internal details
    const statusCode = res.status;
    const errorSnippet = text.slice(0, 200).replace(/Bearer [^\s"]+/g, "Bearer [REDACTED]");
    throw new Error(`Graph API ${method} ${path} failed (HTTP ${statusCode}): ${errorSnippet}`);
  }
  return res.json();
}

/**
 * Download binary content from Graph API (e.g. file /content endpoint).
 * Returns a Buffer.
 */
export async function graphDownload(path: string): Promise<Buffer> {
  const token = await getAccessToken();
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    const statusCode = res.status;
    const errorSnippet = text.slice(0, 200).replace(/Bearer [^\s"]+/g, "Bearer [REDACTED]");
    throw new Error(`Graph download ${path} failed (HTTP ${statusCode}): ${errorSnippet}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
