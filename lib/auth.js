'use strict';

/**
 * Discord sign-in using OAuth2 Authorization Code + PKCE.
 *
 * Why this is safe to ship to other people:
 *  - It is a "public client" flow: there is NO client secret anywhere.
 *  - The only scope is `identify` (username + avatar). No servers, no messages, no email.
 *  - The access token is used once to read the profile, then revoked and thrown away.
 *    Only the public profile (id, name, avatar URL) is saved on the user's PC.
 *  - The local callback server only listens on 127.0.0.1, only accepts one
 *    matching `state`, and shuts down as soon as the login finishes.
 */

const http = require('http');
const crypto = require('crypto');
const { shell, net } = require('electron');
const config = require('../config');

const DISCORD = 'https://discord.com';
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const page = (title, message) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08090c;color:#f3f5f9;font-family:"Segoe UI",system-ui,sans-serif}
  main{max-width:420px;padding:32px;text-align:center}
  h1{font-size:22px;margin:0 0 10px}
  p{margin:0;color:#9aa3b5;line-height:1.5}
</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;

let active = null;

function cancel() {
  if (active) active.abort(new Error('Sign-in cancelled.'));
  return true;
}

function waitForCode({ port, state, authorizeUrl }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method !== 'GET' || url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      };

      const gotState = url.searchParams.get('state');
      if (!gotState || !safeEqual(gotState, state)) {
        // Not our login attempt. Ignore it and keep waiting.
        res.writeHead(400, headers);
        res.end(page('Invalid request', 'This sign-in link is not valid. Go back to 777 Launcher and try again.'));
        return;
      }

      if (url.searchParams.get('error')) {
        res.writeHead(200, headers);
        res.end(page('Sign-in cancelled', 'You can close this tab and return to 777 Launcher.'));
        finish(new Error('Sign-in was cancelled in Discord.'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400, headers);
        res.end(page('Invalid request', 'Discord did not send a sign-in code. Go back to 777 Launcher and try again.'));
        return;
      }

      res.writeHead(200, headers);
      res.end(page('You’re signed in', 'You can close this tab and return to 777 Launcher.'));
      finish(null, code);
    });

    function finish(err, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active = null;
      server.close();
      setTimeout(() => server.closeAllConnections && server.closeAllConnections(), 1000).unref();
      if (err) reject(err);
      else resolve(code);
    }

    active = { abort: (err) => finish(err) };

    server.on('error', (err) => {
      finish(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is in use. Close any other copy of the launcher and try again.`)
          : err
      );
    });

    timer = setTimeout(() => finish(new Error('Sign-in timed out. Try again.')), LOGIN_TIMEOUT_MS);

    server.listen(port, '127.0.0.1', () => {
      shell.openExternal(authorizeUrl).catch((err) => finish(err));
    });
  });
}

async function exchangeCode({ clientId, code, redirectUri, verifier }) {
  const res = await net.fetch(`${DISCORD}/api/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(
      `Discord refused the sign-in (${res.status}). Make sure “Public Client” is switched on and the redirect URL is added in the Discord Developer Portal.`
    );
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('Discord did not return an access token.');
  return json.access_token;
}

async function fetchProfile(accessToken) {
  const res = await net.fetch(`${DISCORD}/api/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Could not read your Discord profile (${res.status}).`);
  const user = await res.json();

  const id = String(user.id || '');
  if (!/^\d{5,25}$/.test(id)) throw new Error('Discord returned an unexpected profile.');
  const username = String(user.username || 'user').slice(0, 64);
  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${id}/${String(user.avatar).replace(/[^a-z0-9_]/gi, '')}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;

  return {
    id,
    username,
    displayName: String(user.global_name || username).slice(0, 64),
    avatarUrl,
  };
}

async function revokeToken(clientId, token) {
  try {
    await net.fetch(`${DISCORD}/api/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token, token_type_hint: 'access_token' }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Best effort. The token is discarded either way.
  }
}

async function login() {
  const { clientId, redirectPort, scopes } = config.discord;
  if (!clientId || clientId.startsWith('PASTE_')) {
    throw new Error('Set your Discord Application ID in config.js first.');
  }
  if (active) active.abort(new Error('Sign-in restarted.'));

  const redirectUri = `http://127.0.0.1:${redirectPort}/callback`;
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));

  const authorizeUrl =
    `${DISCORD}/oauth2/authorize?` +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'none',
    });

  const code = await waitForCode({ port: redirectPort, state, authorizeUrl });
  const token = await exchangeCode({ clientId, code, redirectUri, verifier });

  try {
    return await fetchProfile(token);
  } finally {
    revokeToken(clientId, token);
  }
}

module.exports = { login, cancel };
