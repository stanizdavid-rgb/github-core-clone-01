// graphql.ts — a small hand-rolled GraphQL executor for the documents gh and
// github-mcp-server send. Supports variables, aliases, inline input objects, enums,
// inline fragments, __type introspection, batched operation arrays, and the five mutations.

import {
  Forge,
  VIEWER,
  commitTree,
  diffTrees,
  mergeConflicts,
  mergePullInRepo,
  createIssueInRepo,
  createPullInRepo,
  decodeGlobalId,
  globalId,
  resolveRef,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { peelObject } from './gitcore.ts';

// ---------------------------------------------------------------- tokenizer / parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.' || src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        if (src[j] === '.') {
          j++;
          while (j < src.length && /[0-9]/.test(src[j])) j++;
        }
        if (src[j] === 'e' || src[j] === 'E') {
          j++;
          if (src[j] === '+' || src[j] === '-') j++;
          while (j < src.length && /[0-9]/.test(src[j])) j++;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[];
}
export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}
export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error('unexpected end of GraphQL document');
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${JSON.stringify(t)}`);
  }
  private expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(t)}`);
    if (v !== undefined && t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, this.parseSelectionSet());
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek()!;
    if (t.kind === 'punct' && t.value === '{') {
      return { operation, name, selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const n = this.peek();
      if (n && n.kind === 'name') name = this.next().value;
    }
    // variable definitions
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      let depth = 1;
      while (depth > 0) {
        const tok = this.next();
        if (tok.kind === 'punct' && tok.value === '(') depth++;
        else if (tok.kind === 'punct' && tok.value === ')') depth--;
      }
    }
    this.skipDirectives();
    return { operation, name, selections: this.parseSelectionSet() };
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const tok = this.next();
          if (tok.kind === 'punct' && tok.value === '(') depth++;
          else if (tok.kind === 'punct' && tok.value === ')') depth--;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek()!;
    if (t.kind === 'spread') {
      this.next();
      const n = this.peek();
      if (n && n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (n && n.kind === 'name') {
        const fragName = this.next().value;
        this.skipDirectives();
        return { kind: 'fragment', typeCondition: `__fragment:${fragName}`, selections: [] };
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const name = this.expectName();
    let alias = name;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      const real = this.expectName();
      return this.parseField(real, alias);
    }
    return this.parseField(name, alias);
  }

  private parseField(name: string, alias: string): FieldNode {
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = evalValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------- schema

const FIELDS: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  User: { login: 'String', id: 'ID', name: 'String', email: 'String' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest', description: 'String', url: 'String', createdAt: 'String',
  },
  Ref: { name: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'String', body: 'String', createdAt: 'String', url: 'String' },
  IssueConnection: { nodes: '[Issue]', totalCount: 'Int', pageInfo: 'PageInfo' },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'String', merged: 'Boolean',
    headRefName: 'String', baseRefName: 'String', mergeable: 'String', files: 'PullRequestChangedFileConnection',
    mergedAt: 'String', mergeCommit: 'Commit',
  },
  PullRequestConnection: { nodes: '[PullRequest]', totalCount: 'Int', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', totalCount: 'Int', pageInfo: 'PageInfo' },
  PullRequestChangedFile: { path: 'String', filename: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String', description: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  __Schema: { types: '[__Type]' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String' },
  Commit: { oid: 'String' },
  Node: { id: 'ID' },
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'LABEL', 'MILESTONE', 'PACKAGE'];

// ---------------------------------------------------------------- sources

type Source =
  | { __type: 'Query' }
  | { __type: 'Mutation' }
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Ref'; name: string }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'IssueConnection'; nodes: { repo: Repo; issue: Issue }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'PullRequestConnection'; nodes: { repo: Repo; pull: Pull }[] }
  | { __type: 'PullRequestChangedFileConnection'; nodes: { path: string }[] }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: '__Type'; name: string }
  | { __type: '__Schema' }
  | { __type: 'CreateIssuePayload'; issue: { repo: Repo; issue: Issue } | null }
  | { __type: 'CloseIssuePayload'; issue: { repo: Repo; issue: Issue } | null }
  | { __type: 'CreatePullRequestPayload'; pull: { repo: Repo; pull: Pull } | null }
  | { __type: 'MergePullRequestPayload'; pull: { repo: Repo; pull: Pull } | null }
  | { __type: 'AddCommentPayload'; comment: { id: string; body: string } | null }
  | { __type: 'IssueCommentEdge'; comment: { id: string; body: string } }
  | { __type: 'IssueComment'; comment: { id: string; body: string } };

