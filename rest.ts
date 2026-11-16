// rest.ts — GitHub REST v3 handlers under /api/v3.
// Every reply is JSON with X-GitHub-Request-Id (added by app.ts); errors carry a string message.

import {
  Forge,
  VIEWER,
  commitFile,
  deleteFile,
  commitTree,
  flattenTree,
  listCommits,
  listDir,
  readPath,
  diffTrees,
  mergeBase,
  squashMerge,
  mergeConflicts,
  createIssueInRepo,
  createPullInRepo,
  mergePullInRepo,
  globalId,
  resolveRef,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { parseCommit, isOid, ZERO_OID } from './gitcore.ts';

export interface RestCtx {
  method: string;
  segments: string[]; // path segments after /api/v3, decoded
  query: URLSearchParams;
  body: unknown;
  host: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('U', VIEWER.login),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: globalId('R', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: base,
    created_at: new Date(1_700_000_000 * 1000).toISOString().replace('.000Z', 'Z'),
    updated_at: new Date(1_700_000_000 * 1000).toISOString().replace('.000Z', 'Z'),
    pushed_at: new Date(1_700_000_000 * 1000).toISOString().replace('.000Z', 'Z'),
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    svn_url: `https://github.com/${repo.owner}/${repo.name}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    node_id: globalId('L', `${repo.owner}/${repo.name}:${name}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: label?.description ?? '',
  };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('I', `${repo.owner}/${repo.name}:${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headRepo = repoJson(forge, repo);
  const mkSide = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: headRepo,
  });
  return {
    id: pull.id,
    node_id: globalId('P', `${repo.owner}/${repo.name}:${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`,
    review_comment_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.owner}/${repo.name}/statuses/${pull.headSha}`,
    head: mkSide(pull.headRef, pull.headSha),
    base: mkSide(pull.baseRef, pull.baseSha),
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !mergeConflicts(repo, repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha, pull.headSha, pull.mergeBaseSha) : null,
    rebaseable: null,
    mergeable_state: pull.state === 'open' ? (mergeConflicts(repo, repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha, pull.headSha, pull.mergeBaseSha) ? 'dirty' : 'clean') : 'unknown',
    merged_by: pull.merged ? userJson() : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commentJson(forge: Forge, repo: Repo, issue: Issue, c: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: c.id,
    node_id: globalId('C', `${repo.owner}/${repo.name}:${issue.number}:${c.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
    body: c.body,
    user: userJson(),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

function parseAuthor(line: string): { name: string; email: string; date: string } {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return { name: line, email: '', date: new Date(1_700_000_000 * 1000).toISOString().replace('.000Z', 'Z') };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString().replace('.000Z', 'Z') };
}

function commitJson(forge: Forge, repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const author = parseAuthor(c.author);
  const committer = parseAuthor(c.committer);
  return {
    sha,
    node_id: globalId('C', sha),
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: c.message.replace(/\n+$/, ''),
      tree: { sha: c.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${c.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}`, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${p}` })),
  };
}

function shortRef(ref: string): string {
  const i = ref.indexOf(':');
  return i >= 0 ? ref.slice(i + 1) : ref;
}

function getRepoOr404(forge: Forge, owner: string, name: string): Repo | RestResult {
  if (owner !== VIEWER.login) return err(404, 'Not Found');
  const repo = forge.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  return repo;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}

function linkHeader(host: string, path: string, query: URLSearchParams, pageNum: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (pageNum >= lastPage) return null;
  const url = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `http://${host}${path}?${q.toString()}`;
  };
  return `<${url(pageNum + 1)}>; rel="next", <${url(lastPage)}>; rel="last"`;
}

export function handleRest(forge: Forge, ctx: RestCtx): RestResult | null {
  const { method, segments: s, query } = ctx;
  const seg = (i: number): string | undefined => s[i];

  // ---- API root
  if (s.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
        commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: 'https://api.github.com/hub',
        issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
        notifications_url: '/api/v3/notifications{?since,all,participating}',
        organization_url: '/api/v3/orgs/{org}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_teams_url: '/api/v3/orgs/{org}/teams',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/users/{user}/orgs',
        user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (seg(0) === 'meta' && s.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return { status: 200, body: { verifiable_password_authentication: true, installed_version: '1.0.0', github_enterprise_version: '3.0.0' } };
  }

  if (seg(0) === 'rate_limit' && s.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return {
      status: 200,
      body: {
        resources: { core: { limit: 5000, remaining: 4999, reset: 1_700_000_000 + 3600, used: 1 }, search: { limit: 30, remaining: 30, reset: 1_700_000_000 + 60, used: 0 } },
        rate: { limit: 5000, remaining: 4999, reset: 1_700_000_000 + 3600, used: 1 },
      },
    };
  }

  if (seg(0) === 'user' && s.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return { status: 200, body: userJson() };
  }

  // ---- POST /user/repos, GET /user/repos
  if (seg(0) === 'user' && seg(1) === 'repos' && s.length === 2) {
    if (method === 'POST') {
      const b = isRecord(ctx.body) ? ctx.body : {};
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return err(422, 'Validation Failed: name is required and must be a valid repository name');
      }
      const repo = forge.createRepo(name, { description: typeof b.description === 'string' ? b.description : '', private: b.private === true });
      if (!repo) return err(422, 'Validation Failed: a repository with this name already exists');
      return { status: 201, body: repoJson(forge, repo) };
    }
    if (method === 'GET') {
      const all = forge.listViewerRepos();
      const { page, total, pageNum, perPage } = paginate(all, query);
      const headers: Record<string, string> = {};
      const link = linkHeader(ctx.host, '/api/v3/user/repos', query, pageNum, perPage, total);
      if (link) headers.link = link;
      return { status: 200, body: page.map((r) => repoJson(forge, r)), headers };
    }
    return err(404, 'Not Found');
  }

  // ---- /repos/{owner}/{repo}[...]
  if (seg(0) === 'repos' && s.length >= 3) {
    const owner = decodeURIComponent(seg(1)!);
    const name = decodeURIComponent(seg(2)!);
    const rest = s.slice(3);
    const repoOrErr = getRepoOr404(forge, owner, name);
    if (!isRepo(repoOrErr)) {
      // A missing repo under another owner is still 404; under the viewer too.
      return repoOrErr;
    }
    const repo = repoOrErr;
    return handleRepo(forge, ctx, repo, rest);
  }

  return null;
}

function isRepo(v: Repo | RestResult): v is Repo {
  return (v as Repo).objects !== undefined;
}

function handleRepo(forge: Forge, ctx: RestCtx, repo: Repo, rest: string[]): RestResult {
  const { method, query } = ctx;
  const r0 = rest[0];

  // ---- the repository itself
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(forge, repo) };
    if (method === 'PATCH') {
      const b = isRecord(ctx.body) ? ctx.body : {};
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.private = b.private;
      return { status: 200, body: repoJson(forge, repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  // ---- branches
  if (r0 === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const names = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort();
      return {
        status: 200,
        body: names.map((n) => ({ name: n, commit: { sha: repo.refs.get(`refs/heads/${n}`)!, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${repo.refs.get(`refs/heads/${n}`)!}` }, protected: false })),
      };
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1]);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return err(404, 'Branch not found');
      return { status: 200, body: { name: branch, commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` }, protected: false } };
    }
    return err(404, 'Not Found');
  }

  // ---- commits
  if (r0 === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (!tip) return err(404, 'Not Found');
    const shas = listCommits(repo, tip);
    const { page } = paginate(shas, query);
    const out: unknown[] = [];
    for (const sha of page) {
      const c = commitJson(forge, repo, sha);
      if (c) out.push(c);
    }
    return { status: 200, body: out };
  }
  if (r0 === 'commits' && rest.length === 2 && method === 'GET') {
    const sha = decodeURIComponent(rest[1]);
    const c = commitJson(forge, repo, sha);
    if (!c) return err(404, 'Not Found');
    return { status: 200, body: c };
  }

  // ---- git refs
  if (r0 === 'git' && rest[1] === 'refs') {
    if (method === 'GET' && rest.length === 2) {
      const all = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      return { status: 200, body: all.map(([ref, sha]) => ({ ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` })) };
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).map(decodeURIComponent).join('/');
      const sha = repo.refs.get(ref);
      if (!sha) return err(404, 'Not Found');
      return { status: 200, body: { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` } };
    }
    if (method === 'POST' && rest.length === 2) {
      const b = isRecord(ctx.body) ? ctx.body : {};
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
        return err(422, 'Validation Failed: ref and sha are required and sha must name an existing object');
      }
      if (repo.refs.has(ref)) return err(422, 'Validation Failed: reference already exists');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` } };
    }
    if (method === 'PATCH' && rest.length >= 3) {
      const ref = rest.slice(2).map(decodeURIComponent).join('/');
      const b = isRecord(ctx.body) ? ctx.body : {};
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!repo.refs.has(ref) || !isOid(sha) || !repo.objects.has(sha)) return err(422, 'Validation Failed');
      repo.refs.set(ref, sha);
      return { status: 200, body: { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` } };
    }
    if (method === 'DELETE' && rest.length >= 3) {
      const ref = rest.slice(2).map(decodeURIComponent).join('/');
      if (!repo.refs.has(ref)) return err(404, 'Not Found');
      repo.refs.delete(ref);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  // ---- contents
  if (r0 === 'contents') {
    const path = rest.slice(1).map(decodeURIComponent).join('/');
    return handleContents(forge, ctx, repo, path);
  }

  // ---- labels
  if (r0 === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return { status: 200, body: [...repo.labels.values()].map((l) => labelJson(repo, l.name)) };
    }
    if (method === 'POST' && rest.length === 1) {
      const b = isRecord(ctx.body) ? ctx.body : {};
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') return err(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return err(422, 'Validation Failed: label already exists');
      const color = typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed';
      const label = { id: repo.nextLabelId++, name, color, description: typeof b.description === 'string' ? b.description : '' };
      repo.labels.set(name, label);
      return { status: 201, body: labelJson(repo, name) };
    }
    return err(404, 'Not Found');
  }

  // ---- issues
  if (r0 === 'issues') {
    return handleIssues(forge, ctx, repo, rest.slice(1));
  }

  // ---- pulls
  if (r0 === 'pulls') {
    return handlePulls(forge, ctx, repo, rest.slice(1));
  }

  return err(404, 'Not Found');
}

function handleContents(forge: Forge, ctx: RestCtx, repo: Repo, path: string): RestResult {
  const { method, query } = ctx;
  const refParam = query.get('ref') ?? undefined;
  const branch = refParam ?? repo.defaultBranch;
  const tip = refParam ? resolveRef(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);

  if (method === 'GET') {
    if (!tip) return err(404, 'Not Found');
    const treeOid = commitTree(repo, tip);
    if (path === '') {
      const entries = listDir(repo, treeOid, '') ?? [];
      return { status: 200, body: entries.map((e) => dirEntryJson(forge, repo, e)) };
    }
    const file = readPath(repo, treeOid, path);
    if (file) {
      const name = path.split('/').pop()!;
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          size: file.data.length,
          name,
          path,
          content: file.data.toString('base64'),
          sha: file.oid,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
          git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.oid}`,
          html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
          download_url: null,
          _links: { git: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.oid}`, self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, html: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}` },
        },
      };
    }
    const entries = listDir(repo, treeOid, path);
    if (entries) {
      return { status: 200, body: entries.map((e) => dirEntryJson(forge, repo, e)) };
    }
    return err(404, 'Not Found');
  }

  if (method === 'PUT') {
    const b = isRecord(ctx.body) ? ctx.body : {};
    const message = typeof b.message === 'string' ? b.message : `Update ${path}`;
    const contentB64 = typeof b.content === 'string' ? b.content : '';
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const reqBranch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
    const sha = typeof b.sha === 'string' ? b.sha : undefined;
    // Resolve or create the branch.
    let tipOid = repo.refs.get(`refs/heads/${reqBranch}`);
    if (tipOid === undefined) {
      const defTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defTip) repo.refs.set(`refs/heads/${reqBranch}`, defTip);
      tipOid = repo.refs.get(`refs/heads/${reqBranch}`);
    }
    const existing = tipOid ? readPath(repo, commitTree(repo, tipOid), path) : undefined;
    if (existing) {
      if (sha === undefined) return err(422, 'Validation Failed: sha is required to update a file');
      if (sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'Conflict: sha does not match the current file');
      const { commitSha, blobSha } = commitFile(forge, repo, reqBranch, path, content, message);
      return {
        status: 200,
        body: {
          content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`, html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${reqBranch}/${path}`, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${commitSha}` },
        },
      };
    }
    if (sha !== undefined) return err(422, 'Validation Failed: sha does not match any existing file');
    const { commitSha, blobSha } = commitFile(forge, repo, reqBranch, path, content, message);
    return {
      status: 201,
      body: {
        content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`, html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${reqBranch}/${path}`, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${commitSha}` },
      },
    };
  }

  if (method === 'DELETE') {
    const b = isRecord(ctx.body) ? ctx.body : {};
    const message = typeof b.message === 'string' ? b.message : `Delete ${path}`;
    const sha = typeof b.sha === 'string' ? b.sha : undefined;
    const tipOid = repo.refs.get(`refs/heads/${branch}`);
    if (!tipOid) return err(404, 'Not Found');
    const existing = readPath(repo, commitTree(repo, tipOid), path);
    if (!existing) return err(404, 'Not Found');
    if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'Conflict: sha does not match the current file');
    const commitSha = deleteFile(forge, repo, branch, path, message);
    if (!commitSha) return err(404, 'Not Found');
    return { status: 200, body: { content: null, commit: { sha: commitSha, message, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${commitSha}` } } };
  }

  return err(404, 'Not Found');
}

function dirEntryJson(forge: Forge, repo: Repo, e: { name: string; path: string; oid: string; mode: string }): Record<string, unknown> {
  const isDir = e.mode === '40000';
  const size = isDir ? 0 : repo.objects.get(e.oid)?.data.length ?? 0;
  return {
    type: isDir ? 'dir' : 'file',
    size,
    name: e.name,
    path: e.path,
    sha: e.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${e.path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${e.oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${e.path}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${e.path}`,
    _links: { git: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${e.oid}`, self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${e.path}`, html: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${e.path}` },
  };
}

function handleIssues(forge: Forge, ctx: RestCtx, repo: Repo, rest: string[]): RestResult {
  const { method, query } = ctx;

  if (rest.length === 0) {
    if (method === 'POST') {
      const b = isRecord(ctx.body) ? ctx.body : {};
      const title = typeof b.title === 'string' ? b.title : '';
      if (title === '') return err(422, 'Validation Failed: title is required');
      const rawLabels: unknown[] = Array.isArray(b.labels) ? b.labels : [];
      const labelNames: string[] = [];
      for (const l of rawLabels) {
        const name = typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '';
        if (name === '') continue;
        if (!repo.labels.has(name)) return err(422, `Validation Failed: label "${name}" does not exist`);
        labelNames.push(name);
      }
      const issue = createIssueInRepo(forge, repo, title, typeof b.body === 'string' ? b.body : '', labelNames);
      return { status: 201, body: issueJson(forge, repo, issue) };
    }
    if (method === 'GET') {
      let list = [...repo.issues];
      const state = query.get('state') ?? 'open';
      if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, total, pageNum, perPage } = paginate(list, query);
      const headers: Record<string, string> = {};
      const link = linkHeader(ctx.host, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, pageNum, perPage, total);
      if (link) headers.link = link;
      return { status: 200, body: page.map((i) => issueJson(forge, repo, i)), headers };
    }
    return err(404, 'Not Found');
  }

  const num = Number(rest[0]);
  if (!Number.isInteger(num) || num < 1) return err(404, 'Not Found');
  const issue = repo.issues.find((i) => i.number === num);
  if (!issue) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: issueJson(forge, repo, issue) };
    if (method === 'PATCH') {
      const b = isRecord(ctx.body) ? ctx.body : {};
      if (typeof b.title === 'string') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      if (b.state === 'open' || b.state === 'closed') {
        issue.state = b.state;
        issue.closedAt = b.state === 'closed' ? forge.now() : null;
      }
      if (Array.isArray(b.labels)) {
        const names: string[] = [];
        for (const l of b.labels) {
          const name = typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '';
          if (name !== '' && repo.labels.has(name)) names.push(name);
        }
        issue.labels = names;
      }
      issue.updatedAt = forge.now();
      return { status: 200, body: issueJson(forge, repo, issue) };
    }
    return err(404, 'Not Found');
  }

  if (rest[1] === 'comments') {
    if (method === 'POST') {
      const b = isRecord(ctx.body) ? ctx.body : {};
      const body = typeof b.body === 'string' ? b.body : '';
      if (body === '') return err(422, 'Validation Failed: body is required');
      const now = forge.now();
      const comment = { id: forge.newCommentId(), body, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      return { status: 201, body: commentJson(forge, repo, issue, comment) };
    }
    if (method === 'GET') {
      return { status: 200, body: issue.comments.map((c) => commentJson(forge, repo, issue, c)) };
    }
    return err(404, 'Not Found');
  }

  if (rest[1] === 'labels' && method === 'GET') {
    return { status: 200, body: issue.labels.map((n) => labelJson(repo, n)) };
  }

  return err(404, 'Not Found');
}

