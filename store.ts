// Shared in-memory store for the forge: repos, git objects, refs, issues, pulls.
// One state for REST v3, GraphQL v4, MCP and git smart HTTP. No disk, no network.
import { createHash } from 'node:crypto';
import { buildScenario, type Scenario } from './scenario.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string }[];
  createdSeq: number;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
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
  baseTipAtCreate: string;
  files: PullFile[];
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  issueOrder: number[];
  nextIssue: number;
  nextCommentId: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  labels: Map<string, { name: string; color: string }>;
  createdSeq: number;
}

export interface Store {
  scenario: Scenario;
  viewerLogin: string;
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextObjectId: number;
  seq: number;
  ts: number;
  reqSeq: number;
}

export function createStore(): Store {
  const scenario = buildScenario();
  return {
    scenario,
    viewerLogin: scenario.viewer.login,
    repos: new Map<string, Repo>(),
    nextRepoId: 5000,
    nextObjectId: 100000,
    seq: 0,
    ts: 1735689600,
    reqSeq: 0,
  };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function nextTs(store: Store): number {
  store.ts += 1;
  return store.ts;
}

export function nextSeq(store: Store): number {
  store.seq += 1;
  return store.seq;
}

// ---------------------------------------------------------------- git objects

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function getObject(repo: Repo, sha: string): GitObject | undefined {
  return repo.objects.get(sha.toLowerCase());
}

/** Compare two tree entry names the way git does (dirs sort as if named with '/'). */
function treeNameCmp(a: string, aIsDir: boolean, b: string, bIsDir: boolean): number {
  const an = aIsDir ? `${a}/` : a;
  const bn = bIsDir ? `${b}/` : b;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export function makeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((x, y) => treeNameCmp(x.name, x.mode === '40000', y.name, y.mode === '40000'));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'ascii'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = data.indexOf(0, sp);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  ts: number;
  message: string;
}

export function makeCommit(c: CommitInfo): Buffer {
  let out = `tree ${c.tree}\n`;
  for (const p of c.parents) out += `parent ${p}\n`;
  out += `author ${c.authorName} <${c.authorEmail}> ${c.ts} +0000\n`;
  out += `committer ${c.authorName} <${c.authorEmail}> ${c.ts} +0000\n`;
  out += `\n${c.message.endsWith('\n') ? c.message : `${c.message}\n`}`;
  return Buffer.from(out, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo | null {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  if (blank < 0) return null;
  const head = text.slice(0, blank);
  const message = text.slice(blank + 2).replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let authorName = '';
  let authorEmail = '';
  let ts = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = /^author (.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
      if (m) {
        authorName = m[1] ?? '';
        authorEmail = m[2] ?? '';
        ts = Number(m[3] ?? 0);
      }
    }
  }
  if (tree === '') return null;
  return { tree, parents, authorName, authorEmail, ts, message };
}

// ---------------------------------------------------------------- repo helpers

export function createRepo(store: Store, name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    id: store.nextRepoId,
    owner: store.viewerLogin,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    refs: new Map<string, string>(),
    objects: new Map<string, GitObject>(),
    issues: new Map<number, Issue>(),
    issueOrder: [],
    nextIssue: 1,
    nextCommentId: 1,
    pulls: new Map<number, Pull>(),
    nextPull: 1,
    labels: new Map<string, { name: string; color: string }>(),
    createdSeq: nextSeq(store),
  };
  store.nextRepoId += 1;
  for (const label of store.scenario.labels) repo.labels.set(label, { name: label, color: 'ededed' });
  store.repos.set(repoKey(repo.owner, repo.name), repo);
  return repo;
}

export function findRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

export function headTip(repo: Repo): string | undefined {
  return repo.refs.get(headRefName(repo));
}

// ---------------------------------------------------------------- files via trees

/** All files at a commit: path -> { blobSha, content }. */
export function filesAtCommit(repo: Repo, commitSha: string): Map<string, { blobSha: string; content: Buffer }> {
  const out = new Map<string, { blobSha: string; content: Buffer }>();
  const obj = getObject(repo, commitSha);
  if (obj === undefined || obj.type !== 'commit') return out;
  const info = parseCommit(obj.data);
  if (info === null) return out;
  const walk = (treeSha: string, prefix: string): void => {
    const tree = getObject(repo, treeSha);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const e of parseTree(tree.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.sha, path);
      else {
        const blob = getObject(repo, e.sha);
        if (blob !== undefined && blob.type === 'blob') out.set(path, { blobSha: e.sha, content: blob.data });
      }
    }
  };
  walk(info.tree, '');
  return out;
}

