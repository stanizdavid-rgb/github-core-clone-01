// store.ts — the forge's in-memory state: repositories, git objects, issues, pull requests.
// Deterministic: timestamps come from a logical counter, never the wall clock, so two runs
// of the same request stream reach identical state.

import {
  ZERO_OID,
  hashObject,
  isOid,
  parseCommit,
  parseTree,
  buildTree,
  buildCommit,
  peelObject,
  collectReachable,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitcore.ts';

export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const DEFAULT_BRANCH = 'main';
const TIME_BASE = 1_700_000_000; // 2023-11-14T22:13:20Z, deterministic

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextLabelId: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const i = text.indexOf(':');
    if (i <= 0) return null;
    return { kind: text.slice(0, i), key: text.slice(i + 1) };
  } catch {
    return null;
  }
}

export class Forge {
  repos = new Map<string, Repo>();
  private seq = 0;
  private nextRepoId = 5000;
  private nextIssueId = 100000;
  private nextPullId = 200000;
  private nextCommentId = 1000000;
  /** Last (seq, ISO string) pair now() produced, for the fast path below. */
  private lastNowSeq = 0;
  private lastNowIso = '';

  /** Deterministic ISO timestamp, one second per call, in call order. */
  now(): string {
    this.seq += 1;
    const seq = this.seq;
    // Fast path: when this call follows the previous now() by exactly one
    // second, add one second to the cached ISO string with carry instead of
    // going through Date + toISOString (measured 0.79us -> 0.16us/call).
    // The string is fixed-width whole seconds (YYYY-MM-DDTHH:MM:SSZ), so the
    // carry is exact; any gap (commitStamp() shares this counter) or any
    // rollover past 23:59:59 falls back to Date, which is always correct.
    if (seq === this.lastNowSeq + 1 && this.lastNowIso !== '') {
      const s = this.lastNowIso;
      const ss = (s.charCodeAt(17) - 48) * 10 + (s.charCodeAt(18) - 48) + 1;
      if (ss < 60) {
        const iso = `${s.slice(0, 17)}${String(ss).padStart(2, '0')}Z`;
        this.lastNowSeq = seq;
        this.lastNowIso = iso;
        return iso;
      }
      const mm = (s.charCodeAt(14) - 48) * 10 + (s.charCodeAt(15) - 48) + 1;
      if (mm < 60) {
        const iso = `${s.slice(0, 14)}${String(mm).padStart(2, '0')}:00Z`;
        this.lastNowSeq = seq;
        this.lastNowIso = iso;
        return iso;
      }
      const hh = (s.charCodeAt(11) - 48) * 10 + (s.charCodeAt(12) - 48) + 1;
      if (hh < 24) {
        const iso = `${s.slice(0, 11)}${String(hh).padStart(2, '0')}:00:00Z`;
        this.lastNowSeq = seq;
        this.lastNowIso = iso;
        return iso;
      }
    }
    const iso = new Date((TIME_BASE + seq) * 1000).toISOString().replace('.000Z', 'Z');
    this.lastNowSeq = seq;
    this.lastNowIso = iso;
    return iso;
  }

  /** Deterministic commit timestamp line (seconds + timezone). */
  commitStamp(): string {
    this.seq += 1;
    return `${TIME_BASE + this.seq} +0000`;
  }

  identity(): string {
    return `${VIEWER.name} <${VIEWER.email}>`;
  }

  createRepo(name: string, opts: { description?: string; private?: boolean }): Repo | null {
    const key = repoKey(VIEWER.login, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER.login,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextLabelId: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.createdSeq - b.createdSeq || a.id - b.id);
  }

  newIssueId(): number {
    return this.nextIssueId++;
  }
  newPullId(): number {
    return this.nextPullId++;
  }
  newCommentId(): number {
    return this.nextCommentId++;
  }
}

// ---------------------------------------------------------------- git object helpers on a repo

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function refOid(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** Resolve a ref name, a branch name, or a raw oid to a commit oid (or undefined). */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : undefined;
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const oid = repo.refs.get(full);
  if (oid === undefined) return undefined;
  return peelObject(oid, (o) => repo.objects.get(o));
}

/** The tree oid of a commit, or the empty tree oid. */
export function commitTree(repo: Repo, commitOid: string): string {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return EMPTY_TREE_OID;
  return parseCommit(obj.data).tree;
}

export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