function repoSource(repo: Repo): Source {
  return { __type: 'Repository', repo };
}
function issueSource(repo: Repo, issue: Issue): Source {
  return { __type: 'Issue', repo, issue };
}
function pullSource(repo: Repo, pull: Pull): Source {
  return { __type: 'PullRequest', repo, pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---------------------------------------------------------------- executor

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, SelectionNode[]>;
}

function resolveField(ctx: ExecCtx, typeName: string, source: Source, field: FieldNode): unknown {
  const args = evalArgs(field, ctx.variables);
  const name = field.name;

  // Meta fields
  if (name === '__typename') return typeName;

  // Plain introspection records (__Field / __EnumValue) resolve by property.
  if (((source.__type as string) === '__Field' || (source.__type as string) === '__EnumValue') && name in source) {
    return (source as unknown as Record<string, unknown>)[name];
  }

  switch (source.__type) {
    case 'Query': {
      if (name === 'viewer') return { __type: 'User', login: VIEWER.login } as Source;
      if (name === 'repository') {
        const owner = args.owner as string;
        const repoName = args.name as string;
        if (owner !== VIEWER.login) return null;
        const repo = ctx.forge.getRepo(owner, repoName);
        return repo ? repoSource(repo) : null;
      }
      if (name === 'node') {
        const id = args.id as string;
        const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
        if (!decoded) return null;
        if (decoded.kind === 'R') {
          const [owner, repoName] = decoded.key.split('/');
          const repo = ctx.forge.getRepo(owner, repoName);
          return repo ? repoSource(repo) : null;
        }
        if (decoded.kind === 'I') {
          const parsed = parseSubjectKey(decoded.key);
          const repo = parsed ? ctx.forge.getRepo(parsed.owner, parsed.name) : undefined;
          const issue = repo?.issues.find((i) => i.number === parsed?.num);
          return repo && issue ? issueSource(repo, issue) : null;
        }
        if (decoded.kind === 'P') {
          const parsed = parseSubjectKey(decoded.key);
          const repo = parsed ? ctx.forge.getRepo(parsed.owner, parsed.name) : undefined;
          const pull = repo?.pulls.find((p) => p.number === parsed?.num);
          return repo && pull ? pullSource(repo, pull) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeNameArg = args.name as string;
        return { __type: '__Type', name: typeNameArg } as Source;
      }
      if (name === '__schema') return { __type: '__Schema' } as Source;
      return undefined;
    }
    case 'Mutation': {
      if (name === 'createIssue') return createIssueMutation(ctx, args);
      if (name === 'closeIssue') return closeIssueMutation(ctx, args);
      if (name === 'createPullRequest') return createPullRequestMutation(ctx, args);
      if (name === 'mergePullRequest') return mergePullRequestMutation(ctx, args);
      if (name === 'addComment') return addCommentMutation(ctx, args);
      return undefined;
    }
    case 'User': {
      if (name === 'login') return source.login;
      if (name === 'id') return globalId('U', source.login);
      if (name === 'name') return VIEWER.name;
      if (name === 'email') return VIEWER.email;
      return undefined;
    }
    case 'Repository': {
      const repo = source.repo;
      if (name === 'id') return globalId('R', `${repo.owner}/${repo.name}`);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return { __type: 'User', login: repo.owner } as Source;
      if (name === 'description') return repo.description;
      if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (name === 'createdAt') return new Date(1_700_000_000 * 1000).toISOString().replace('.000Z', 'Z');
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? ({ __type: 'Ref', name: repo.defaultBranch } as Source) : null;
      }
      if (name === 'issue') {
        const issue = repo.issues.find((i) => i.number === (args.number as number));
        return issue ? issueSource(repo, issue) : null;
      }
      if (name === 'issues') return issuesConnection(ctx, repo, args);
      if (name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : undefined;
        let pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
        if (first !== undefined) pulls = pulls.slice(0, first);
        return { __type: 'PullRequestConnection', nodes: pulls.map((p) => ({ repo, pull: p })) } as Source;
      }
      if (name === 'pullRequest') {
        const pull = repo.pulls.find((p) => p.number === (args.number as number));
        return pull ? pullSource(repo, pull) : null;
      }
      return undefined;
    }
    case 'Ref': {
      if (name === 'name') return source.name;
      return undefined;
    }
    case 'Issue': {
      const issue = source.issue;
      if (name === 'id') return globalId('I', `${source.repo.owner}/${source.repo.name}:${issue.number}`);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issueState(issue);
      if (name === 'body') return issue.body;
      if (name === 'createdAt') return issue.createdAt;
      if (name === 'url') return `https://github.com/${source.repo.owner}/${source.repo.name}/issues/${issue.number}`;
      return undefined;
    }
    case 'IssueConnection': {
      if (name === 'nodes') return source.nodes.map((n) => issueSource(n.repo, n.issue));
      if (name === 'totalCount') return source.nodes.length;
      if (name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: source.pageInfo.hasNextPage, endCursor: source.pageInfo.endCursor } as Source;
      return undefined;
    }
    case 'PullRequest': {
      const pull = source.pull;
      const repo = source.repo;
      if (name === 'id') return globalId('P', `${repo.owner}/${repo.name}:${pull.number}`);
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pullState(pull);
      if (name === 'merged') return pull.merged;
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'mergedAt') return pull.mergedAt;
      if (name === 'mergeCommit') return pull.mergeCommitSha ? ({ __type: 'Commit' } as unknown as Source) : null;
      if (name === 'mergeable') {
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
        return mergeConflicts(repo, baseTip, pull.headSha, pull.mergeBaseSha) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (name === 'files') {
        const first = typeof args.first === 'number' ? args.first : undefined;
        const changes = diffTrees(repo, commitTree(repo, pull.mergeBaseSha), commitTree(repo, pull.headSha));
        const nodes = changes.map((c) => ({ path: c.filename, filename: c.filename }));
        return { __type: 'PullRequestChangedFileConnection', nodes: first !== undefined ? nodes.slice(0, first) : nodes } as Source;
      }
      return undefined;
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') return source.nodes.map((n) => pullSource(n.repo, n.pull));
      if (name === 'totalCount') return source.nodes.length;
      if (name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: false, endCursor: null } as Source;
      return undefined;
    }
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') return source.nodes;
      if (name === 'totalCount') return source.nodes.length;
      if (name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: false, endCursor: null } as Source;
      return undefined;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return source.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'startCursor') return null;
      if (name === 'endCursor') return source.endCursor;
      return undefined;
    }
    case '__Type': {
      const t = source.name;
      if (name === 'name') return t;
      if (name === 'kind') return t === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const fields = FIELDS[t];
        if (!fields) return null;
        return Object.keys(fields).map((f) => ({ __type: '__Field', name: f }));
      }
      if (name === 'enumValues') {
        if (t === 'SearchType') return SEARCH_TYPE_VALUES.map((v) => ({ __type: '__EnumValue', name: v }));
        return null;
      }
      return undefined;
    }
    case '__Schema': {
      if (name === 'types') return Object.keys(FIELDS).map((t) => ({ __type: '__Type', name: t }));
      return undefined;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return source.issue ? issueSource(source.issue.repo, source.issue.issue) : null;
      if (name === 'clientMutationId') return null;
      return undefined;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return source.pull ? pullSource(source.pull.repo, source.pull.pull) : null;
      if (name === 'clientMutationId') return null;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return source.comment ? ({ __type: 'IssueCommentEdge', comment: source.comment } as Source) : null;
      if (name === 'clientMutationId') return null;
      return undefined;
    }
    case 'IssueCommentEdge': {
      if (name === 'node') return { __type: 'IssueComment', comment: source.comment } as Source;
      if (name === 'cursor') return cursorFor(1);
      return undefined;
    }
    case 'IssueComment': {
      if (name === 'id') return source.comment.id;
      if (name === 'body') return source.comment.body;
      return undefined;
    }
  }
  return undefined;
}

