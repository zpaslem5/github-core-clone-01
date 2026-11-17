// Minimal GraphQL v4: a small parser for the exact documents the suite sends, plus an
// executor over the shared store. Batching (array bodies) is supported.
import {
  findRepo,
  createIssue,
  createPull,
  mergePull,
  pullConflicts,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  decodeGlobalId,
  type Repo,
  type Issue,
  type Pull,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

export interface Selection {
  field: string;
  alias: string;
  args: Record<string, GqlValue>;
  selections: Selection[];
  fragmentType: string | null;
}

export interface Operation {
  kind: 'query' | 'mutation';
  name: string;
  selections: Selection[];
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
    const t = this.tokens[this.pos] as Token;
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected name');
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t !== undefined && t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name = '';
    const nt = this.peek();
    if (nt !== undefined && nt.kind === 'name') name = this.next().value;
    // Variable definitions: ($x: Type, ...) — skip their contents.
    const vt = this.peek();
    if (vt !== undefined && vt.kind === 'punct' && vt.value === '(') {
      let depth = 0;
      do {
        const tok = this.next();
        if (tok.kind === 'punct' && tok.value === '(') depth += 1;
        if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
      } while (depth > 0);
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (true) {
      const t = this.peek();
      if (t === undefined) throw new Error('unterminated selection set');
      if (t.kind === 'punct' && t.value === '}') {
        this.next();
        break;
      }
      out.push(this.parseField());
    }
    return out;
  }

  private parseField(): Selection {
    const t = this.peek();
    if (t !== undefined && t.kind === 'punct' && t.value === '...') {
      this.next();
      let fragmentType: string | null = null;
      const nt = this.peek();
      if (nt !== undefined && nt.kind === 'name' && nt.value === 'on') {
        this.next();
        fragmentType = this.expectName();
      }
      const selections = this.parseSelectionSet();
      return { field: '', alias: '', args: {}, selections, fragmentType };
    }
    const first = this.expectName();
    let field = first;
    let alias = first;
    const ct = this.peek();
    if (ct !== undefined && ct.kind === 'punct' && ct.value === ':') {
      this.next();
      field = this.expectName();
      alias = first;
    }
    const args: Record<string, GqlValue> = {};
    const at = this.peek();
    if (at !== undefined && at.kind === 'punct' && at.value === '(') {
      this.next();
      while (true) {
        const pt = this.peek();
        if (pt === undefined) throw new Error('unterminated args');
        if (pt.kind === 'punct' && pt.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    let selections: Selection[] = [];
    const st = this.peek();
    if (st !== undefined && st.kind === 'punct' && st.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { field, alias, args, selections, fragmentType: null };
  }

  private parseValue(): GqlValue {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: GqlValue[] = [];
      while (true) {
        const pt = this.peek();
        if (pt === undefined) throw new Error('unterminated list');
        if (pt.kind === 'punct' && pt.value === ']') {
          this.next();
          break;
        }
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (true) {
        const pt = this.peek();
        if (pt === undefined) throw new Error('unterminated object');
        if (pt.kind === 'punct' && pt.value === '}') {
          this.next();
          break;
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'literal', value: t.value };
    if (t.kind === 'int') return { kind: 'literal', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('unexpected value token');
  }
}

function resolveValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  if (v.kind === 'var') return variables[v.name] ?? null;
  if (v.kind === 'literal') return v.value;
  if (v.kind === 'enum') return v.value;
  if (v.kind === 'list') return v.items.map((i) => resolveValue(i, variables));
  if (v.kind === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v.fields)) out[k] = resolveValue(val, variables);
    return out;
  }
  return null;
}

// ---------------------------------------------------------------- executor

interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: GqlError[];
}

interface Typed {
  type: string;
  value: unknown;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'assignees', 'closedAt'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'author', 'additions', 'deletions', 'changedFiles'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'forkCount', 'stargazerCount'];
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function fieldError(ctx: Ctx, type: string, field: string, path: (string | number)[]): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${type}".`, path });
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    if (m !== null) return Number(m[1]);
  } catch {
    return -1;
  }
  return -1;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveSelections(ctx: Ctx, typed: Typed, selections: Selection[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.fragmentType !== null) {
      if (sel.fragmentType !== typed.type) continue;
      Object.assign(out, resolveSelections(ctx, typed, sel.selections, path));
      continue;
    }
    const fieldPath = [...path, sel.alias];
    const value = resolveField(ctx, typed, sel, fieldPath);
    if (value === undefined) continue;
    out[sel.alias] = value;
  }
  return out;
}

function resolveField(ctx: Ctx, typed: Typed, sel: Selection, path: (string | number)[]): unknown {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, ctx.variables);
  const store = ctx.store;

  if (typed.type === 'Query') {
    if (sel.field === 'viewer') {
      return resolveSelections(ctx, { type: 'User', value: store.scenario.viewer }, sel.selections, path);
    }
    if (sel.field === 'repository') {
      const repo = findRepo(store, String(args.owner ?? ''), String(args.name ?? ''));
      if (repo === undefined) return null;
      return resolveSelections(ctx, { type: 'Repository', value: repo }, sel.selections, path);
    }
    if (sel.field === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      const [owner, name, rest] = decoded.key.split('/');
      const repo = findRepo(store, owner ?? '', name ?? '');
      if (repo === undefined) return null;
      if (decoded.kind === 'repo') {
        return resolveSelections(ctx, { type: 'Repository', value: repo }, sel.selections, path);
      }
      if (decoded.kind === 'issue' && rest !== undefined) {
        const issue = repo.issues.get(Number(rest));
        if (issue === undefined) return null;
        return resolveSelections(ctx, { type: 'Issue', value: { repo, issue } }, sel.selections, path);
      }
      if (decoded.kind === 'pull' && rest !== undefined) {
        const pull = repo.pulls.get(Number(rest));
        if (pull === undefined) return null;
        return resolveSelections(ctx, { type: 'PullRequest', value: { repo, pull } }, sel.selections, path);
      }
      return null;
    }
    if (sel.field === '__type') {
      const name = String(args.name ?? '');
      return resolveSelections(ctx, { type: '__Type', value: name }, sel.selections, path);
    }
    fieldError(ctx, 'Query', sel.field, path);
    return null;
  }

  if (typed.type === 'Mutation') {
    if (sel.field === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'repo') {
        ctx.errors.push({ message: 'repositoryId is not a repository', path });
        return null;
      }
      const [owner, name] = decoded.key.split('/');
      const repo = findRepo(store, owner ?? '', name ?? '');
      if (repo === undefined) {
        ctx.errors.push({ message: 'repository not found', path });
        return null;
      }
      const issue = createIssue(store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return resolveSelections(ctx, { type: 'CreateIssuePayload', value: { repo, issue } }, sel.selections, path);
    }
    if (sel.field === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'issue') {
        ctx.errors.push({ message: 'issueId is not an issue', path });
        return null;
      }
      const [owner, name, num] = decoded.key.split('/');
      const repo = findRepo(store, owner ?? '', name ?? '');
      const issue = repo?.issues.get(Number(num));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'issue not found', path });
        return null;
      }
      issue.state = 'closed';
      return resolveSelections(ctx, { type: 'CloseIssuePayload', value: { repo, issue } }, sel.selections, path);
    }
    if (sel.field === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'repo') {
        ctx.errors.push({ message: 'repositoryId is not a repository', path });
        return null;
      }
      const [owner, name] = decoded.key.split('/');
      const repo = findRepo(store, owner ?? '', name ?? '');
      if (repo === undefined) {
        ctx.errors.push({ message: 'repository not found', path });
        return null;
      }
      const pull = createPull(store, repo, String(input.title ?? ''), '', String(input.headRefName ?? ''), String(input.baseRefName ?? 'main'));
      if (pull === null) {
        ctx.errors.push({ message: 'head or base branch does not exist', path });
        return null;
      }
      return resolveSelections(ctx, { type: 'CreatePullRequestPayload', value: { repo, pull } }, sel.selections, path);
    }
    if (sel.field === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'pull') {
        ctx.errors.push({ message: 'pullRequestId is not a pull request', path });
        return null;
      }
      const [owner, name, num] = decoded.key.split('/');
      const repo = findRepo(store, owner ?? '', name ?? '');
      const pull = repo?.pulls.get(Number(num));
      if (repo === undefined || pull === undefined) {
        ctx.errors.push({ message: 'pull request not found', path });
        return null;
      }
      mergePull(store, repo, pull);
      return resolveSelections(ctx, { type: 'MergePullRequestPayload', value: { repo, pull } }, sel.selections, path);
    }
    if (sel.field === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'issue') {
        ctx.errors.push({ message: 'subjectId is not an issue', path });
        return null;
      }
      const [owner, name, num] = decoded.key.split('/');
      const repo = findRepo(store, owner ?? '', name ?? '');
      const issue = repo?.issues.get(Number(num));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'issue not found', path });
        return null;
      }
      const comment = { id: repo.nextCommentId, body: String(input.body ?? '') };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return resolveSelections(
        ctx,
        { type: 'AddCommentPayload', value: { repo, issue, comment } },
        sel.selections,
        path,
      );
    }
    fieldError(ctx, 'Mutation', sel.field, path);
    return null;
  }

  if (typed.type === 'User') {
    const user = typed.value as { login: string };
    if (sel.field === 'login') return user.login;
    fieldError(ctx, 'User', sel.field, path);
    return null;
  }

  if (typed.type === 'Repository') {
    const repo = typed.value as Repo;
    switch (sel.field) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return resolveSelections(ctx, { type: 'User', value: { login: repo.owner } }, sel.selections, path);
      case 'defaultBranchRef':
        return resolveSelections(ctx, { type: 'Ref', value: { name: repo.defaultBranch } }, sel.selections, path);
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number ?? 0));
        if (issue === undefined) return null;
        return resolveSelections(ctx, { type: 'Issue', value: { repo, issue } }, sel.selections, path);
      }
      case 'issues': {
        let list = repo.issueOrder.map((n) => repo.issues.get(n) as Issue);
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states !== null) {
          const want = new Set(states.map((s) => String(s).toUpperCase()));
          list = list.filter((i) => want.has(issueState(i)));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
        list = [...list].sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
        const first = Number(args.first ?? 10);
        const afterIdx = decodeCursor(args.after as string | null | undefined);
        const page = list.slice(afterIdx + 1, afterIdx + 1 + first);
        const nodeSels = sel.selections.find((s) => s.field === 'nodes');
        const pageInfoSel = sel.selections.find((s) => s.field === 'pageInfo');
        const resolvedNodes = page.map((issue) =>
          nodeSels === undefined ? {} : resolveSelections(ctx, { type: 'Issue', value: { repo, issue } }, nodeSels.selections, path),
        );
        const endIndex = afterIdx + page.length;
        const pageInfo =
          pageInfoSel === undefined
            ? undefined
            : {
                hasNextPage: page.length > 0 ? endIndex < list.length - 1 : false,
                endCursor: page.length === 0 ? null : encodeCursor(endIndex),
              };
        const out: Record<string, unknown> = {};
        if (nodeSels !== undefined) out.nodes = resolvedNodes;
        if (pageInfoSel !== undefined) out.pageInfo = pageInfo;
        return out;
      }
      case 'pullRequests': {
        const first = Number(args.first ?? 10);
        const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number).slice(0, first);
        const nodeSels = sel.selections.find((s) => s.field === 'nodes');
        const nodes = list.map((pull) =>
          nodeSels === undefined ? {} : resolveSelections(ctx, { type: 'PullRequest', value: { repo, pull } }, nodeSels.selections, path),
        );
        return { nodes };
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number ?? 0));
        if (pull === undefined) return null;
        return resolveSelections(ctx, { type: 'PullRequest', value: { repo, pull } }, sel.selections, path);
      }
      default:
        fieldError(ctx, 'Repository', sel.field, path);
        return null;
    }
  }

  if (typed.type === 'Issue') {
    const { repo, issue } = typed.value as { repo: Repo; issue: Issue };
    switch (sel.field) {
      case 'id':
        return issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueState(issue);
      case 'body':
        return issue.body;
      default:
        fieldError(ctx, 'Issue', sel.field, path);
        return null;
    }
  }

  if (typed.type === 'PullRequest') {
    const { repo, pull } = typed.value as { repo: Repo; pull: Pull };
    switch (sel.field) {
      case 'id':
        return pullGlobalId(repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable': {
        if (pull.state !== 'open') return 'UNKNOWN';
        return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'files': {
        const first = Number(args.first ?? 10);
        const nodes = pull.files.slice(0, first).map((f) => ({ path: f.filename }));
        return { nodes };
      }
      default:
        fieldError(ctx, 'PullRequest', sel.field, path);
        return null;
    }
  }

  if (typed.type === 'Ref') {
    const ref = typed.value as { name: string };
    if (sel.field === 'name') return ref.name;
    fieldError(ctx, 'Ref', sel.field, path);
    return null;
  }

  if (typed.type === '__Type') {
    const name = typed.value as string;
    if (sel.field === 'fields') {
      const fields = name === 'Issue' ? ISSUE_FIELDS : name === 'PullRequest' ? PULL_FIELDS : name === 'Repository' ? REPO_FIELDS : [];
      return fields.map((f) => ({ name: f }));
    }
    if (sel.field === 'enumValues') {
      if (name === 'SearchType') return SEARCH_ENUM.map((f) => ({ name: f }));
      return [];
    }
    if (sel.field === 'name') return name;
    fieldError(ctx, '__Type', sel.field, path);
    return null;
  }

  if (typed.type === 'CreateIssuePayload' || typed.type === 'CloseIssuePayload') {
    const { repo, issue } = typed.value as { repo: Repo; issue: Issue };
    if (sel.field === 'issue') {
      return resolveSelections(ctx, { type: 'Issue', value: { repo, issue } }, sel.selections, path);
    }
    fieldError(ctx, typed.type, sel.field, path);
    return null;
  }

  if (typed.type === 'CreatePullRequestPayload' || typed.type === 'MergePullRequestPayload') {
    const { repo, pull } = typed.value as { repo: Repo; pull: Pull };
    if (sel.field === 'pullRequest') {
      return resolveSelections(ctx, { type: 'PullRequest', value: { repo, pull } }, sel.selections, path);
    }
    fieldError(ctx, typed.type, sel.field, path);
    return null;
  }

  if (typed.type === 'AddCommentPayload') {
    const { comment } = typed.value as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
    if (sel.field === 'commentEdge') {
      const edgeSel = sel.selections.find((s) => s.field === 'node');
      if (edgeSel === undefined) return {};
      const node: Record<string, unknown> = {};
      for (const ns of edgeSel.selections) {
        if (ns.field === 'id') node.id = Buffer.from(`comment:${comment.id}`, 'utf8').toString('base64url');
        else if (ns.field === 'body') node.body = comment.body;
        else fieldError(ctx, 'IssueComment', ns.field, [...path, 'node', ns.alias]);
      }
      return { node };
    }
    fieldError(ctx, 'AddCommentPayload', sel.field, path);
    return null;
  }

  fieldError(ctx, typed.type, sel.field, path);
  return null;
}

// Fix Issue.id resolution: it needs the repo, which resolveField for Issue receives via typed.value.
export function runGraphQL(store: Store, body: unknown): unknown {
  const runOne = (doc: unknown): Record<string, unknown> => {
    const ctx: Ctx = { store, variables: {}, errors: [] };
    try {
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('bad document');
      const query = (doc as Record<string, unknown>).query;
      if (typeof query !== 'string') throw new Error('missing query');
      const variables = (doc as Record<string, unknown>).variables;
      if (variables !== null && typeof variables === 'object' && !Array.isArray(variables)) {
        ctx.variables = variables as Record<string, unknown>;
      }
      const ops = new Parser(tokenize(query)).parseDocument();
      if (ops.length === 0) throw new Error('empty document');
      const op = ops[0] as Operation;
      const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
      const data = resolveSelections(ctx, { type: rootType, value: null }, op.selections, []);
      const envelope: Record<string, unknown> = { data };
      if (ctx.errors.length > 0) envelope.errors = ctx.errors;
      return envelope;
    } catch (err) {
      return {
        data: null,
        errors: [{ message: err instanceof Error ? err.message : String(err) }],
      };
    }
  };
  if (Array.isArray(body)) return body.map((doc) => runOne(doc));
  return runOne(body);
}
