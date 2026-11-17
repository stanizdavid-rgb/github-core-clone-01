// app.ts — the HTTP server: routing, auth, JSON plumbing.
// main.ts (the entry <-> env lifecycle) imports createApp() from here and stays untouched.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, type RestCtx } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;
function nextRequestId(): string {
  // Counter-only: Date.now() + two base-36 conversions measured 0.37us per
  // response; the header only has to be present and unique per process.
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const all: Record<string, string> = { 'x-github-request-id': nextRequestId(), ...headers };
  if (status !== 204) {
    all['content-type'] = JSON_TYPE;
    all['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, all);
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 512 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 0 ? Buffer.alloc(0) : chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const auth = req.headers.authorization ?? '';
  return auth === `Bearer ${TOKEN}`;
}

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter((s) => s !== '');
}

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(forge, req, res).catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        // response already gone
      }
    });
  });
}

async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  // Fast path: split path/query by hand (measured 0.39us -> 0.02us per request
  // vs new URL). Falls back to URL parsing for anything non-clean (absolute
  // form, //, dot segments, spaces, fragments) so normalization and the
  // 400-on-malformed behavior are unchanged there.
  let pathname: string;
  let search = '';
  const q = rawUrl.indexOf('?');
  const rawPath = q < 0 ? rawUrl : rawUrl.slice(0, q);
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://') || rawPath.includes('//') || rawPath.includes('/.') || rawPath.includes(' ') || rawPath.includes('#')) {
    let url: URL;
    try {
      url = new URL(rawUrl, 'http://entry');
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    pathname = url.pathname;
    search = url.search.slice(1);
  } else {
    pathname = rawPath;
    search = q < 0 ? '' : rawUrl.slice(q + 1);
  }
  const host = req.headers.host ?? 'localhost';

  // Boot probe: no auth.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- REST v3
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    let body: unknown;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const segments = pathname === '/api/v3' ? [] : pathSegments(pathname).slice(2);
    const ctx: RestCtx = { method, segments, query: new URLSearchParams(search), body, host };
    const result = handleRest(forge, ctx);
    if (result === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (result.status === 204) {
      sendJson(res, 204, null, result.headers ?? {});
      return;
    }
    if (result.raw !== undefined) {
      sendRaw(res, result.status, JSON_TYPE, result.raw);
      return;
    }
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  // ---- GraphQL v4
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const result = executeGraphQL(forge, body);
    sendJson(res, 200, result);
    return;
  }

  // ---- MCP
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      // Session close (legacy clients): no session state is kept.
      sendJson(res, 204, null);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { 'content-type': JSON_TYPE });
      return;
    }
    if (Array.isArray(parsed)) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: batching is not supported' } });
      return;
    }
    const result = handleMcp(forge, parsed);
    if (result === null) {
      // Notification: no response body.
      res.writeHead(202, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // ---- git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const suffix = gitMatch[3] ?? '';
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method === 'GET' && suffix === '/info/refs') {
      const service = new URLSearchParams(search).get('service') ?? '';
      const gitProtocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
      const result = handleInfoRefs(forge, owner, repoName, service, gitProtocol);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && suffix === '/git-upload-pack') {
      const body = await readBody(req);
      const gitProtocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
      const result = handleUploadPack(forge, owner, repoName, body, gitProtocol);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && suffix === '/git-receive-pack') {
      const body = await readBody(req);
      const result = handleReceivePack(forge, owner, repoName, body);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- everything else
  sendJson(res, 404, { message: 'Not Found' });
}
