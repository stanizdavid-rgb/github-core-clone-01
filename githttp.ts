// githttp.ts — git smart HTTP: info/refs advertisements (v0 + v2), ls-refs, fetch
// (v2 and v0), and receive-pack (v0). The suite's client is the only caller.

import {
  Forge,
  commitTree,
  getObject,
  type Repo,
} from './store.ts';
import {
  ZERO_OID,
  pktLine,
  PKT_FLUSH,
  PKT_DELIM,
  decodePktLines,
  readPack,
  writePack,
  collectReachable,
  isDescendantOrSelf,
  isOid,
  parseTag,
  peelObject,
  type GitObject,
} from './gitcore.ts';

const AGENT = 'github-core-clone-forge/1.0';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function buf(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function jsonResult(status: number, body: unknown): GitResult {
  return { status, contentType: 'application/json', body: buf(`${JSON.stringify(body)}\n`) };
}

/** Sorted refs: heads first, then tags. */
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const heads = [...repo.refs.entries()].filter(([n]) => n.startsWith('refs/heads/')).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const tags = [...repo.refs.entries()].filter(([n]) => n.startsWith('refs/tags/')).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const others = [...repo.refs.entries()].filter(([n]) => !n.startsWith('refs/heads/') && !n.startsWith('refs/tags/')).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [...heads, ...tags, ...others].map(([name, oid]) => ({ name, oid }));
}

function isTagObject(repo: Repo, oid: string): boolean {
  return repo.objects.get(oid)?.type === 'tag';
}

// ---------------------------------------------------------------- info/refs

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`
      : `report-status side-band-64k delete-refs agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/') && isTagObject(repo, ref.oid)) {
        const peeled = peelObject(ref.oid, (o) => repo.objects.get(o));
        parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const caps = [
    `agent=${AGENT}`,
    'ls-refs=unborn',
    'fetch=shallow',
    'object-format=sha1',
  ];
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of caps) parts.push(pktLine(`${cap}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: number,
): GitResult {
  const repo = forge.getRepo(owner, repoName);
  if (!repo || owner !== 'adaiversen') return jsonResult(404, { message: 'Not Found' });
  if (service === 'git-upload-pack') {
    if (gitProtocol === 2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return jsonResult(400, { message: 'Invalid service' });
}

// ---------------------------------------------------------------- fetch object selection

interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

function selectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowSent: string[],
  depth: number | undefined,
): FetchSelection {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const D = depth === undefined ? Number.POSITIVE_INFINITY : depth;
  const shallowSet = new Set(shallowSent);
  const haveExcl = collectReachable(
    haves.filter((h) => !shallowSet.has(h)),
    lookup,
  );

  const objects = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    if (objects.has(oid) || haveExcl.has(oid)) return;
    const obj = lookup(oid);
    if (obj) objects.set(oid, obj);
  };
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    const seen = new Set<string>();
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid) || haveExcl.has(oid)) continue;
      seen.add(oid);
      const obj = lookup(oid);
      if (!obj || obj.type !== 'tree') continue;
      addObject(oid);
      // parse tree entries inline
      const data = obj.data;
      let off = 0;
      while (off < data.length) {
        const sp = data.indexOf(0x20, off);
        const nul = data.indexOf(0x00, sp + 1);
        if (sp < 0 || nul < 0) break;
        const mode = data.subarray(off, sp).toString('ascii');
        const childOid = data.subarray(nul + 1, nul + 21).toString('hex');
        if (mode === '40000') stack.push(childOid);
        else addObject(childOid);
        off = nul + 21;
      }
    }
  };

  // BFS over commits from the wants, tracking min depth.
  const commitDepth = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [];
  const enqueue = (oid: string, depth: number): void => {
    const prev = commitDepth.get(oid);
    if (prev !== undefined && prev <= depth) return;
    commitDepth.set(oid, depth);
    queue.push({ oid, depth });
  };
  for (const want of wants) {
    const obj = lookup(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      addObject(want);
      const target = peelObject(want, lookup);
      const targetObj = lookup(target);
      if (targetObj?.type === 'commit') enqueue(target, 0);
      else if (targetObj) addObject(target);
    } else if (obj.type === 'commit') {
      enqueue(want, 0);
    } else {
      addObject(want);
    }
  }

  const includedCommits: { oid: string; depth: number }[] = [];
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (depth >= D) continue;
    if (haveExcl.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    includedCommits.push({ oid, depth });
    addObject(oid);
    // commit -> tree + parents
    const data = obj.data;
    const blank = data.indexOf('\n\n');
    const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
    let tree = '';
    const parents: string[] = [];
    for (const line of head.split('\n')) {
      const sp = line.indexOf(' ');
      const k = sp < 0 ? line : line.slice(0, sp);
      const v = sp < 0 ? '' : line.slice(sp + 1);
      if (k === 'tree') tree = v;
      else if (k === 'parent') parents.push(v);
    }
    if (tree !== '') addTreeClosure(tree);
    if (depth + 1 < D) for (const p of parents) enqueue(p, depth + 1);
  }

  const shallow: string[] = [];
  if (Number.isFinite(D)) {
    for (const c of includedCommits) if (c.depth === D - 1) shallow.push(c.oid);
  }
  const shallowOut = [...new Set(shallow)];
  const unshallow = shallowSent.filter((s) => includedCommits.some((c) => c.oid === s) && !shallowOut.includes(s));
  return { objects, shallow: shallowOut, unshallow };
}

// ---------------------------------------------------------------- pkt-line request parsing

/** Read pkt-lines from the front of a buffer; returns packets and the offset after the flush. */
function readRequestPackets(body: Buffer): { packets: { kind: string; payload?: Buffer }[]; offset: number } {
  const packets: { kind: string; payload?: Buffer }[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const head = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end' });
      off += 4;
      break;
    }
    if (len < 4 || off + len > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, offset: off };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 60000;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) {
    // A packfile section must carry at least one sideband packet.
    out.push(pktLine(Buffer.concat([Buffer.from([1]), writePack([])])));
  }
  return out;
}

// ---------------------------------------------------------------- upload-pack

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`));
    }
  } else {
    if (keep('HEAD')) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.name.startsWith('refs/tags/') && isTagObject(repo, ref.oid)) {
        const peeled = peelObject(ref.oid, (o) => repo.objects.get(o));
        line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponse(repo: Repo, wants: string[], haves: string[], shallowSent: string[], depth: number | undefined): Buffer {
  const sel = selectFetchObjects(repo, wants, haves, shallowSent, depth);
  const pack = writePack(sel.objects.values());
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (haves.length > 0) {
    parts.push(pktLine(`ACK ${haves[0]}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (depth !== undefined || sel.shallow.length > 0 || sel.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of sel.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, wants: string[], haves: string[], shallowSent: string[], depth: number | undefined): Buffer {
  const sel = selectFetchObjects(repo, wants, haves, shallowSent, depth);
  const pack = writePack(sel.objects.values());
  const parts: Buffer[] = [];
  if (haves.length > 0) parts.push(pktLine(`ACK ${haves[0]}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of sel.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: number,
): GitResult {
  const repo = forge.getRepo(owner, repoName);
  if (!repo || owner !== 'adaiversen') return jsonResult(404, { message: 'Not Found' });
  let packets;
  try {
    packets = decodePktLines(body).filter((p) => p.kind === 'data').map((p) => (p.kind === 'data' ? p.payload.toString('utf8') : ''));
  } catch {
    return jsonResult(400, { message: 'Bad Request: malformed pkt-line stream' });
  }
  const first = (packets[0] ?? '').trim();
  if (gitProtocol === 2 || first.startsWith('command=')) {
    const command = first.replace('command=', '').trim();
    const args = packets.slice(1);
    if (command === 'ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      for (const arg of args) {
        const a = arg.trim();
        if (a.startsWith('want ')) wants.push(a.slice(5).trim());
        else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
        else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
        else if (a.startsWith('deepen ')) {
          const n = Number(a.slice(7).trim());
          if (Number.isInteger(n) && n > 0) depth = n;
        }
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(repo, wants, haves, shallow, depth) };
    }
    return jsonResult(400, { message: `unknown command: ${command}` });
  }
  // v0 fetch: want/have/done lines in two sections.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of packets) {
    const a = line.trim();
    if (a.startsWith('want ')) {
      const rest = a.slice(5).trim();
      const oid = rest.split(' ')[0];
      if (isOid(oid)) wants.push(oid);
    } else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = Number(a.slice(7).trim());
      if (Number.isInteger(n) && n > 0) depth = n;
    }
  }
  if (wants.length === 0) return jsonResult(400, { message: 'Bad Request: no want lines' });
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV0(repo, wants, haves, shallow, depth) };
}

