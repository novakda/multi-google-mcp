import { google } from "googleapis";
import http from "http";
import { URL } from "url";
import open from "open";
import {
  loadConfig,
  saveConfig,
  SCOPES,
  REDIRECT_URI,
  type AccountTokens,
} from "./config.js";

export function createOAuth2Client(clientId: string, clientSecret: string) {
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Render the REAL failure into the browser response.
 *
 * The callback page is frequently the only surface the operator can actually read — a terminal
 * running this may be scrolled away, in another pane, or (Dan's case) one he cannot copy text out
 * of. Returning a bare "Internal error" 500 throws away the one piece of information that would
 * have explained the failure, which is exactly what happened on 2026-08-06: a 500 with no detail,
 * and the cause (an expired auth code) only recoverable by re-running under a logging wrapper.
 */
function failurePage(err: unknown): string {
  const e = err as { message?: string; response?: { data?: unknown } };
  const detail = e?.response?.data
    ? `${e.message ?? "error"}\n\n${JSON.stringify(e.response.data, null, 2)}`
    : (e?.message ?? String(err));
  return `<!doctype html><html><body style="font-family:system-ui;padding:2rem;max-width:46rem;margin:0 auto">
    <h1 style="margin:0 0 .5rem">Authorization failed</h1>
    <p style="color:#555;margin:0 0 1rem">The actual error, rather than a generic one:</p>
    <pre style="background:#f5f5f7;padding:1rem;border-radius:8px;white-space:pre-wrap;word-wrap:break-word;font-size:13px">${escapeHtml(detail)}</pre>
    <p style="color:#555;font-size:14px">Common causes: the authorization code expired (the consent
    screen sat open too long &mdash; just run it again), a <code>redirect_uri</code> that is not
    registered for this OAuth client, or a revoked refresh token.</p>
    <p style="color:#555;font-size:14px">The same output went to the terminal.</p>
  </body></html>`;
}

export function getAuthenticatedClient(accountName: string) {
  const config = loadConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("Google OAuth credentials not configured. Run: npm run setup");
  }
  const tokens = config.accounts[accountName];
  if (!tokens) {
    throw new Error(
      `Account "${accountName}" not found. Available: ${Object.keys(config.accounts).join(", ") || "none"}`
    );
  }
  const client = createOAuth2Client(config.clientId, config.clientSecret);
  client.setCredentials(tokens);

  // Auto-refresh tokens and persist them
  client.on("tokens", (newTokens) => {
    const current = loadConfig();
    if (current.accounts[accountName]) {
      current.accounts[accountName] = {
        ...current.accounts[accountName],
        ...newTokens,
      };
      saveConfig(current);
    }
  });

  return client;
}

/**
 * Runs the OAuth flow: opens browser, catches the callback, stores tokens.
 * Returns the account label.
 */
export async function runOAuthFlow(accountLabel: string, loginHint?: string): Promise<void> {
  const config = loadConfig();
  const client = createOAuth2Client(config.clientId, config.clientSecret);

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // force consent to always get refresh_token
    ...(loginHint ? { login_hint: loginHint } : {}),
  });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, `http://localhost:3847`);
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400);
          res.end(`Authorization failed: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400);
          res.end("No authorization code received");
          server.close();
          reject(new Error("No auth code"));
          return;
        }

        const { tokens } = await client.getToken(code);
        const current = loadConfig();
        current.accounts[accountLabel] = tokens as AccountTokens;
        saveConfig(current);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
            <div style="text-align: center;">
              <h1>Account "${accountLabel}" connected</h1>
              <p>You can close this tab and return to your terminal.</p>
            </div>
          </body></html>
        `);

        server.close();
        resolve();
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(failurePage(err));
        console.error(`\n  AUTH FAILED: ${(err as Error).message}\n`);
        server.close();
        reject(err);
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            "Port 3847 is already in use. Close whatever is using it and try again.\n" +
            "  To find it: lsof -i :3847"
          )
        );
      } else {
        reject(err);
      }
    });

    server.listen(3847, () => {
      console.log(`\n  Opening browser for Google sign-in...\n`);
      console.log(`  If the browser doesn't open, visit this URL:\n`);
      console.log(`  ${authUrl}\n`);
      open(authUrl);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 2 minutes"));
    }, 120_000);
  });
}
