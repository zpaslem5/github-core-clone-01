# github-core-clone-01 — entry

A standalone GitHub-compatible forge (Node 22, stdlib only, no dependencies, no git
binary): git smart HTTP, REST v3, GraphQL v4 and MCP over one shared in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. `main.ts` owns the
entry <-> env lifecycle (bind an ephemeral port, POST `$MAKEFUN_ENV_URL/register`,
poll `/done`, exit 0); `app.ts` builds the server.

## Layout

- `app.ts` — routing, bearer auth (`MAKEFUN_SHOP_TOKEN`), body reading.
- `store.ts` — the shared state: repos, git objects (commit/tree/blob/tag), refs,
  issues, pulls, labels; file maps derived from trees so REST, GraphQL, MCP and
  git always agree; squash merge with 3-way conflict detection.
- `gitproto.ts` — pkt-line framing, packfile read/write (SHA-1, full objects, no
  deltas on write; OFS/REF deltas readable), async inflate via `bytesWritten`.
- `git.ts` — protocol v2 upload-pack (`ls-refs`, `fetch` with shallow/deepen,
  sideband) and v0 receive-pack (`report-status`, non-fast-forward refusal).
- `rest.ts` — REST v3: repos, contents, labels, issues, pulls, git refs, branches,
  commits; `Link` pagination; `X-GitHub-Request-Id` on every reply.
- `graphql.ts` — a small parser + executor for the suite's documents: viewer,
  repository, node, `__type` introspection, issues/pullRequests connections with
  cursor pagination, and the five mutations (cross-checked against REST).
- `mcp.ts` — MCP streamable HTTP: `server/discover` (2026-07-28) + legacy
  `initialize`, `tools/list` (6 canonical tools), `tools/call`.
- `scenario.ts` — the kit's public wire contract vendored in: the scenario seed
  derives the token owner's login (`adaiversen`) so repos created via
  `POST /user/repos` are owned correctly and a stranger's same-named repo 404s.

## Local check

```sh
# start the server on :18080 with a test token, then run the sealed local grader:
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types /tmp/forge-dev.ts
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080 --token test-token-123 --perf
```

Local result (2026-11-14): **120/120 conformance checks pass**; perf 140/200
(push 40, clone 31, read 40, write 29 — varies with shared-CPU noise).