function issuesConnection(ctx: ExecCtx, repo: Repo, args: Record<string, unknown>): Source {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy && orderBy.field === 'CREATED_AT') {
    if (orderBy.direction === 'DESC') list.sort((a, b) => b.number - a.number);
    else list.sort((a, b) => a.number - b.number);
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  const afterNum = numberFromCursor(args.after as string | null | undefined);
  if (afterNum !== null) list = list.filter((i) => i.number > afterNum);
  const first = typeof args.first === 'number' ? args.first : undefined;
  const hasNextPage = first !== undefined && list.length > first;
  const page = first !== undefined ? list.slice(0, first) : list;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => ({ repo, issue })),
    pageInfo: { hasNextPage, endCursor },
  };
}

function repoFromGlobalId(ctx: ExecCtx, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'R') return null;
  const [owner, name] = decoded.key.split('/');
  return ctx.forge.getRepo(owner, name) ?? null;
}

/** Parse an issue/pull-request global id key of the form `owner/name:number`. */
function parseSubjectKey(key: string): { owner: string; name: string; num: number } | null {
  const colon = key.indexOf(':');
  if (colon < 0) return null;
  const repoPart = key.slice(0, colon);
  const num = Number(key.slice(colon + 1));
  const slash = repoPart.indexOf('/');
  if (slash < 0 || !Number.isInteger(num)) return null;
  return { owner: repoPart.slice(0, slash), name: repoPart.slice(slash + 1), num };
}

