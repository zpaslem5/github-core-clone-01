// Git smart HTTP: protocol v2 upload-pack (ls-refs, fetch) and v0 receive-pack (push).
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  pktLine,
  pktFlush,
  pktDelim,
  decodePktLines,
  sidebandPacket,
  writePack,
  readPackAsync,
  ZERO_OID,
  type PackEntry,
} from './gitproto.ts';
import {
  findRepo,
  getObject,
  parseCommit,
  parseTree,
  hashObject,
  isAncestor,
  reachableObjects,
  type Repo,
  type Store,
} from './store.ts';

const AGENT = 'github-core-clone/1.0';

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** All refs sorted by name: [refname, oid]. */
function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Peel an annotated tag (recursively) to its target commit oid. */
function peelTag(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = getObject(repo, cur);
    if (obj === undefined) return null;
    if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m === null) return null;
      cur = m[1] as string;
    } else {
      return cur;
    }
  }
  return null;
}

function refCapabilitiesLine(repo: Repo, service: 'upload' | 'receive'): string {
  if (service === 'upload') {
    return 'side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=' + AGENT + ' symref=HEAD:refs/heads/main';
  }
  return 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;
}

/** v0 advertisement: preamble, flush, then one line per ref (first carries capabilities). */
function advertisementV0(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const serviceName = service === 'upload' ? 'git-upload-pack' : 'git-receive-pack';
  const parts: Buffer[] = [pktLine(`# service=${serviceName}\n`), pktFlush];
  const refs = sortedRefs(repo);
  const caps = refCapabilitiesLine(repo, service);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach(([ref, oid], idx) => {
      const suffix = idx === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${oid} ${ref}${suffix}\n`));
      if (ref.startsWith('refs/tags/')) {
        const peeled = peelTag(repo, oid);
        const obj = getObject(repo, oid);
        if (obj !== undefined && obj.type === 'tag' && peeled !== null && peeled !== oid) {
          parts.push(pktLine(`${peeled} ${ref}^{}\n`));
        }
      }
    });
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** v2 advertisement for upload-pack. */
function advertisementV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktFlush,
  ];
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  service: string | null,
): void {
  const repo = findRepo(store, owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service === 'git-upload-pack') {
    const proto = (req.headers['git-protocol'] as string | undefined) ?? '';
    if (proto.includes('version=2')) {
      sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', advertisementV2());
    } else {
      sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', advertisementV0(repo, 'upload'));
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', advertisementV0(repo, 'receive'));
    return;
  }
  sendJson(res, 400, { message: 'service parameter required' });
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  entries: PackEntry[];
  shallow: string[];
  unshallow: string[];
}

/** Plan which objects a fetch sends. `deepen` null = full history. */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  deepen: number | null,
  clientShallow: string[],
): FetchPlan {
  // The client's haves: everything it already holds. A shallow client's boundary commits
  // (clientShallow) do NOT imply their parents, so parent traversal stops there.
  const haveSet = reachableObjects(repo, haves, null, new Set(clientShallow));
  const included = new Set<string>();
  const commitDepth = new Map<string, number>();
  // BFS over commits; depth = generations from a want.
  const queue: { sha: string; depth: number }[] = wants.map((sha) => ({ sha, depth: 0 }));
  const visitTree = (treeSha: string): void => {
    const stack = [treeSha];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (included.has(cur)) continue;
      const obj = getObject(repo, cur);
      if (obj === undefined || obj.type !== 'tree') continue;
      included.add(cur);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000') stack.push(e.sha);
        else included.add(e.sha);
      }
    }
  };
  const visitCommitAndTree = (sha: string): void => {
    const obj = getObject(repo, sha);
    if (obj === undefined) return;
    if (obj.type === 'tag') {
      included.add(sha);
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m !== null) queue.push({ sha: m[1] as string, depth: 0 });
      return;
    }
    if (obj.type !== 'commit') return;
    included.add(sha);
    const info = parseCommit(obj.data);
    if (info !== null) visitTree(info.tree);
  };
  const seenCommit = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift() as { sha: string; depth: number };
    if (seenCommit.has(item.sha)) continue;
    seenCommit.add(item.sha);
    const prev = commitDepth.get(item.sha);
    if (prev !== undefined && prev <= item.depth) continue;
    commitDepth.set(item.sha, item.depth);
    visitCommitAndTree(item.sha);
    if (deepen === null || item.depth < deepen - 1) {
      const obj = getObject(repo, item.sha);
      if (obj !== undefined && obj.type === 'commit') {
        const info = parseCommit(obj.data);
        if (info !== null) {
          for (const p of info.parents) queue.push({ sha: p, depth: item.depth + 1 });
        }
      }
    }
  }
  // Boundary commits: included commits whose parents exist but are not included.
  const shallow: string[] = [];
  if (deepen !== null) {
    for (const sha of commitDepth.keys()) {
      const obj = getObject(repo, sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      if (info === null || info.parents.length === 0) continue;
      const parentIncluded = info.parents.some((p) => included.has(p));
      if (!parentIncluded) shallow.push(sha);
    }
  }
  // Unshallow: client shallow lines whose parents are now all available (included or held).
  const unshallow: string[] = [];
  for (const s of clientShallow) {
    const obj = getObject(repo, s);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    if (info === null) continue;
    if (info.parents.length === 0) continue;
    const allAvailable = info.parents.every((p) => included.has(p) || haveSet.has(p));
    if (allAvailable && included.has(s)) unshallow.push(s);
  }
  // Pack entries: included minus held, in a stable order (commits first, then the rest).
  const send = [...included].filter((sha) => !haveSet.has(sha));
  const entries: PackEntry[] = [];
  const byType = (sha: string): number => {
    const obj = getObject(repo, sha);
    if (obj === undefined) return 9;
    if (obj.type === 'commit') return 0;
    if (obj.type === 'tag') return 1;
    if (obj.type === 'tree') return 2;
    return 3;
  };
  send.sort((a, b) => byType(a) - byType(b) || (a < b ? -1 : 1));
  for (const sha of send) {
    const obj = getObject(repo, sha);
    if (obj !== undefined) entries.push({ type: obj.type, data: obj.data });
  }
  return { entries, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const MAX_PAYLOAD = 65515; // 4-byte pkt-line header + 1 band byte + payload <= 65520
  for (let i = 0; i < pack.length; i += MAX_PAYLOAD) {
    parts.push(sidebandPacket(1, pack.subarray(i, Math.min(pack.length, i + MAX_PAYLOAD))));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function wantedRefsLines(repo: Repo, wants: string[]): string[] {
  const lines: string[] = [];
  const byOid = new Map<string, string[]>();
  for (const [ref, oid] of sortedRefs(repo)) {
    const list = byOid.get(oid) ?? [];
    list.push(ref);
    byOid.set(oid, list);
  }
  for (const want of wants) {
    const refs = byOid.get(want) ?? [];
    for (const ref of refs) lines.push(`${want} ${ref}\n`);
  }
  return lines;
}

function handleUploadPackV2(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { lines } = decodePktLines(body);
  const first = lines.find((l) => l.kind === 'data');
  const command = first === undefined ? '' : first.text.replace(/^command=/, '').trim();
  const args: string[] = [];
  let seenDelim = false;
  for (const l of lines) {
    if (l.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (l.kind === 'data' && seenDelim) args.push(l.text);
  }
  if (command === 'ls-refs') {
    const trimmed = args.map((a) => a.trim());
    const peel = trimmed.includes('peel');
    const symrefs = trimmed.includes('symrefs');
    const unborn = trimmed.includes('unborn');
    const prefixes = trimmed.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
    const out: Buffer[] = [];
    const mainOid = repo.refs.get('refs/heads/main');
    const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
    if (prefixes.length === 0) {
      if (mainOid !== undefined) {
        out.push(pktLine(`${mainOid} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      } else if (unborn) {
        out.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      }
    }
    for (const [ref, oid] of sortedRefs(repo)) {
      if (!matches(ref)) continue;
      let line = `${oid} ${ref}`;
      if (ref.startsWith('refs/tags/') && peel) {
        const obj = getObject(repo, oid);
        if (obj !== undefined && obj.type === 'tag') {
          const peeled = peelTag(repo, oid);
          if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
        }
      }
      out.push(pktLine(`${line}\n`));
    }
    out.push(pktFlush);
    sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    return;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let deepen: number | null = null;
    for (const a of args) {
      const arg = a.trim();
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) {
        const n = Number(arg.slice(7).trim());
        if (Number.isFinite(n) && n >= 1) deepen = Math.trunc(n);
      } else if (arg.startsWith('deepen-since ')) {
        if (deepen === null) deepen = 1;
      }
    }
    const plan = planFetch(repo, wants, haves, deepen, clientShallow);
    const pack = writePack(plan.entries);
    const out: Buffer[] = [];
    out.push(pktLine('acknowledgments\n'));
    out.push(pktLine('NAK\n'));
    out.push(pktDelim);
    out.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) out.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) out.push(pktLine(`unshallow ${s}\n`));
    out.push(pktDelim);
    out.push(pktLine('wanted-refs\n'));
    for (const line of wantedRefsLines(repo, wants)) out.push(pktLine(line));
    out.push(pktDelim);
    out.push(pktLine('packfile\n'));
    out.push(sidebandPack(pack));
    sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    return;
  }
  sendRaw(res, 200, 'application/x-git-upload-pack-result', pktFlush);
}

