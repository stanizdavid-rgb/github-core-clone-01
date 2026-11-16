// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0) at /mcp.
// Speaks the 2026-07-28 revision (server/discover, no handshake) and the legacy
// initialize handshake. Tools act on the same Forge store as REST.

import {
  Forge,
  VIEWER,
  createIssueInRepo,
  createPullInRepo,
  mergePullInRepo,
  globalId,
} from './store.ts';

export const SERVER_NAME = 'github-core-clone-forge';
export const SERVER_VERSION = '1.0.0';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'The state of the issues to list: open, closed, or all.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch of the pull request.' },
        base: { type: 'string', description: 'The base branch of the pull request.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'The state of the pull requests to list: open, closed, or all.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        issue_number: { type: 'integer', description: 'The number of the issue.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function repoJson(forge: Forge, owner: string, name: string): Record<string, unknown> | null {
  const repo = forge.getRepo(owner, name);
  if (!repo) return null;
  return {
    id: repo.id,
    node_id: globalId('R', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: new Date(1_700_000_000 * 1000).toISOString().replace('.000Z', 'Z'),
    updated_at: new Date(1_700_000_000 * 1000).toISOString().replace('.000Z', 'Z'),
  };
}

function issueJson(forge: Forge, owner: string, name: string, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('I', `${owner}/${name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l })),
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${owner}/${name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${name}/issues/${issue.number}`,
  };
}

function pullJson(forge: Forge, owner: string, name: string, pull: { id: number; number: number; title: string; body: string; state: string; merged: boolean; mergeCommitSha: string | null; mergedAt: string | null; headRef: string; baseRef: string; headSha: string; baseSha: string }): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('P', `${owner}/${name}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id },
    html_url: `https://github.com/${owner}/${name}/pull/${pull.number}`,
    url: `/api/v3/repos/${owner}/${name}/pulls/${pull.number}`,
  };
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  if ((owner === '' || repo === '') && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    if (owner === '') owner = o;
    if (repo === '') repo = r;
  }
  return { owner, repo };
}

interface ToolOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { ok: false, error: `unknown tool: ${name}` };
  for (const req of def.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return { ok: false, error: `missing required argument: ${req}` };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const repo = forge.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      if (!repo) return { ok: false, error: `a repository named ${repoName} already exists` };
      return { ok: true, value: repoJson(forge, VIEWER.login, repoName) };
    }
    case 'get_repo': {
      const { owner, repo } = splitFullName(args);
      const value = repoJson(forge, owner, repo);
      if (!value) return { ok: false, error: `repository ${owner}/${repo} not found` };
      return { ok: true, value };
    }
    case 'create_issue': {
      const { owner, repo } = splitFullName(args);
      const r = forge.getRepo(owner, repo);
      if (!r) return { ok: false, error: `repository ${owner}/${repo} not found` };
      const issue = createIssueInRepo(forge, r, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return { ok: true, value: issueJson(forge, owner, repo, issue) };
    }
    case 'list_issues': {
      const { owner, repo } = splitFullName(args);
      const r = forge.getRepo(owner, repo);
      if (!r) return { ok: false, error: `repository ${owner}/${repo} not found` };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = r.issues.filter((i) => (state === 'all' ? true : i.state === state));
      return { ok: true, value: list.map((i) => issueJson(forge, owner, repo, i)) };
    }
    case 'create_pull_request': {
      const { owner, repo } = splitFullName(args);
      const r = forge.getRepo(owner, repo);
      if (!r) return { ok: false, error: `repository ${owner}/${repo} not found` };
      const created = createPullInRepo(
        forge,
        r,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
      );
      if ('error' in created) return { ok: false, error: created.error };
      return { ok: true, value: pullJson(forge, owner, repo, created.pull) };
    }
    case 'merge_pull_request': {
      const { owner, repo } = splitFullName(args);
      const r = forge.getRepo(owner, repo);
      if (!r) return { ok: false, error: `repository ${owner}/${repo} not found` };
      const number = Number(args.pull_number);
      const pull = r.pulls.find((p) => p.number === number);
      if (!pull) return { ok: false, error: `pull request #${number} not found` };
      const result = mergePullInRepo(forge, r, pull);
      if ('error' in result) return { ok: false, error: result.error };
      return { ok: true, value: { sha: result.sha, merged: true, message: 'Pull Request successfully merged', ...pullJson(forge, owner, repo, pull) } };
    }
    case 'list_pull_requests': {
      const { owner, repo } = splitFullName(args);
      const r = forge.getRepo(owner, repo);
      if (!r) return { ok: false, error: `repository ${owner}/${repo} not found` };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = r.pulls.filter((p) => (state === 'all' ? true : p.state === state));
      return { ok: true, value: list.map((p) => pullJson(forge, owner, repo, p)) };
    }
    case 'get_issue': {
      const { owner, repo } = splitFullName(args);
      const r = forge.getRepo(owner, repo);
      if (!r) return { ok: false, error: `repository ${owner}/${repo} not found` };
      const number = Number(args.issue_number);
      const issue = r.issues.find((i) => i.number === number);
      if (!issue) return { ok: false, error: `issue #${number} not found` };
      return { ok: true, value: issueJson(forge, owner, repo, issue) };
    }
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------- JSON-RPC plumbing

export interface McpResult {
  status: number;
  body: unknown;
  isNotification?: boolean;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}
function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function serverInfoBlock(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Handle one parsed JSON-RPC request object. Returns null for notifications. */
export function handleMcp(forge: Forge, request: unknown): McpResult | null {
  if (!isRecord(request)) return rpcError(null, -32600, 'Invalid Request');
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  const isNotification = request.id === undefined;

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      serverInfo: serverInfoBlock(),
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_VERSIONS,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfoBlock() },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: serverInfoBlock(),
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled' || method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    // A fresh deep copy each call, identical bytes every time.
    const tools = TOOLS.map((t) => JSON.parse(JSON.stringify(t)) as unknown);
    return rpcResult(id, { tools });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const def = TOOLS.find((t) => t.name === name);
    if (!def) return rpcError(id, -32602, `unknown tool: ${name}`);
    const outcome = callTool(forge, name, args);
    if (!outcome.ok) {
      // Missing required argument: the suite accepts isError:true or -32602.
      return rpcResult(id, {
        content: [{ type: 'text', text: outcome.error ?? 'tool call failed' }],
        isError: true,
      });
    }
    const text = JSON.stringify(outcome.value);
    return rpcResult(id, {
      content: [{ type: 'text', text }],
      structuredContent: outcome.value,
      isError: false,
    });
  }

  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}
