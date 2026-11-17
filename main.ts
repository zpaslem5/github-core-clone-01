// Lifecycle glue between this forge and the trial env. The env drives everything:
// it tells us where it lives (MAKEFUN_ENV_URL), we bind a port, hand it over, and
// then wait until the env says the trial is finished. Nothing else happens here —
// the actual forge lives in app.ts, and the suite grades that, not this file.
//
// The exchange, step by step:
//   1. No MAKEFUN_ENV_URL means there is no env at all, so exit 1 immediately.
//   2. Start the server on port 0 and let the kernel pick a free one. Port 8080 is
//      the env's own listener, so we never touch it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The env notes the address the
//      request came from plus N and dials us from then on. If another entry already
//      registered first we get a 409; that is fine, we just keep waiting.
//   4. Poll GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers right away ({"done": false} while the suite is still running), so
//      this is a plain poll. A failed or slow poll is retried with backoff; the
//      process never leaves before the env says done.
//   5. Shut the server down and exit 0. The harness then stops the env, which writes
//      the export the scorer reads.
//
// Only our own server module is imported here: no packages, no Node built-ins, no
// model calls.

import { createApp } from './app.ts';

// The env's origin, with any trailing slashes trimmed off.
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

// One register or done request gets this long before it is dropped and retried.
const REQUEST_TIMEOUT_MS = 30_000;
// Backoff starts here and doubles up to this ceiling.
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wait after `failures` failed attempts: exponential from BACKOFF_FIRST_MS, capped.
function backoff(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8));
}

// Keep POSTing the bound port until the env takes it. 200 is the usual answer;
// 409 means a first register already won, which is not ours to fix. 400 and 405
// are contract errors and stop the program; anything else (network error, other
// status) is retried, since the env may still be coming up.
async function registerPort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoff(failures));
  }
}

// Poll GET /done until it answers {"done": true}; never come back before that.
async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, poll again.
    }
    await pause(backoff(failures));
  }
}

// Bind the port, register it, then wait for the env: the whole life of the process.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
