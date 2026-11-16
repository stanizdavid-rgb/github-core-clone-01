// Entry lifecycle for the trial harness: the entry is one Node process that
// serves the forge on an ephemeral port. It has to announce that port to the
// trial env and then wait until the env reports the trial is over.
//
// The exchange with the env is:
//   - read MAKEFUN_ENV_URL (the env origin). Without it there is nothing to
//     register with, so the process exits 1 immediately.
//   - bind the server to port 0 and let the kernel choose a free port. Port
//     8080 belongs to the env, so it is never bound here.
//   - POST {port} to $MAKEFUN_ENV_URL/register. The env records the caller
//     address plus the port and dials the entry from then on. The first
//     register wins: a 409 just means another entry registered first, and
//     this process keeps waiting like any other.
//   - GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env
//     answers immediately, so this is polling, not a held request. Failed or
//     slow polls are retried with short exponential backoff; the process
//     never exits before the env says done.
//   - close the server and exit 0. The harness then stops the env, which
//     writes the export the scorer reads.
//
// Only the server built by app.ts is imported: no packages, no Node
// built-ins, no model calls.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Longest a single register or done request may run before it is abandoned and retried. */
const REQUEST_TIMEOUT = 30_000;
/** First pause between retries, and the longest pause. */
const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `failures` failed requests: exponential from RETRY_BASE_MS, capped. */
function backoffMs(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer;
 * 409 means a first register already won, which is not this process's to
 * fix. 400 and 405 are contract errors and end the program; a network error
 * or another status is retried, since the env may still be starting.
 */
async function registerPort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await pause(backoffMs(failures));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await pause(backoffMs(failures));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
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
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