export function treeAtCommit(repo: Repo, commitSha: string): string | null {
  const obj = getObject(repo, commitSha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  return info === null ? null : info.tree;
}

/** Build a new tree from a base tree with one file set (or removed when content is null). */
export function treeWithFile(repo: Repo, baseTreeSha: string | null, path: string, content: Buffer | null): string {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) return baseTreeSha ?? storeObject(repo, 'tree', Buffer.alloc(0));
  const build = (treeSha: string | null, depth: number): string => {
    const entries: TreeEntry[] = [];
    if (treeSha !== null) {
      const tree = getObject(repo, treeSha);
      if (tree !== undefined && tree.type === 'tree') entries.push(...parseTree(tree.data));
    }
    const seg = segments[depth] as string;
    const isLast = depth === segments.length - 1;
    if (isLast) {
      const idx = entries.findIndex((e) => e.name === seg);
      if (content === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else {
        const blobSha = storeObject(repo, 'blob', content);
        if (idx >= 0) entries[idx] = { mode: '100644', name: seg, sha: blobSha };
        else entries.push({ mode: '100644', name: seg, sha: blobSha });
      }
    } else {
      const idx = entries.findIndex((e) => e.name === seg);
      const childSha = idx >= 0 && entries[idx]?.mode === '40000' ? (entries[idx] as TreeEntry).sha : null;
      const newChild = build(childSha, depth + 1);
      if (idx >= 0) entries[idx] = { mode: '40000', name: seg, sha: newChild };
      else entries.push({ mode: '40000', name: seg, sha: newChild });
    }
    return storeObject(repo, 'tree', makeTree(entries));
  };
  return build(baseTreeSha, 0);
}

export interface CommitResult {
  commitSha: string;
  blobSha: string | null;
}

/** Create a commit on a branch that sets (or deletes) one file. Branch is created if missing. */
export function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): CommitResult {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const baseTree = tip !== undefined ? treeAtCommit(repo, tip) : null;
  const newTree = treeWithFile(repo, baseTree, path, content);
  const parents = tip !== undefined ? [tip] : [];
  const viewer = store.scenario.viewer;
  const commitSha = storeObject(
    repo,
    'commit',
    makeCommit({
      tree: newTree,
      parents,
      authorName: viewer.name,
      authorEmail: viewer.email,
      ts: nextTs(store),
      message,
    }),
  );
  repo.refs.set(ref, commitSha);
  let blobSha: string | null = null;
  if (content !== null) blobSha = hashObject('blob', content);
  return { commitSha, blobSha };
}

export function getFileAtRef(
  repo: Repo,
  ref: string,
  path: string,
): { blobSha: string; content: Buffer } | undefined {
  const tip = repo.refs.get(ref);
  if (tip === undefined) return undefined;
  return filesAtCommit(repo, tip).get(path);
}

