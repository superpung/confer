/**
 * Stateless GitHub OAuth token-exchange broker.
 *
 * GitHub's web OAuth flow requires a client_secret to exchange a `code` for a
 * token; that secret cannot live in the browser (would leak), and GitHub's token
 * endpoint does not send CORS headers so the browser cannot call it directly.
 * This function is the only server-side piece: it receives the short-lived `code`,
 * exchanges it with the secret, and returns the access_token to the browser.
 *
 * It stores NOTHING — no user data, no tokens, no sessions.
 * The token goes back to the browser and lives in the user's own localStorage.
 * The scope requested by the client is `gist` only (least privilege).
 *
 * Required env vars (set in Netlify dashboard, never committed):
 *   GITHUB_CLIENT_ID     – from the GitHub OAuth App settings
 *   GITHUB_CLIENT_SECRET – from the GitHub OAuth App settings
 *
 * Setup: register a GitHub OAuth App at https://github.com/settings/developers
 *   - Homepage URL: https://your-site.netlify.app
 *   - Callback URL: https://your-site.netlify.app (the page reads ?code= itself)
 */

import type { Handler } from '@netlify/functions';

export const handler: Handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  let code: string | undefined;
  try {
    ({ code } = JSON.parse(event.body ?? '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_json' }) };
  }
  if (!code) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing_code' }) };
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'server_misconfigured' }) };
  }

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const data = await res.json() as Record<string, string>;

  if (data.error) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: data.error, description: data.error_description }) };
  }
  return { statusCode: 200, headers, body: JSON.stringify({ access_token: data.access_token, token_type: data.token_type, scope: data.scope }) };
};
