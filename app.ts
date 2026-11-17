// The forge server: routing, auth, body reading. main.ts owns the lifecycle.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { handleRest } from './rest.ts';
import { runGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';

const MAX_BODY_BYTES = 100 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, reqId: string): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': reqId,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function isAuthed(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  if (token === '') return header.length > 'Bearer '.length;
  return header === `Bearer ${token}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store: Store = createStore();
  const reqSeq = (): string => {
    store.reqSeq += 1;
    return store.reqSeq.toString(16).padStart(8, '0');
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    const id = reqSeq();

    void (async () => {
      try {
        // Health probe: no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, id);
          return;
        }

        // Everything else needs the shop token.
        if (!isAuthed(req)) {
          sendJson(res, 401, { message: 'Requires authentication' }, id);
          return;
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const body = needsBody ? await readBody(req) : null;

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method not allowed' }, id);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse((body ?? Buffer.alloc(0)).toString('utf8'));
          } catch {
            sendJson(res, 400, { data: null, errors: [{ message: 'Problems parsing JSON' }] }, id);
            return;
          }
          const result = runGraphQL(store, parsed);
          sendJson(res, 200, result, id);
          return;
        }

        // MCP streamable HTTP.
        if (path === '/mcp') {
          handleMcp(req, res, store, body);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const action = gitMatch[3] as string;
          if (action === 'info/refs' && method === 'GET') {
            const url = new URL(req.url ?? '/', 'http://entry');
            handleInfoRefs(req, res, store, owner, repoName, url.searchParams.get('service'));
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            handleUploadPack(req, res, store, owner, repoName, body ?? Buffer.alloc(0));
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            await handleReceivePack(req, res, store, owner, repoName, body ?? Buffer.alloc(0));
            return;
          }
          sendJson(res, 405, { message: 'Method not allowed' }, id);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, { store, reqSeq }, body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, id);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) }, id);
        } else {
          res.destroy();
        }
      }
    })();
  });
}
