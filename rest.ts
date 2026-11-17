// GitHub REST v3 surface: repos, contents, labels, issues, pulls, git refs, branches, commits.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createRepo,
  findRepo,
  repoKey,
  commitFile,
  getFileAtRef,
  listDirAtRef,
  walkCommits,
  createIssue,
  issueJson,
  createPull,
  pullJson,
  pullConflicts,
  mergePull,
  diffFiles,
  getObject,
  hashObject,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  reqSeq: () => string;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  ctx: RestContext,
  headers: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.reqSeq(),
    ...headers,
  });
  res.end(text);
}

function err(res: ServerResponse, ctx: RestContext, status: number, message: string): void {
  sendJson(res, status, { message }, ctx);
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

/** Split a path into segments, decoding each. */
function segments(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Buffer | null,
): Promise<void> {
  const store = ctx.store;
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const segs = segments(path);
  // path is /api/v3/... ; drop the first two segments.
  const rest = segs.slice(2);

  let jsonBody: Record<string, unknown> | null = null;
  if (body !== null && body.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        jsonBody = parsed as Record<string, unknown>;
      } else {
        jsonBody = {};
      }
    } catch {
      err(res, ctx, 400, 'Problems parsing JSON');
      return;
    }
  }
  const b = jsonBody ?? {};

  // GET /api/v3/ (root)
  if ((method === 'GET' && rest.length === 0) || (method === 'GET' && rest.length === 1 && rest[0] === '')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, ctx, {
      'x-oauth-scopes': 'repo, read:org',
    });
    return;
  }

  // GET /api/v3/meta
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true }, ctx);
    return;
  }

  // GET /api/v3/user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    const v = store.scenario.viewer;
    sendJson(res, 200, { login: v.login, id: v.id, name: v.name, email: v.email }, ctx);
    return;
  }

  // POST /user/repos  |  GET /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') {
        err(res, ctx, 422, 'name is required');
        return;
      }
      const existing = findRepo(store, store.viewerLogin, name);
      if (existing !== undefined) {
        err(res, ctx, 422, 'Repository already exists');
        return;
      }
      const repo = createRepo(
        store,
        name,
        b.private === true,
        typeof b.description === 'string' ? b.description : '',
      );
      sendJson(res, 201, repoJson(repo), ctx);
      return;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      const mine = [...store.repos.values()]
        .filter((r) => r.owner === store.viewerLogin)
        .sort((a, c) => a.createdSeq - c.createdSeq);
      const totalPages = Math.max(1, Math.ceil(mine.length / perPage));
      const slice = mine.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      const origin = `http://${req.headers.host ?? 'entry'}`;
      const links: string[] = [];
      if (page < totalPages) links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`);
      if (page > 1) links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
      links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=1>; rel="first"`);
      links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=${totalPages}>; rel="last"`);
      headers.link = links.join(', ');
      sendJson(res, 200, slice.map((r) => repoJson(r)), ctx, headers);
      return;
    }
  }

  // /repos/{owner}/{name}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1] as string);
    const name = decodeURIComponent(rest[2] as string);
    const repo = findRepo(store, owner, name);
    if (repo === undefined) {
      err(res, ctx, 404, 'Not Found');
      return;
    }
    const tail = rest.slice(3);

    // GET /repos/{o}/{r}  |  PATCH  |  DELETE
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo), ctx);
        return;
      }
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        sendJson(res, 200, repoJson(repo), ctx);
        return;
      }
      if (method === 'DELETE') {
        store.repos.delete(repoKey(repo.owner, repo.name));
        res.writeHead(204, { 'x-github-request-id': ctx.reqSeq() });
        res.end();
        return;
      }
    }

    // GET /repos/{o}/{r}/branches  |  GET /branches/{branch}
    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const out: Record<string, unknown>[] = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      sendJson(res, 200, out, ctx);
      return;
    }
    if (tail.length === 2 && tail[0] === 'branches' && method === 'GET') {
      const branch = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        err(res, ctx, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha } }, ctx);
      return;
    }

    // GET /repos/{o}/{r}/commits
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const refParam = url.searchParams.get('sha');
      const ref = refParam === null ? `refs/heads/${repo.defaultBranch}` : `refs/heads/${refParam}`;
      const tip = repo.refs.get(ref);
      if (tip === undefined) {
        sendJson(res, 200, [], ctx);
        return;
      }
      const out = walkCommits(repo, tip).map(({ sha, info }) => ({
        sha,
        commit: {
          message: info.message,
          author: { name: info.authorName, email: info.authorEmail, date: new Date(info.ts * 1000).toISOString() },
          committer: { name: info.authorName, email: info.authorEmail, date: new Date(info.ts * 1000).toISOString() },
        },
      }));
      sendJson(res, 200, out, ctx);
      return;
    }

    // POST /repos/{o}/{r}/git/refs  |  GET /git/refs/heads/{branch}
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!/^refs\//.test(ref) || !/^[0-9a-f]{40}$/i.test(sha)) {
        err(res, ctx, 422, 'Invalid ref or sha');
        return;
      }
      if (repo.refs.has(ref)) {
        err(res, ctx, 422, 'Reference already exists');
        return;
      }
      if (getObject(repo, sha) === undefined) {
        err(res, ctx, 422, 'Object does not exist');
        return;
      }
      repo.refs.set(ref, sha.toLowerCase());
      sendJson(res, 201, { ref, object: { sha: sha.toLowerCase() } }, ctx);
      return;
    }
    if (tail.length >= 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && method === 'GET') {
      const branch = tail.slice(3).map((s) => decodeURIComponent(s)).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        err(res, ctx, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha } }, ctx);
      return;
    }

    // /repos/{o}/{r}/contents/{path...}
    if (tail.length >= 2 && tail[0] === 'contents') {
      const filePath = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const refParam = url.searchParams.get('ref');
      const branch = refParam ?? repo.defaultBranch;
      const ref = `refs/heads/${branch}`;
      if (method === 'PUT') {
        const message = typeof b.message === 'string' ? b.message : 'Update';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        const content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
        const branchParam = typeof b.branch === 'string' ? b.branch : branch;
        const existing = getFileAtRef(repo, `refs/heads/${branchParam}`, filePath);
        if (typeof b.sha === 'string' && b.sha !== '') {
          if (existing === undefined || existing.blobSha.toLowerCase() !== (b.sha as string).toLowerCase()) {
            err(res, ctx, 409, 'sha does not match the current blob');
            return;
          }
        }
        const isCreate = existing === undefined;
        const result = commitFile(store, repo, branchParam, filePath, content, message);
        sendJson(
          res,
          isCreate ? 201 : 200,
          { content: { sha: result.blobSha, encoding: 'base64', name: filePath.split('/').pop() ?? '', path: filePath }, commit: { sha: result.commitSha } },
          ctx,
        );
        return;
      }
      if (method === 'GET') {
        const file = getFileAtRef(repo, ref, filePath);
        if (file !== undefined) {
          sendJson(
            res,
            200,
            {
              type: 'file',
              encoding: 'base64',
              content: file.content.toString('base64'),
              sha: file.blobSha,
              size: file.content.length,
              name: filePath.split('/').pop() ?? '',
              path: filePath,
            },
            ctx,
          );
          return;
        }
        const dir = listDirAtRef(repo, ref, filePath);
        if (dir !== null) {
          sendJson(res, 200, dir, ctx);
          return;
        }
        err(res, ctx, 404, 'Not Found');
        return;
      }
      if (method === 'DELETE') {
        const existing = getFileAtRef(repo, ref, filePath);
        if (existing === undefined) {
          err(res, ctx, 404, 'Not Found');
          return;
        }
        const message = typeof b.message === 'string' ? b.message : 'Delete';
        const result = commitFile(store, repo, branch, filePath, null, message);
        sendJson(res, 200, { commit: { sha: result.commitSha } }, ctx);
        return;
      }
    }

    // Labels
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()], ctx);
        return;
      }
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name : '';
        const color = typeof b.color === 'string' ? b.color : 'ededed';
        if (name === '') {
          err(res, ctx, 422, 'name is required');
          return;
        }
        const label = { name, color };
        repo.labels.set(name, label);
        sendJson(res, 201, label, ctx);
        return;
      }
    }

    // Issues
    if (tail.length >= 1 && tail[0] === 'issues') {
      // POST /issues  |  GET /issues
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).filter((x) => typeof x === 'string') as string[] : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              err(res, ctx, 422, `Label does not exist: ${label}`);
              return;
            }
          }
          const issue = createIssue(store, repo, title, bodyText, labels);
          sendJson(res, 201, issueJson(issue), ctx);
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const sort = url.searchParams.get('sort') ?? 'created';
          const direction = url.searchParams.get('direction') ?? 'desc';
          const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
          let list = repo.issueOrder.map((n) => repo.issues.get(n) as NonNullable<ReturnType<typeof repo.issues.get>>);
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list = [...list].sort((a, c) => (direction === 'asc' ? a.createdSeq - c.createdSeq : c.createdSeq - a.createdSeq));
          }
          sendJson(res, 200, list.slice(0, perPage).map((i) => issueJson(i)), ctx);
          return;
        }
      }
      const num = Number(tail[1]);
      if (tail.length === 2 && Number.isInteger(num)) {
        const issue = repo.issues.get(num);
        if (issue === undefined) {
          err(res, ctx, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(issue), ctx);
          return;
        }
        if (method === 'PATCH') {
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          sendJson(res, 200, issueJson(issue), ctx);
          return;
        }
      }
      // /issues/{n}/comments
      if (tail.length === 3 && tail[2] === 'comments' && Number.isInteger(num)) {
        const issue = repo.issues.get(num);
        if (issue === undefined) {
          err(res, ctx, 404, 'Not Found');
          return;
        }
        if (method === 'POST') {
          const comment = { id: repo.nextCommentId, body: typeof b.body === 'string' ? b.body : '' };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, 201, comment, ctx);
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments, ctx);
          return;
        }
      }
    }

    // Pulls
    if (tail.length >= 1 && tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
          const pull = createPull(store, repo, title, bodyText, head, base);
          if (pull === null) {
            err(res, ctx, 422, 'head or base branch does not exist');
            return;
          }
          sendJson(res, 201, pullJson(pull), ctx);
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
          let list = [...repo.pulls.values()].sort((a, c) => a.number - c.number);
          if (state !== 'all') list = list.filter((p) => p.state === state);
          sendJson(res, 200, list.slice(0, perPage).map((p) => pullJson(p)), ctx);
          return;
        }
      }
      const num = Number(tail[1]);
      if (Number.isInteger(num)) {
        const pull = repo.pulls.get(num);
        if (tail.length === 2) {
          if (pull === undefined) {
            err(res, ctx, 404, 'Not Found');
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, pullJson(pull), ctx);
            return;
          }
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          if (pull === undefined) {
            err(res, ctx, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, pull.files, ctx);
          return;
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          if (pull === undefined) {
            err(res, ctx, 404, 'Not Found');
            return;
          }
          if (pull.state !== 'open') {
            err(res, ctx, 405, 'Pull request is not open');
            return;
          }
          if (pullConflicts(repo, pull)) {
            err(res, ctx, 405, 'Merge conflict');
            return;
          }
          const outcome = mergePull(store, repo, pull);
          if (!outcome.ok || outcome.sha === null) {
            err(res, ctx, 405, 'Merge conflict');
            return;
          }
          sendJson(res, 200, { merged: true, sha: outcome.sha, message: `Pull request #${pull.number} merged` }, ctx);
          return;
        }
      }
    }

    // Unknown sub-route under this repo.
    err(res, ctx, 404, 'Not Found');
    return;
  }

  err(res, ctx, 404, 'Not Found');
}