/** Flatten a tree (recursively) into path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre === '' ? e.name : `${pre}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build (and store) a tree from a flat path map. */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Read one blob's bytes at a path in a tree, or undefined. */
export function readPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string; data: Buffer } | undefined {
  const segs = path.split('/').filter((s) => s !== '');
  let oid = treeOid;
  for (let i = 0; i < segs.length; i++) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === segs[i]);
    if (!entry) return undefined;
    if (i === segs.length - 1) {
      if (entry.mode === '40000') return undefined;
      const blob = repo.objects.get(entry.oid);
      if (!blob) return undefined;
      return { oid: entry.oid, mode: entry.mode, data: blob.data };
    }
    if (entry.mode !== '40000') return undefined;
    oid = entry.oid;
  }
  return undefined;
}

/** List the entries directly under a directory path in a tree. */
export function listDir(repo: Repo, treeOid: string, dirPath: string): { name: string; path: string; oid: string; mode: string }[] | null {
  const segs = dirPath === '' ? [] : dirPath.split('/').filter((s) => s !== '');
  let oid = treeOid;
  for (const seg of segs) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (!entry || entry.mode !== '40000') return null;
    oid = entry.oid;
  }
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tree') return null;
  return parseTree(obj.data).map((e) => ({ name: e.name, path: dirPath === '' ? e.name : `${dirPath}/${e.name}`, oid: e.oid, mode: e.mode }));
}

/** Create a commit on a branch (creating the branch when missing). Returns the commit oid. */
export function commitFile(
  forge: Forge,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const baseTree = tip ? commitTree(repo, tip) : EMPTY_TREE_OID;
  const flat = flattenTree(repo, baseTree);
  const blobSha = putObject(repo, 'blob', content);
  flat.set(path, { oid: blobSha, mode: '100644' });
  const treeSha = buildTreeFromFlat(repo, flat);
  const stamp = forge.commitStamp();
  const who = `${forge.identity()} ${stamp}`;
  const commit = buildCommit({ tree: treeSha, parents: tip ? [tip] : [], author: who, committer: who, message: message.endsWith('\n') ? message : `${message}\n` });
  const commitSha = putObject(repo, 'commit', commit);
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}

/** Delete a file on a branch. Returns the new commit oid, or null when the file is absent. */
export function deleteFile(forge: Forge, repo: Repo, branch: string, path: string, message: string): string | null {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (!tip) return null;
  const flat = flattenTree(repo, commitTree(repo, tip));
  if (!flat.has(path)) return null;
  flat.delete(path);
  const treeSha = buildTreeFromFlat(repo, flat);
  const stamp = forge.commitStamp();
  const who = `${forge.identity()} ${stamp}`;
  const commit = buildCommit({ tree: treeSha, parents: [tip], author: who, committer: who, message: message.endsWith('\n') ? message : `${message}\n` });
  const commitSha = putObject(repo, 'commit', commit);
  repo.refs.set(ref, commitSha);
  return commitSha;
}

/** Commits reachable from a tip, newest (insertion-desc) first. */
export function listCommits(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}