function createIssueMutation(ctx: ExecCtx, args: Record<string, unknown>): Source {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = repoFromGlobalId(ctx, input.repositoryId);
  if (!repo) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return { __type: 'CreateIssuePayload', issue: null };
  }
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const issue = createIssueInRepo(ctx.forge, repo, title, body, []);
  return { __type: 'CreateIssuePayload', issue: { repo, issue } };
}

function closeIssueMutation(ctx: ExecCtx, args: Record<string, unknown>): Source {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
  const parsed = decoded && decoded.kind === 'I' ? parseSubjectKey(decoded.key) : null;
  if (!parsed) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return { __type: 'CloseIssuePayload', issue: null };
  }
  const repo = ctx.forge.getRepo(parsed.owner, parsed.name);
  const issue = repo?.issues.find((i) => i.number === parsed.num);
  if (!repo || !issue) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return { __type: 'CloseIssuePayload', issue: null };
  }
  issue.state = 'closed';
  issue.closedAt = ctx.forge.now();
  issue.updatedAt = ctx.forge.now();
  return { __type: 'CloseIssuePayload', issue: { repo, issue } };
}

function createPullRequestMutation(ctx: ExecCtx, args: Record<string, unknown>): Source {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = repoFromGlobalId(ctx, input.repositoryId);
  if (!repo) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return { __type: 'CreatePullRequestPayload', pull: null };
  }
  const head = typeof input.headRefName === 'string' ? input.headRefName : '';
  const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const created = createPullInRepo(ctx.forge, repo, title, body, head, base);
  if ('error' in created) {
    ctx.errors.push({ message: created.error });
    return { __type: 'CreatePullRequestPayload', pull: null };
  }
  return { __type: 'CreatePullRequestPayload', pull: { repo, pull: created.pull } };
}

function mergePullRequestMutation(ctx: ExecCtx, args: Record<string, unknown>): Source {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
  const parsed = decoded && decoded.kind === 'P' ? parseSubjectKey(decoded.key) : null;
  if (!parsed) {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
    return { __type: 'MergePullRequestPayload', pull: null };
  }
  const repo = ctx.forge.getRepo(parsed.owner, parsed.name);
  const pull = repo?.pulls.find((p) => p.number === parsed.num);
  if (!repo || !pull) {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
    return { __type: 'MergePullRequestPayload', pull: null };
  }
  const result = mergePullInRepo(ctx.forge, repo, pull);
  if ('error' in result) {
    ctx.errors.push({ message: result.error });
    return { __type: 'MergePullRequestPayload', pull: { repo, pull } };
  }
  return { __type: 'MergePullRequestPayload', pull: { repo, pull } };
}