/** Directory listing at a ref: entries under dirPath ('' = root). */
export function listDirAtRef(
  repo: Repo,
  ref: string,
  dirPath: string,
): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] | null {
  const tip = repo.refs.get(ref);
  if (tip === undefined) return null;
  const treeSha = treeAtCommit(repo, tip);
  if (treeSha === null) return null;
  let cur = treeSha;
  if (dirPath !== '') {
    for (const seg of dirPath.split('/').filter((s) => s !== '')) {
      const tree = getObject(repo, cur);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((e) => e.name === seg && e.mode === '40000');
      if (entry === undefined) return null;
      cur = entry.sha;
    }
  }
  const tree = getObject(repo, cur);
  if (tree === undefined || tree.type !== 'tree') return null;
  const out: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] = [];
  for (const e of parseTree(tree.data)) {
    const path = dirPath === '' ? e.name : `${dirPath}/${e.name}`;
    out.push({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path, sha: e.sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** First-parent walk from a tip, newest first. */
export function walkCommits(repo: Repo, tip: string): { sha: string; info: CommitInfo }[] {
  const out: { sha: string; info: CommitInfo }[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = tip;
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (obj === undefined || obj.type !== 'commit') break;
    const info = parseCommit(obj.data);
    if (info === null) break;
    out.push({ sha: cur, info });
    cur = info.parents[0];
  }
  return out;
}

/** Is `ancestor` an ancestor of (or equal to) `tip`? */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    if (info === null) continue;
    for (const p of info.parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** All object shas reachable from a set of tips (commits, trees, blobs, tags).
 *  `stopParentsAt`: commits whose parents are NOT followed (a shallow client's boundary). */
export function reachableObjects(repo: Repo, tips: string[], maxDepth: number | null, stopParentsAt: Set<string> | null = null): Set<string> {
  const out = new Set<string>();
  const queue: { sha: string; depth: number }[] = tips.map((sha) => ({ sha, depth: 0 }));
  while (queue.length > 0) {
    const item = queue.shift() as { sha: string; depth: number };
    if (out.has(item.sha)) continue;
    const obj = getObject(repo, item.sha);
    if (obj === undefined) continue;
    out.add(item.sha);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      if (info === null) continue;
      queue.push({ sha: info.tree, depth: item.depth });
      const stopHere = stopParentsAt !== null && stopParentsAt.has(item.sha);
      if (!stopHere && (maxDepth === null || item.depth < maxDepth)) {
        for (const p of info.parents) queue.push({ sha: p, depth: item.depth + 1 });
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push({ sha: e.sha, depth: item.depth });
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) queue.push({ sha: m[1] as string, depth: item.depth });
    }
  }
  return out;
}

// ---------------------------------------------------------------- issues & pulls

export function createIssue(store: Store, repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    id: store.nextObjectId,
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: nextSeq(store),
  };
  repo.nextIssue += 1;
  store.nextObjectId += 1;
  repo.issues.set(issue.number, issue);
  repo.issueOrder.push(issue.number);
  return issue;
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  const text = content.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

export function diffFiles(
  repo: Repo,
  baseTip: string,
  headTip: string,
): PullFile[] {
  const baseFiles = filesAtCommit(repo, baseTip);
  const headFiles = filesAtCommit(repo, headTip);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b !== undefined && h !== undefined && b.blobSha === h.blobSha) continue;
    if (b === undefined && h !== undefined) {
      const additions = countLines(h.content);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const deletions = countLines(b.content);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const additions = countLines(h.content);
      const deletions = countLines(b.content);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

export function createPull(store: Store, repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const pull: Pull = {
    id: store.nextObjectId,
    number: repo.nextPull,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    baseTipAtCreate: baseSha,
    files: diffFiles(repo, baseSha, headSha),
  };
  repo.nextPull += 1;
  store.nextObjectId += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

/** 3-way conflict? True when base moved since PR creation and head differs from both. */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return false;
  if (baseTip === pull.baseTipAtCreate) return false;
  const baseAtCreate = filesAtCommit(repo, pull.baseTipAtCreate);
  const baseNow = filesAtCommit(repo, baseTip);
  const headFiles = filesAtCommit(repo, pull.headSha);
  for (const file of pull.files) {
    const path = file.filename;
    const atCreate = baseAtCreate.get(path);
    const now = baseNow.get(path);
    const head = headFiles.get(path);
    const createSha = atCreate?.blobSha ?? null;
    const nowSha = now?.blobSha ?? null;
    const headSha = head?.blobSha ?? null;
    if (nowSha !== createSha && headSha !== createSha && nowSha !== headSha) return true;
  }
  return false;
}

export interface MergeOutcome {
  ok: boolean;
  sha: string | null;
  conflict: boolean;
}

/** Squash-merge a PR onto its base branch. */
export function mergePull(store: Store, repo: Repo, pull: Pull): MergeOutcome {
  if (pull.state !== 'open') return { ok: false, sha: null, conflict: false };
  if (pullConflicts(repo, pull)) return { ok: false, sha: null, conflict: true };
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTip = repo.refs.get(baseRef);
  if (baseTip === undefined) return { ok: false, sha: null, conflict: false };
  let treeSha = treeAtCommit(repo, baseTip);
  const headFiles = filesAtCommit(repo, pull.headSha);
  for (const file of pull.files) {
    const head = headFiles.get(file.filename);
    treeSha = treeWithFile(repo, treeSha, file.filename, head === undefined ? null : head.content);
  }
  const viewer = store.scenario.viewer;
  const ts = nextTs(store);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const mergeSha = storeObject(
    repo,
    'commit',
    makeCommit({
      tree: treeSha ?? storeObject(repo, 'tree', Buffer.alloc(0)),
      parents: [baseTip],
      authorName: viewer.name,
      authorEmail: viewer.email,
      ts,
      message,
    }),
  );
  repo.refs.set(baseRef, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date(ts * 1000).toISOString();
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  return { ok: true, sha: mergeSha, conflict: false };
}

// ---------------------------------------------------------------- global ids

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('repo', `${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('issue', `${repo.owner}/${repo.name}/${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('pull', `${repo.owner}/${repo.name}/${pull.number}`);
}