// ---------------------------------------------------------------- receive-pack

export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): GitResult {
  const repo = forge.getRepo(owner, repoName);
  if (!repo || owner !== 'adaiversen') return jsonResult(404, { message: 'Not Found' });
  const { packets, offset } = readRequestPackets(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const p of packets) {
    if (p.kind !== 'data' || !p.payload) continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }
  if (commands.length === 0) {
    return jsonResult(400, { message: 'Bad Request: no ref commands' });
  }
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (e) {
      unpackOk = false;
      unpackDetail = e instanceof Error ? e.message : 'unpack failed';
    }
  }

  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const lines: Buffer[] = [];
  lines.push(pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`));
  for (const cmd of commands) {
    let result: string | null = null; // null = ok
    if (!cmd.ref.startsWith('refs/')) {
      result = 'invalid ref';
    } else if (!unpackOk) {
      result = 'unpack failed';
    } else {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (!current) result = 'remote ref does not exist';
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) result = 'old oid does not match';
        else {
          repo.refs.delete(cmd.ref);
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // create
        if (current) result = 'already exists';
        else if (!repo.objects.has(cmd.newOid)) result = 'unable to read object';
        else {
          const type = repo.objects.get(cmd.newOid)!.type;
          if (type !== 'commit' && type !== 'tag') result = 'not a commit';
          else repo.refs.set(cmd.ref, cmd.newOid);
        }
      } else {
        // update
        if (!current) result = 'remote ref does not exist';
        else if (cmd.oldOid !== current) result = 'old oid does not match';
        else if (cmd.newOid === current) {
          // no-op, ok
        } else if (!repo.objects.has(cmd.newOid)) result = 'unable to read object';
        else {
          const type = repo.objects.get(cmd.newOid)!.type;
          if (type !== 'commit' && type !== 'tag') result = 'not a commit';
          else if (type === 'commit' && !isDescendantOrSelf(cmd.newOid, current, lookup)) result = 'non-fast-forward';
          else repo.refs.set(cmd.ref, cmd.newOid);
        }
      }
    }
    lines.push(pktLine(result === null ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${result}\n`));
  }
  lines.push(PKT_FLUSH);
  const report = Buffer.concat(lines);
  const band1 = pktLine(Buffer.concat([Buffer.from([1]), report]));
  const out = Buffer.concat([band1, PKT_FLUSH]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: out };
}

export { parseTag };