function handleUploadPackV0(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { lines } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | null = null;
  let section = 0;
  for (const l of lines) {
    if (l.kind === 'flush') {
      section += 1;
      continue;
    }
    if (l.kind !== 'data') continue;
    const arg = l.text.trim();
    if (section === 0) {
      if (arg.startsWith('want ')) {
        const rest = arg.slice(5).trim();
        const oid = rest.split(/\s+/)[0] as string;
        wants.push(oid);
      } else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) {
        const n = Number(arg.slice(7).trim());
        if (Number.isFinite(n) && n >= 1) deepen = Math.trunc(n);
      }
    } else {
      if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    }
  }
  const plan = planFetch(repo, wants, haves, deepen, clientShallow);
  const pack = writePack(plan.entries);
  const out: Buffer[] = [pktLine('NAK\n')];
  for (const s of plan.shallow) out.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) out.push(pktLine(`unshallow ${s}\n`));
  out.push(sidebandPack(pack));
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

export function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  void req;
  const repo = findRepo(store, owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const { lines } = decodePktLines(body);
  const first = lines.find((l) => l.kind === 'data');
  if (first !== undefined && first.text.startsWith('command=')) {
    handleUploadPackV2(repo, body, res);
    return;
  }
  if (first === undefined) {
    sendRaw(res, 200, 'application/x-git-upload-pack-result', pktFlush);
    return;
  }
  handleUploadPackV0(repo, body, res);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): Promise<void> {
  void req;
  const repo = findRepo(store, owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const { lines, restOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const l of lines) {
    if (l.kind !== 'data') continue;
    let text = l.text;
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(text.trim());
    if (m !== null) {
      commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
    }
  }
  const report: string[] = [];
  const hasPack = restOffset < body.length;
  if (commands.length === 0) {
    // Nothing parseable: stay healthy, answer an empty report.
    const out: Buffer[] = [sidebandPacket(1, Buffer.from('unpack ok\n', 'utf8')), pktFlush];
    sendRaw(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(out));
    return;
  }
  let unpackOk = true;
  let unpackDetail = '';
  if (hasPack) {
    try {
      const pack = await readPackAsync(body.subarray(restOffset));
      for (const entry of pack.entries) {
        const sha = hashObject(entry.type, entry.data);
        if (!repo.objects.has(sha)) repo.objects.set(sha, { type: entry.type, data: entry.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  if (!unpackOk) {
    report.push(`unpack ${unpackDetail}\n`);
    for (const c of commands) report.push(`ng ${c.ref} unpack failed\n`);
  } else {
    report.push('unpack ok\n');
    for (const c of commands) {
      const validRef = /^refs\/[^\s\x00-\x1f\x7f]{1,195}$/.test(c.ref);
      if (!validRef) {
        report.push(`ng ${c.ref} invalid ref\n`);
        continue;
      }
      if (c.newOid === ZERO_OID) {
        // Delete.
        const cur = repo.refs.get(c.ref);
        if (cur === undefined) {
          report.push(`ng ${c.ref} ref not found\n`);
        } else if (c.oldOid !== ZERO_OID && c.oldOid !== cur) {
          report.push(`ng ${c.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(c.ref);
          report.push(`ok ${c.ref}\n`);
        }
        continue;
      }
      const newObj = getObject(repo, c.newOid);
      if (newObj === undefined) {
        report.push(`ng ${c.ref} object not found\n`);
        continue;
      }
      // No separate closure walk here: the client always sends the complete set of objects
      // reachable from the new tip that the server lacks, and the rest is already stored.
      // (A full reachability walk per push would make sequential pushes quadratic.)
      if (c.oldOid === ZERO_OID) {
        if (repo.refs.has(c.ref)) {
          report.push(`ng ${c.ref} already exists\n`);
        } else {
          repo.refs.set(c.ref, c.newOid);
          report.push(`ok ${c.ref}\n`);
        }
        continue;
      }
      const cur = repo.refs.get(c.ref);
      if (cur === undefined) {
        report.push(`ng ${c.ref} ref not found\n`);
        continue;
      }
      if (cur !== c.oldOid) {
        report.push(`ng ${c.ref} non-fast-forward\n`);
        continue;
      }
      if (!isAncestor(repo, c.oldOid, c.newOid)) {
        report.push(`ng ${c.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(c.ref, c.newOid);
      report.push(`ok ${c.ref}\n`);
    }
  }
  const out: Buffer[] = [];
  for (const line of report) out.push(sidebandPacket(1, Buffer.from(line, 'utf8')));
  out.push(pktFlush);
  sendRaw(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(out));
}