function handlePulls(forge: Forge, ctx: RestCtx, repo: Repo, rest: string[]): RestResult {
  const { method, query } = ctx;

  if (rest.length === 0) {
    if (method === 'POST') {
      const b = isRecord(ctx.body) ? ctx.body : {};
      const title = typeof b.title === 'string' ? b.title : '';
      const head = shortRef(typeof b.head === 'string' ? b.head : '');
      const base = shortRef(typeof b.base === 'string' ? b.base : repo.defaultBranch);
      if (title === '' || head === '' || base === '') return err(422, 'Validation Failed: title, head and base are required');
      const created = createPullInRepo(forge, repo, title, typeof b.body === 'string' ? b.body : '', head, base);
      if ('error' in created) return err(422, `Validation Failed: ${created.error}`);
      return { status: 201, body: pullJson(forge, repo, created.pull) };
    }
    if (method === 'GET') {
      let list = [...repo.pulls];
      const state = query.get('state') ?? 'open';
      if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page, total, pageNum, perPage } = paginate(list, query);
      const headers: Record<string, string> = {};
      const link = linkHeader(ctx.host, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query, pageNum, perPage, total);
      if (link) headers.link = link;
      return { status: 200, body: page.map((p) => pullJson(forge, repo, p)), headers };
    }
    return err(404, 'Not Found');
  }

  const num = Number(rest[0]);
  if (!Number.isInteger(num) || num < 1) return err(404, 'Not Found');
  const pull = repo.pulls.find((p) => p.number === num);
  if (!pull) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(forge, repo, pull) };
    if (method === 'PATCH') {
      const b = isRecord(ctx.body) ? ctx.body : {};
      if (typeof b.title === 'string') pull.title = b.title;
      if (typeof b.body === 'string') pull.body = b.body;
      if (b.state === 'closed' && pull.state === 'open') {
        pull.state = 'closed';
        pull.closedAt = forge.now();
      }
      pull.updatedAt = forge.now();
      return { status: 200, body: pullJson(forge, repo, pull) };
    }
    return err(404, 'Not Found');
  }

  if (rest[1] === 'files' && method === 'GET') {
    const changes = diffTrees(repo, commitTree(repo, pull.mergeBaseSha), commitTree(repo, pull.headSha));
    return {
      status: 200,
      body: changes.map((c) => ({
        sha: '',
        filename: c.filename,
        status: c.status,
        additions: c.additions,
        deletions: c.deletions,
        changes: c.changes,
        blob_url: '',
        raw_url: '',
        contents_url: '',
        patch: '',
      })),
    };
  }

  if (rest[1] === 'merge' && method === 'PUT') {
    const result = mergePullInRepo(forge, repo, pull);
    if ('error' in result) {
      if (result.error === 'Merge conflict') return err(405, 'Merge conflict');
      return err(405, result.error);
    }
    return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
  }

  if (rest[1] === 'merge' && method === 'GET') {
    return { status: 200, body: { sha: pull.mergeCommitSha ?? '', merged: pull.merged, message: pull.merged ? 'Pull Request successfully merged' : 'Pull Request is not merged' } };
  }

  return err(404, 'Not Found');
}

export { ZERO_OID };
