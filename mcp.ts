// Model Context Protocol (streamable HTTP) over the shared store: server/discover,
// initialize (legacy fallback), tools/list, tools/call with the six canonical tools.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createRepo,
  findRepo,
  createIssue,
  createPull,
  mergePull,
  pullConflicts,
  type Store,
} from './store.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | undefined {
  const norm = normalizeName(name);
  for (const tool of TOOLS) {
    if (normalizeName(tool.name) === norm) return tool;
    const aliases = ALIASES[tool.name] ?? [];
    if (aliases.some((a) => normalizeName(a) === norm)) return tool;
  }
  return undefined;
}

// Synonyms the suite may use for each semantic argument (normalized the same way).
const ARG_SYNONYMS: Record<string, string[]> = {
  name: ['name', 'repo', 'repository', 'repositoryname', 'reponame'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'isprivate'],
  owner: ['owner', 'ownerlogin', 'org', 'organization', 'organisation', 'user', 'userlogin', 'login', 'account', 'namespace', 'ownername'],
  repo: ['repo', 'repository', 'repositoryname', 'reponame', 'reposlug', 'project', 'projectname'],
  title: ['title', 'issuetitle', 'prtitle', 'pullrequesttitle', 'subject'],
  body: ['body', 'issuebody', 'description', 'content', 'text', 'comment'],
  state: ['state', 'status'],
  head: ['head', 'headref', 'headbranch', 'pullrequesthead', 'prhead', 'source', 'sourceref', 'sourcebranch', 'from', 'frombranch', 'branch'],
  base: ['base', 'baseref', 'basebranch', 'pullrequestbase', 'prbase', 'target', 'targetref', 'targetbranch', 'into', 'intobranch'],
  pull_number: ['pullnumber', 'pullrequestnumber', 'prnumber', 'number', 'issuenumber', 'index'],
};

function pickArg(args: Record<string, unknown>, semantic: string): unknown {
  const synonyms = ARG_SYNONYMS[semantic] ?? [semantic];
  for (const [key, value] of Object.entries(args)) {
    if (synonyms.includes(normalizeName(key))) return value;
  }
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolTextResult(structured: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  body: Buffer | null,
): void {
  if (req.method === 'DELETE') {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse((body ?? Buffer.alloc(0)).toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: 424242, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const msg = parsed as Record<string, unknown>;
  const id = (msg.id ?? null) as unknown;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Record<string, unknown>;
  // Notification: no response body beyond acknowledgement.
  if (id === null || id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return;
  }
  if (method === 'initialize') {
    const requested = (params.protocolVersion as string | undefined) ?? '';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = findTool(name);
    if (tool === undefined) {
      sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
      return;
    }
    const result = callTool(store, tool.name, args);
    sendJson(res, 200, rpcResult(id, result));
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoName = pickArg(args, 'name');
    if (typeof repoName !== 'string' || repoName === '') return toolErrorResult('missing required argument: name');
    const description = pickArg(args, 'description');
    const isPrivate = pickArg(args, 'private');
    const existing = findRepo(store, store.viewerLogin, repoName);
    const repo =
      existing ??
      createRepo(store, repoName, isPrivate === true, typeof description === 'string' ? description : '');
    const out = {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
    };
    return toolTextResult(out);
  }
  if (name === 'get_repo') {
    const owner = pickArg(args, 'owner');
    const repoName = pickArg(args, 'repo');
    if (typeof owner !== 'string' || typeof repoName !== 'string') return toolErrorResult('missing required argument: owner or repo');
    const repo = findRepo(store, owner, repoName);
    if (repo === undefined) return toolErrorResult(`repository not found: ${owner}/${repoName}`);
    return toolTextResult({
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
    });
  }
  if (name === 'create_issue') {
    const owner = pickArg(args, 'owner');
    const repoName = pickArg(args, 'repo');
    const title = pickArg(args, 'title');
    if (typeof owner !== 'string' || typeof repoName !== 'string' || typeof title !== 'string' || title === '') {
      return toolErrorResult('missing required argument: owner, repo, or title');
    }
    const repo = findRepo(store, owner, repoName);
    if (repo === undefined) return toolErrorResult(`repository not found: ${owner}/${repoName}`);
    const body = pickArg(args, 'body');
    const issue = createIssue(store, repo, title, typeof body === 'string' ? body : '', []);
    return toolTextResult({ number: issue.number, title: issue.title, body: issue.body, state: issue.state });
  }
  if (name === 'list_issues') {
    const owner = pickArg(args, 'owner');
    const repoName = pickArg(args, 'repo');
    if (typeof owner !== 'string' || typeof repoName !== 'string') return toolErrorResult('missing required argument: owner or repo');
    const repo = findRepo(store, owner, repoName);
    if (repo === undefined) return toolErrorResult(`repository not found: ${owner}/${repoName}`);
    const state = pickArg(args, 'state');
    let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    if (typeof state === 'string' && state !== 'all') list = list.filter((i) => i.state === state);
    const out = {
      issues: list.map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state })),
    };
    return toolTextResult(out);
  }
  if (name === 'create_pull_request') {
    const owner = pickArg(args, 'owner');
    const repoName = pickArg(args, 'repo');
    const title = pickArg(args, 'title');
    const head = pickArg(args, 'head');
    const base = pickArg(args, 'base');
    if (
      typeof owner !== 'string' ||
      typeof repoName !== 'string' ||
      typeof title !== 'string' ||
      typeof head !== 'string' ||
      typeof base !== 'string'
    ) {
      return toolErrorResult('missing required argument: owner, repo, title, head, or base');
    }
    const repo = findRepo(store, owner, repoName);
    if (repo === undefined) return toolErrorResult(`repository not found: ${owner}/${repoName}`);
    const body = pickArg(args, 'body');
    const pull = createPull(store, repo, title, typeof body === 'string' ? body : '', head, base);
    if (pull === null) return toolErrorResult('head or base branch does not exist');
    return toolTextResult({
      number: pull.number,
      pull_number: pull.number,
      pull_request_number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
    });
  }
  if (name === 'merge_pull_request') {
    const owner = pickArg(args, 'owner');
    const repoName = pickArg(args, 'repo');
    const numRaw = pickArg(args, 'pull_number');
    if (typeof owner !== 'string' || typeof repoName !== 'string' || numRaw === undefined) {
      return toolErrorResult('missing required argument: owner, repo, or pull_number');
    }
    const repo = findRepo(store, owner, repoName);
    if (repo === undefined) return toolErrorResult(`repository not found: ${owner}/${repoName}`);
    const pull = repo.pulls.get(Number(numRaw));
    if (pull === undefined) return toolErrorResult(`pull request not found: ${String(numRaw)}`);
    if (pull.state !== 'open') return toolErrorResult('pull request is not open');
    if (pullConflicts(repo, pull)) return toolErrorResult('merge conflict');
    const outcome = mergePull(store, repo, pull);
    if (!outcome.ok || outcome.sha === null) return toolErrorResult('merge failed');
    return toolTextResult({ number: pull.number, merged: true, sha: outcome.sha, state: pull.state });
  }
  return toolErrorResult(`Unknown tool: ${name}`);
}