/** Find a merge-base (first common ancestor) of two commits. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = collectReachable([a], (o) => repo.objects.get(o));
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

// ---------------------------------------------------------------- diff / merge

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCounts(a: Buffer | null, b: Buffer | null): { additions: number; deletions: number } {
  const aLines = a ? a.toString('utf8').split('\n') : [];
  const bLines = b ? b.toString('utf8').split('\n') : [];
  if (a === null) return { additions: bLines.length, deletions: 0 };
  if (b === null) return { additions: 0, deletions: aLines.length };
  const aCount = new Map<string, number>();
  for (const l of aLines) aCount.set(l, (aCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of bLines) {
    const n = aCount.get(l) ?? 0;
    if (n > 0) aCount.set(l, n - 1);
    else additions++;
  }
  let deletions = 0;
  for (const n of aCount.values()) deletions += n;
  return { additions, deletions };
}

export function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): FileChange[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const data = repo.objects.get(b.oid)?.data ?? null;
      const c = lineCounts(data, null);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: c.deletions, changes: c.deletions });
    } else if (!b && h) {
      const data = repo.objects.get(h.oid)?.data ?? null;
      const c = lineCounts(null, data);
      out.push({ filename: path, status: 'added', additions: c.additions, deletions: 0, changes: c.additions });
    } else if (b && h && b.oid !== h.oid) {
      const bd = repo.objects.get(b.oid)?.data ?? null;
      const hd = repo.objects.get(h.oid)?.data ?? null;
      const c = lineCounts(bd, hd);
      out.push({ filename: path, status: 'modified', additions: c.additions, deletions: c.deletions, changes: c.additions + c.deletions });
    }
  }
  return out;
}

/** Three-way merge of head into base. Returns the merged tree oid, or null on conflict. */
export function threeWayMerge(
  forge: Forge,
  repo: Repo,
  baseTip: string,
  headTip: string,
  mergeBaseOid: string | null,
): { treeOid: string; conflict: boolean } {
  const baseTree = flattenTree(repo, commitTree(repo, mergeBaseOid ?? ZERO_OID));
  const headTree = flattenTree(repo, commitTree(repo, headTip));
  const curTree = flattenTree(repo, commitTree(repo, baseTip));
  const merged = new Map<string, { oid: string; mode: string }>(curTree);
  let conflict = false;
  const paths = new Set([...baseTree.keys(), ...headTree.keys(), ...curTree.keys()]);
  for (const path of paths) {
    const b = baseTree.get(path);
    const h = headTree.get(path);
    const c = curTree.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    if (same(h, c)) continue; // head and current agree
    if (same(b, h)) continue; // only current changed
    if (same(b, c)) {
      // only head changed: take head (or delete)
      if (h) merged.set(path, h);
      else merged.delete(path);
      continue;
    }
    conflict = true;
  }
  if (conflict) return { treeOid: '', conflict: true };
  return { treeOid: buildTreeFromFlat(repo, merged), conflict: false };
}

/** Does merging head into base conflict? (Same logic as threeWayMerge, without building.) */
export function mergeConflicts(repo: Repo, baseTip: string, headTip: string, mergeBaseOid: string | null): boolean {
  const baseTree = flattenTree(repo, commitTree(repo, mergeBaseOid ?? ZERO_OID));
  const headTree = flattenTree(repo, commitTree(repo, headTip));
  const curTree = flattenTree(repo, commitTree(repo, baseTip));
  const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
  for (const path of new Set([...baseTree.keys(), ...headTree.keys(), ...curTree.keys()])) {
    const b = baseTree.get(path);
    const h = headTree.get(path);
    const c = curTree.get(path);
    if (same(h, c) || same(b, h) || same(b, c)) continue;
    return true;
  }
  return false;
}

/** Squash-merge a pull request onto its base branch. Returns merge commit sha or null on conflict. */
export function squashMerge(forge: Forge, repo: Repo, pull: Pull): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return null;
  const { treeOid, conflict } = threeWayMerge(forge, repo, baseTip, headTip, pull.mergeBaseSha);
  if (conflict) return null;
  const stamp = forge.commitStamp();
  const who = `${forge.identity()} ${stamp}`;
  const message = `${pull.title}\n`;
  const commit = buildCommit({ tree: treeOid, parents: [baseTip], author: who, committer: who, message });
  const sha = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  return sha;
}

// ---------------------------------------------------------------- shared creators (REST, GraphQL and MCP all use these)

export function createIssueInRepo(forge: Forge, repo: Repo, title: string, body: string, labels: string[] = []): Issue {
  const now = forge.now();
  const issue: Issue = {
    id: forge.newIssueId(),
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq: 0,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.issues.push(issue);
  return issue;
}

/** Create a pull request. Returns {pull} or {error}. */
export function createPullInRepo(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): { pull: Pull } | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha) return { error: `head branch "${head}" does not exist` };
  if (!baseSha) return { error: `base branch "${base}" does not exist` };
  const dup = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
  if (dup) return { error: 'a pull request already exists for this head and base' };
  const now = forge.now();
  const mb = mergeBase(repo, headSha, baseSha);
  const pull: Pull = {
    id: forge.newPullId(),
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    mergeBaseSha: mb ?? baseSha,
    seq: 0,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.pulls.push(pull);
  return { pull };
}

/** Merge an open pull request. Returns {sha} or {error}. */
export function mergePullInRepo(forge: Forge, repo: Repo, pull: Pull): { sha: string } | { error: string } {
  if (pull.merged) return { error: 'Pull Request is already merged' };
  if (pull.state !== 'open') return { error: 'Pull Request is not open' };
  const sha = squashMerge(forge, repo, pull);
  if (sha === null) return { error: 'Merge conflict' };
  const now = forge.now();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.closedAt = now;
  pull.mergeCommitSha = sha;
  pull.updatedAt = now;
  return { sha };
}