function addCommentMutation(ctx: ExecCtx, args: Record<string, unknown>): Source {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
  const parsed = decoded && decoded.kind === 'I' ? parseSubjectKey(decoded.key) : null;
  if (!parsed) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return { __type: 'AddCommentPayload', comment: null };
  }
  const repo = ctx.forge.getRepo(parsed.owner, parsed.name);
  const issue = repo?.issues.find((i) => i.number === parsed.num);
  if (!repo || !issue) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return { __type: 'AddCommentPayload', comment: null };
  }
  const body = typeof input.body === 'string' ? input.body : '';
  const now = ctx.forge.now();
  const comment = { id: ctx.forge.newCommentId(), body, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  return {
    __type: 'AddCommentPayload',
    comment: { id: globalId('C', `${repo.owner}/${repo.name}:${issue.number}:${comment.id}`), body },
  };
}

// ---------------------------------------------------------------- selection resolution

function fieldTypeName(typeName: string, fieldName: string, source: Source): string | undefined {
  const direct = FIELDS[typeName]?.[fieldName];
  if (direct) return direct;
  if (source.__type !== typeName) {
    const concrete = FIELDS[source.__type]?.[fieldName];
    if (concrete) return concrete;
  }
  return undefined;
}

function resolveSelections(ctx: ExecCtx, typeName: string, source: Source, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition.startsWith('__fragment:')) {
        const frag = ctx.fragments.get(sel.typeCondition.slice('__fragment:'.length));
        if (frag) Object.assign(out, resolveSelections(ctx, typeName, source, frag));
        continue;
      }
      if (sel.typeCondition === null || sel.typeCondition === typeName || sel.typeCondition === source.__type) {
        Object.assign(out, resolveSelections(ctx, sel.typeCondition ?? typeName, source, sel.selections));
      }
      continue;
    }
    const field = sel;
    if (field.name === '__typename') {
      out[field.alias] = source.__type === 'Query' || source.__type === 'Mutation' ? typeName : source.__type;
      continue;
    }
    const resultType = fieldTypeName(typeName, field.name, source);
    if (resultType === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    const value = resolveField(ctx, typeName, source, field);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    out[field.alias] = shapeValue(ctx, resultType, value, field.selections);
  }
  return out;
}

function shapeValue(ctx: ExecCtx, resultType: string, value: unknown, selections: SelectionNode[]): unknown {
  if (value === null || value === undefined) return null;
  const isList = resultType.startsWith('[') && resultType.endsWith(']');
  if (isList) {
    const inner = resultType.slice(1, -1);
    if (!Array.isArray(value)) return null;
    return value.map((v) => shapeValue(ctx, inner, v, selections));
  }
  if (selections.length === 0) return value;
  if (typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>)) {
    return resolveSelections(ctx, resultType, value as Source, selections);
  }
  // Plain objects (e.g. __Field entries, changed-file nodes) resolve by field name.
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'fragment') continue;
      if (sel.name === '__typename') {
        out[sel.alias] = resultType;
        continue;
      }
      const v = rec[sel.name];
      if (v === undefined) {
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${resultType}".` });
        continue;
      }
      out[sel.alias] = v;
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export function executeGraphQL(forge: Forge, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(forge, entry));
  }
  return executeOne(forge, body);
}

function executeOne(forge: Forge, body: unknown): GraphQLResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with query and variables.' }] };
  }
  const query = (body as Record<string, unknown>).query;
  const variables = ((body as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
  const operationName = (body as Record<string, unknown>).operationName as string | undefined;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax error in GraphQL document.' }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  }
  let op = doc.operations[0];
  if (operationName) {
    const found = doc.operations.find((o) => o.name === operationName);
    if (found) op = found;
  }
  const ctx: ExecCtx = { forge, variables, errors: [], fragments: doc.fragments };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: Source = op.operation === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const data = resolveSelections(ctx, rootType, root, op.selections);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
