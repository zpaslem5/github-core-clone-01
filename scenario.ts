// github-core-clone-01's wire contract: the entry <-> env protocol, the state and perf exports, the
// trial's clocks, and the one seeded scenario every check generates its data from.
//
// The entry is a standalone GitHub-compatible forge (a server), not an agent: the harness starts it
// beside this env and hands it MAKEFUN_ENV_URL. The lifecycle, settled and enforced by grader/agent.ts:
//
//   1. the env listens (MAKEFUN_ENV_HOST / MAKEFUN_ENV_PORT, 8080 in a container), writes /state/ready,
//      and waits for the entry's first register;
//   2. the entry binds its own ephemeral port (listen(0)), then POSTs $MAKEFUN_ENV_URL/register with
//      {"port": N}. The env records req.socket.remoteAddress:N as the entry's base URL and dials it from
//      then on. The first register wins; a later one is answered 409 and does not move the base URL;
//   3. the entry long-polls GET $MAKEFUN_ENV_URL/done. Until the suite is over the env answers
//      {"done": false} at once (within DONE_ANSWER_DEADLINE_MS, never holding a request); once the
//      export is written it answers {"done": true}, and the entry exits 0. The harness then SIGTERMs
//      the env, which writes (or keeps) its export and exits;
//   4. the env's suite runs in four phases: boot (the entry's GET /healthz twice within
//      HEALTHZ_BUDGET_MS), conformance (every check, one at a time), benchmark (four workloads), and
//      export. The env's internal deadline is the trial's wall budget less DEADLINE_MARGIN_MS; at it the
//      remaining checks are recorded 0 and the export is written anyway.
//
// Two layouts run this wire: `split` (the env a pod of its own, the entry another, MAKEFUN_ENV_URL
// naming the env's service) and `pod` (one gVisor sandbox pod: the env on the loopback at
// 127.0.0.1:8080, the entry's `store` host alias pointing at it). Nothing here depends on either: the
// base URL is always the address the entry's own register request came from, plus the port it named.
//
// Files this contract owns, under the env's state directory (MAKEFUN_STATE_DIR outside a container,
// /state inside one):
//   ready                 {"schema":"github-core-clone-01/ready/v1","host":…,"port":…}, written once the
//                         env listens (the harness waits for it before starting the entry)
//   export/state.json     the run-invariant bits: version, working, every check's 0|1, the counts and
//                         the perf tiers (StateFile below), with no times, ports or random ids
//   export/perf.json      the timings: per-workload rounds, p50/p99 and the points/tiers they earned
//                         (PerfFile below)
//
// The scenario: every user, repo, path, blob, commit message and issue/PR title derives from the one
// constant SCENARIO_SEED through scenarioRng(label) and the generators below. No check builds data of
// its own, and nothing reads Math.random or the wall clock for data, so live, replay and the entrant's
// local practice run all see byte-identical data. The generators are pure: same label and seed, same
// bytes, in this process or any other.
//
// This module imports nothing (a sealed bundle inlines it whole) and touches no Node-only API: timers,
// AbortSignal and TextEncoder are the only globals used, and only where Node 22 and a browser both
// have them.

// ---------------------------------------------------------------- errors

/** A contract violation or an unusable value: never thrown for an entry's own behaviour. */
export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

/** A wait that ran out before the value arrived. */
export class WireTimeoutError extends WireError {
  constructor(message: string) {
    super(message);
    this.name = 'WireTimeoutError';
  }
}

/** A wait that an AbortSignal ended. */
export class WireAbortError extends WireError {
  constructor(message: string) {
    super(message);
    this.name = 'WireAbortError';
  }
}

// ---------------------------------------------------------------- the environment

/** The variable naming the env's origin, as the entry receives it (`http://store:8080`). */
export const ENV_URL_ENV = 'MAKEFUN_ENV_URL';
/** The variable naming the state directory outside a container (the process driver sets it). */
export const STATE_DIR_ENV = 'MAKEFUN_STATE_DIR';
/** The variable naming the address the env listens on. */
export const ENV_HOST_ENV = 'MAKEFUN_ENV_HOST';
/** The variable naming the port the env listens on (0 picks one). */
export const ENV_PORT_ENV = 'MAKEFUN_ENV_PORT';
/** The bearer token the entry receives and every API call to it must carry (contracts/agent.ts). */
export const TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';
/** The port an env listens on when MAKEFUN_ENV_PORT is unset. */
export const DEFAULT_ENV_PORT = 8080;
/** The host an env listens on in a container when MAKEFUN_ENV_HOST is unset. */
export const CONTAINER_HOST = '0.0.0.0';
/** The host an env listens on under the process driver when MAKEFUN_ENV_HOST is unset. */
export const PROCESS_DRIVER_HOST = '127.0.0.1';
/** The state directory in a container (MAKEFUN_STATE_DIR replaces it outside one). */
export const CONTAINER_STATE_DIR = '/state';

/** The state directory the env reads its files from: MAKEFUN_STATE_DIR when set, else /state. */
export function stateDirOf(env: Readonly<Record<string, string | undefined>>): string {
  const dir = env[STATE_DIR_ENV];
  return dir !== undefined && dir !== '' ? dir : CONTAINER_STATE_DIR;
}

// ---------------------------------------------------------------- routes and endpoints

/** The entry POSTs {"port":N} here. */
export const REGISTER_PATH = '/register';
/** The entry long-polls this until {"done":true}. */
export const DONE_PATH = '/done';
/** The entry answers 200 {"ok":true} here; the env's boot check calls it twice. */
export const HEALTHZ_PATH = '/healthz';
/** The GitHub REST v3 prefix on the entry. */
export const API_PREFIX = '/api/v3';
/** The GraphQL v4 endpoint on the entry. */
export const GRAPHQL_PATH = '/api/graphql';
/** The Model Context Protocol streamable-HTTP endpoint on the entry. */
export const MCP_PATH = '/mcp';
/** The authorization scheme every API call carries. */
export const AUTH_SCHEME = 'Bearer';
/** The ready file the env writes once listening. */
export const READY_FILE = 'ready';
/** The ready file's schema line. */
export const READY_SCHEMA = 'github-core-clone-01/ready/v1';
/** The directory under the state directory the scorer reads. */
export const EXPORT_DIR = 'export';
/** The run-invariant export. */
export const STATE_FILE = 'state.json';
/** The timings export. */
export const PERF_FILE = 'perf.json';
/** The version both exports carry. */
export const STATE_VERSION = 1 as const;
/** The version perf.json carries. */
export const PERF_VERSION = 1 as const;

/** A port the entry may name: 1..65535 (0 is the entry's own bind, never its announced port). */
export const MIN_PORT = 1;
/** The largest port a register request may name. */
export const MAX_PORT = 65535;
/** The most bytes a register request body may hold. */
export const MAX_REGISTER_BODY_BYTES = 65_536;

/** Whether `value` is a port the register contract accepts: an integer 1..65535. */
export function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

// ---------------------------------------------------------------- the register contract

/** The body of POST /register: the port the entry listens on. */
export interface RegisterRequest {
  readonly port: number;
}

/** The entry's origin, as the env derived it from the register request. */
export interface EntryBase {
  /** The address the register request came from, IPv4-mapped forms normalized. */
  readonly host: string;
  /** The port the entry named. */
  readonly port: number;
  /** `http://host:port`, no trailing slash. */
  readonly url: string;
}

/** Whether `value` is a well-formed register body (exactly a port in 1..65535; extra keys are ignored). */
export function isRegisterRequest(value: unknown): value is RegisterRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isPort(record.port);
}

/** The register body, or a WireError naming what is wrong with it. */
export function parseRegisterRequest(value: unknown): RegisterRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WireError('the register body is not a JSON object');
  const port = (value as Record<string, unknown>).port;
  if (!isPort(port)) throw new WireError(`the register body's port is not an integer 1..${MAX_PORT}: ${JSON.stringify(port)}`);
  return { port };
}

/**
 * The address a connection came from, as a host that formats into a URL: an IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d`) becomes the IPv4 address, brackets around an IPv6 literal are dropped, and a zone
 * suffix (`%eth0`) is dropped. An empty address is a WireError: a register request with no peer address
 * cannot be dialled back.
 */
export function normalizeRemoteAddress(address: string | undefined): string {
  if (address === undefined || address === '') throw new WireError('the register request has no peer address');
  let host = address.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (mapped !== null) host = mapped[1] ?? host;
  if (host === '') throw new WireError('the register request has no peer address');
  return host;
}

/** A host as it is written in a URL: an IPv6 literal in brackets, anything else unchanged. */
export function formatHost(host: string): string {
  if (host === '') throw new WireError('a base URL needs a host');
  return host.includes(':') && !(host.startsWith('[') && host.endsWith(']')) ? `[${host}]` : host;
}

/** The entry's base URL from the peer address of its register request and the port it named. */
export function entryBase(remoteAddress: string | undefined, port: number): EntryBase {
  if (!isPort(port)) throw new WireError(`the register port is not an integer 1..${MAX_PORT}: ${JSON.stringify(port)}`);
  const host = normalizeRemoteAddress(remoteAddress);
  return Object.freeze({ host, port, url: `http://${formatHost(host)}:${port}` });
}

/** A URL under an origin: `joinUrl('http://store:8080/', '/api/v3/x')` is `http://store:8080/api/v3/x`. */
export function joinUrl(baseUrl: string, path: string): string {
  const origin = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${suffix}`;
}

/** A REST v3 URL: `apiUrl(base, '/repos/o/r')` is `<base>/api/v3/repos/o/r`. */
export function apiUrl(baseUrl: string, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return joinUrl(baseUrl, `${API_PREFIX}${suffix}`);
}

/** The GraphQL endpoint's URL. */
export function graphqlUrl(baseUrl: string): string {
  return joinUrl(baseUrl, GRAPHQL_PATH);
}

/** The MCP endpoint's URL. */
export function mcpUrl(baseUrl: string): string {
  return joinUrl(baseUrl, MCP_PATH);
}

/** The status a first register is answered with. */
export const REGISTER_OK_STATUS = 200;
/** The status a second register is answered with (the first entry stays the one dialled). */
export const REGISTER_CONFLICT_STATUS = 409;
/** The status an unparsable register body is answered with. */
export const REGISTER_BAD_REQUEST_STATUS = 400;
/** The status a register request with another method is answered with. */
export const REGISTER_METHOD_STATUS = 405;

/** The body a first register is answered with. */
export function registerAcceptedBody(): { readonly ok: true } {
  return { ok: true };
}

/** The body a second register is answered with. */
export function registerConflictBody(): { readonly ok: false; readonly error: 'already_registered' } {
  return { ok: false, error: 'already_registered' };
}

// ---------------------------------------------------------------- the done contract

/** The answer while the suite still runs. */
export interface DoneWaiting {
  readonly done: false;
}

/** The answer once the export is written: the entry exits 0. */
export interface DoneComplete {
  readonly done: true;
}

/** GET /done's body: waiting until the suite is over, then complete. */
export type DoneResponse = DoneWaiting | DoneComplete;

/** The shared waiting answer (a fresh object every time, so a caller may mutate its copy). */
export function doneWaiting(): DoneWaiting {
  return { done: false };
}

/** The complete answer. */
export function doneComplete(): DoneComplete {
  return { done: true };
}

/** Whether `value` is a done answer. */
export function isDoneResponse(value: unknown): value is DoneResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const done = (value as Record<string, unknown>).done;
  return done === true || done === false;
}

/** The env answers a done poll within this many ms: never held open. */
export const DONE_ANSWER_DEADLINE_MS = 1_000;
/** The entry's first wait between done polls. */
export const DONE_POLL_INTERVAL_MS = 250;
/** The entry's longest wait between done polls. */
export const DONE_POLL_MAX_MS = 2_000;
/** The entry never holds a done request open longer than this: it polls, it does not long-hold. */
export const DONE_REQUEST_TIMEOUT_MS = 30_000;
/** The exit code the entry ends with once done is true. */
export const ENTRY_EXIT_OK = 0;

/** The wait before the next done poll: exponential from DONE_POLL_INTERVAL_MS to DONE_POLL_MAX_MS. */
export function donePollDelayMs(attempt: number, initialMs: number = DONE_POLL_INTERVAL_MS, maxMs: number = DONE_POLL_MAX_MS): number {
  const step = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
  const first = Math.max(1, initialMs);
  const cap = Math.max(first, maxMs);
  return Math.min(cap, Math.round(first * 2 ** step));
}

// ---------------------------------------------------------------- clocks and budgets

/** The boot phase: ready file present, entry registered, /healthz answered twice. */
export const BOOT_BUDGET_MS = 20_000;
/** The conformance phase: every check, one at a time. */
export const CONFORMANCE_BUDGET_MS = 240_000;
/** The benchmark phase: the four workloads. */
export const BENCHMARK_BUDGET_MS = 240_000;
/** The export phase: both files written and fsynced. */
export const EXPORT_BUDGET_MS = 30_000;
/** What the env's internal deadline leaves of the trial's wall budget for the export and the harness. */
export const DEADLINE_MARGIN_MS = 90_000;
/** The competition's limits.wall_budget_sec, which the internal deadline is derived from. */
export const TRIAL_WALL_BUDGET_SEC = 900;
/** The entry answers GET /healthz this many times before the boot check passes. */
export const HEALTHZ_ATTEMPTS = 2;
/** The boot check's budget for those answers. */
export const HEALTHZ_BUDGET_MS = 10_000;
/** A check's default timeout. */
export const CHECK_TIMEOUT_MS = 15_000;
/** A check may not be given less than this. */
export const CHECK_TIMEOUT_MIN_MS = 5_000;
/** A check may not be given more than this. */
export const CHECK_TIMEOUT_MAX_MS = 15_000;

/** The per-phase budgets, by phase name. */
export const PHASE_BUDGET_MS: Readonly<Record<'boot' | 'conformance' | 'benchmark' | 'export', number>> = Object.freeze({
  boot: BOOT_BUDGET_MS,
  conformance: CONFORMANCE_BUDGET_MS,
  benchmark: BENCHMARK_BUDGET_MS,
  export: EXPORT_BUDGET_MS,
});

/** A phase's name. */
export type Phase = keyof typeof PHASE_BUDGET_MS;

/** The boot wait's backoff: the first gap, its factor, and its ceiling. */
export const BOOT_BACKOFF = Object.freeze({ initialMs: 100, factor: 2, maxMs: 2_000 });

/** The wait before the env's next probe of the ready file (or the register gate): exponential. */
export function bootBackoffMs(attempt: number): number {
  const step = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
  return Math.min(BOOT_BACKOFF.maxMs, Math.round(BOOT_BACKOFF.initialMs * BOOT_BACKOFF.factor ** step));
}

/** The trial's clocks: when the env's program started, and the internal deadline it must export by. */
export interface Deadline {
  readonly startedAtMs: number;
  readonly deadlineMs: number;
}

/** The internal deadline: `startedAtMs + wallBudgetSec * 1000 - DEADLINE_MARGIN_MS`, never before the start. */
export function deadlineOf(startedAtMs: number, wallBudgetSec: number = TRIAL_WALL_BUDGET_SEC): Deadline {
  const wallMs = Number.isFinite(wallBudgetSec) && wallBudgetSec > 0 ? wallBudgetSec * 1000 : TRIAL_WALL_BUDGET_SEC * 1000;
  const deadlineMs = startedAtMs + Math.max(0, wallMs - DEADLINE_MARGIN_MS);
  return Object.freeze({ startedAtMs, deadlineMs });
}

/** What is left of a deadline at `nowMs`, never negative. */
export function remainingMs(deadline: Deadline, nowMs: number): number {
  return Math.max(0, deadline.deadlineMs - nowMs);
}

/** `wantMs` clamped to what is left of the deadline at `nowMs`. */
export function clampToDeadline(wantMs: number, deadline: Deadline, nowMs: number): number {
  const want = Number.isFinite(wantMs) ? Math.max(0, wantMs) : 0;
  return Math.min(want, remainingMs(deadline, nowMs));
}

// ---------------------------------------------------------------- waiting

/** How a wait probes, how often, and what ends it. */
export interface WaitOptions {
  /** The most time the wait may take, ms. */
  readonly timeoutMs: number;
  /** The first gap between probes (default BOOT_BACKOFF.initialMs). */
  readonly initialDelayMs?: number;
  /** The longest gap between probes (default BOOT_BACKOFF.maxMs). */
  readonly maxDelayMs?: number;
  /** The gap's growth factor (default BOOT_BACKOFF.factor). */
  readonly factor?: number;
  /** Ends the wait at once when aborted. */
  readonly signal?: AbortSignal;
  /** The clock, default `Date.now` (only waits read a clock in this module; generated data never does). */
  readonly now?: () => number;
  /** The sleep, default a real timer (a test drives it without waiting). */
  readonly sleep?: (delayMs: number) => Promise<void>;
}

function realSleep(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Resolve with the first non-null value `probe` returns, polling with exponential backoff; a wait past
 * `timeoutMs` throws WireTimeoutError, an aborted signal WireAbortError. The probe runs at least once.
 */
export async function waitForValue<T>(probe: () => T | null | undefined, options: WaitOptions): Promise<T> {
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? realSleep;
  const initial = Math.max(1, options.initialDelayMs ?? BOOT_BACKOFF.initialMs);
  const cap = Math.max(initial, options.maxDelayMs ?? BOOT_BACKOFF.maxMs);
  const growth = Math.max(1, options.factor ?? BOOT_BACKOFF.factor);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 0;
  const deadline = now() + timeoutMs;
  let delay = initial;
  let probes = 0;
  for (;;) {
    if (options.signal?.aborted === true) throw new WireAbortError('the wait was aborted');
    const value = probe();
    if (value !== null && value !== undefined) return value;
    probes += 1;
    const left = deadline - now();
    if (left <= 0) throw new WireTimeoutError(`nothing arrived within ${timeoutMs} ms (${probes} probes)`);
    await sleep(Math.min(delay, left));
    delay = Math.min(cap, Math.round(delay * growth));
  }
}

/** The first register wins: a later one is refused and the first entry base URL stays. */
export class RegisterGate {
  #entry: EntryBase | null = null;

  /** The entry base URL, or null before the first register. */
  get entry(): EntryBase | null {
    return this.#entry;
  }

  /** Whether an entry has registered. */
  get registered(): boolean {
    return this.#entry !== null;
  }

  /** Record `base` if no entry has registered yet; false when the first entry already won. */
  offer(base: EntryBase): boolean {
    if (this.#entry !== null) return false;
    this.#entry = base;
    return true;
  }

  /** Wait for the first register, with the boot backoff, up to the boot budget (or `timeoutMs`). */
  wait(options: Omit<WaitOptions, 'timeoutMs'> & { readonly timeoutMs?: number } = {}): Promise<EntryBase> {
    return waitForValue(() => this.#entry, {
      timeoutMs: options.timeoutMs ?? BOOT_BUDGET_MS,
      initialDelayMs: options.initialDelayMs,
      maxDelayMs: options.maxDelayMs,
      factor: options.factor,
      signal: options.signal,
      now: options.now,
      sleep: options.sleep,
    });
  }
}

// ---------------------------------------------------------------- the ready file

/** What the env writes to /state/ready once its listener is bound. */
export interface ReadyFile {
  readonly schema: string;
  readonly host: string;
  readonly port: number;
}

/** The ready file's body for a listener bound at `host:port`. */
export function readyBody(host: string, port: number): ReadyFile {
  if (!isPort(port) && port !== 0) throw new WireError(`a ready file's port is 0 or 1..${MAX_PORT}: ${JSON.stringify(port)}`);
  return Object.freeze({ schema: READY_SCHEMA, host, port });
}

/** Whether `value` is a ready file body. */
export function isReadyFile(value: unknown): value is ReadyFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema === READY_SCHEMA && typeof record.host === 'string' && record.host !== '' && isPort(record.port);
}

/**
 * Wait for /state/ready to be readable, up to the boot budget (or `timeoutMs`). `read` is the caller's
 * file read (this module imports no `node:fs`) returning the parsed body or null; the env's own write
 * at boot makes this resolve at once, and a runner that writes the file before starting the entry makes
 * it the start signal. Then the env waits for the first register (RegisterGate.wait).
 */
export function waitForReadyFile(
  read: () => ReadyFile | null,
  options: Omit<WaitOptions, 'timeoutMs'> & { readonly timeoutMs?: number } = {},
): Promise<ReadyFile> {
  return waitForValue(read, {
    timeoutMs: options.timeoutMs ?? BOOT_BUDGET_MS,
    initialDelayMs: options.initialDelayMs,
    maxDelayMs: options.maxDelayMs,
    factor: options.factor,
    signal: options.signal,
    now: options.now,
    sleep: options.sleep,
  });
}

// ---------------------------------------------------------------- paths and files

/** Join path parts with `/`, tolerating a trailing slash (this module imports no `node:path`). */
export function joinPath(...parts: readonly string[]): string {
  const absolute = parts.length > 0 && (parts[0] ?? '').startsWith('/');
  const clean: string[] = [];
  for (const part of parts) {
    if (part === '') continue;
    const piece = part.replace(/^\/+/, '').replace(/\/+$/, '');
    if (piece !== '') clean.push(piece);
  }
  return `${absolute ? '/' : ''}${clean.join('/')}`;
}

/** `<stateDir>/ready`. */
export function readyFilePath(stateDir: string): string {
  return joinPath(stateDir, READY_FILE);
}

/** `<stateDir>/export`. */
export function exportDirPath(stateDir: string): string {
  return joinPath(stateDir, EXPORT_DIR);
}

/** `<stateDir>/export/state.json`. */
export function stateFilePath(stateDir: string): string {
  return joinPath(stateDir, EXPORT_DIR, STATE_FILE);
}

/** `<stateDir>/export/perf.json`. */
export function perfFilePath(stateDir: string): string {
  return joinPath(stateDir, EXPORT_DIR, PERF_FILE);
}

// ---------------------------------------------------------------- the exports

/** 0 or 1: a check's bit, and the working column. */
export type Bit = 0 | 1;

/** A check id: `<group>.<slug>`, as manifest.ts's checkId() builds it. */
export type CheckId = string;

/** A perf tier: 0..4, one workload's band. */
export type PerfTier = 0 | 1 | 2 | 3 | 4;

/** One group's totals in the export. */
export interface GroupCount {
  readonly total: number;
  readonly passed: number;
}

/** The export's counts: the whole manifest and each group. */
export interface StateCounts {
  /** Every check the manifest declares (120). */
  readonly total: number;
  /** How many of them passed. */
  readonly passed: number;
  /** Per group id: declared checks and passed checks. */
  readonly byGroup: Readonly<Record<string, GroupCount>>;
}

/**
 * export/state.json: everything about a run that does not change between two runs on the same entry
 * and the same seed. No times, no ports, no random ids. `checks` holds every check id with its 0|1 (a
 * check that did not run, at the deadline, is 0); `counts` is derived from it; `perfTiers` is the one
 * timing-derived field, kept coarse (0..4) as the settled shape requires; `notes` names fixed causes
 * ("no register before the boot deadline") and holds no timings.
 */
export interface StateFile {
  readonly version: typeof STATE_VERSION;
  readonly working: Bit;
  readonly checks: Readonly<Record<CheckId, Bit>>;
  readonly counts: StateCounts;
  readonly perfTiers: Readonly<Record<string, PerfTier>>;
  readonly notes?: readonly string[];
}

/** One benchmark workload's timings in export/perf.json. */
export interface PerfWorkload {
  /** Its name from manifest.ts BENCH_WORKLOADS. */
  readonly name: string;
  /** Each timed round's wall time, ms, in order. */
  readonly rounds: readonly number[];
  /** The median round, ms. */
  readonly p50_ms: number;
  /** The 99th percentile round, ms (the largest round when few). */
  readonly p99_ms: number;
  /** The fixed operations one round performs (manifest.ts BENCH_WORKLOADS). */
  readonly ops: number;
  /** 0..50: the points this workload earned by the tier formula (0 uncalibrated or failed). */
  readonly points: number;
  /** Why there are no points, when the workload failed or was cut short. */
  readonly error?: string;
}

/**
 * export/perf.json: the timings, which state.json must not hold. `rounds` is each timed round's ms;
 * `tiers` and `points` are keyed by workload name as well, so a reader takes one map; `perf_p50_us` is
 * the leaderboard's tie-break (the geometric mean of the four p50_ms, in microseconds, rounded);
 * `points_total` is 0..200 and is the perf column. Times never enter state.json or a check's pass bit.
 */
export interface PerfFile {
  readonly version: typeof PERF_VERSION;
  /** Whether T_ref_MS held a calibrated time for every workload when the run was made. */
  readonly calibrated: boolean;
  readonly workloads: readonly PerfWorkload[];
  readonly tiers: Readonly<Record<string, PerfTier>>;
  readonly points: Readonly<Record<string, number>>;
  readonly perf_p50_us: number;
  readonly points_total: number;
  readonly notes: readonly string[];
}

/** The note a boot-failed export carries (fixed, no timing). */
export const BOOT_FAILED_NOTE = 'no entry registered before the boot deadline';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBitRecord(value: unknown): value is Record<string, Bit> {
  if (!isRecord(value)) return false;
  for (const bit of Object.values(value)) if (bit !== 0 && bit !== 1) return false;
  return true;
}

function isPerfTier(value: unknown): value is PerfTier {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4;
}

function isPerfTierRecord(value: unknown): value is Record<string, PerfTier> {
  if (!isRecord(value)) return false;
  for (const tier of Object.values(value)) if (!isPerfTier(tier)) return false;
  return true;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Whether `value` is a state.json this contract wrote (a scorer zeroes the columns otherwise). */
export function isStateFile(value: unknown): value is StateFile {
  if (!isRecord(value) || value.version !== STATE_VERSION) return false;
  if (value.working !== 0 && value.working !== 1) return false;
  if (!isBitRecord(value.checks)) return false;
  if (!isPerfTierRecord(value.perfTiers)) return false;
  if (!isRecord(value.counts)) return false;
  if (!isCount(value.counts.total) || !isCount(value.counts.passed)) return false;
  if (!isRecord(value.counts.byGroup)) return false;
  for (const group of Object.values(value.counts.byGroup)) {
    if (!isRecord(group) || !isCount(group.total) || !isCount(group.passed)) return false;
  }
  if (value.notes !== undefined && !isStringArray(value.notes)) return false;
  return true;
}

/** Whether `value` is a perf.json this contract wrote. */
export function isPerfFile(value: unknown): value is PerfFile {
  if (!isRecord(value) || value.version !== PERF_VERSION) return false;
  if (typeof value.calibrated !== 'boolean') return false;
  if (!Array.isArray(value.workloads)) return false;
  for (const workload of value.workloads) {
    if (!isRecord(workload)) return false;
    if (typeof workload.name !== 'string' || workload.name === '') return false;
    if (!Array.isArray(workload.rounds) || !workload.rounds.every(isFiniteNumber)) return false;
    if (!isFiniteNumber(workload.p50_ms) || !isFiniteNumber(workload.p99_ms)) return false;
    if (!isCount(workload.ops)) return false;
    if (!isCount(workload.points) || workload.points > 50) return false;
    if (workload.error !== undefined && typeof workload.error !== 'string') return false;
  }
  if (!isPerfTierRecord(value.tiers)) return false;
  if (!isRecord(value.points)) return false;
  for (const points of Object.values(value.points)) if (!isCount(points) || points > 50) return false;
  if (!isCount(value.perf_p50_us)) return false;
  if (!isCount(value.points_total) || value.points_total > 200) return false;
  if (!isStringArray(value.notes)) return false;
  return true;
}

/** A value's JSON with object keys sorted at every depth: the same bytes for the same value, always. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** canonicalJson plus a trailing newline, the export files' exact bytes. */
export function canonicalJsonLine(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) continue;
    sorted[key] = sortKeysDeep(item);
  }
  return sorted;
}

/** The working column: 1 only when the entry registered and at least one check passed. */
export function workingBit(bootOk: boolean, passedChecks: number): Bit {
  return bootOk && Number.isFinite(passedChecks) && passedChecks > 0 ? 1 : 0;
}

/** Zeroed counts for a run that never got an entry: every group's declared total, nothing passed. */
export function emptyCounts(groupCounts: Readonly<Record<string, number>>, totalChecks: number): StateCounts {
  const byGroup: Record<string, GroupCount> = {};
  for (const [group, declared] of Object.entries(groupCounts)) byGroup[group] = { total: isCount(declared) ? declared : 0, passed: 0 };
  return { total: isCount(totalChecks) ? totalChecks : 0, passed: 0, byGroup };
}

/**
 * The export a boot failure writes: every check 0, working 0, counts zeroed, a fixed note. It is the
 * "clear export (all checks failed, working=0)" of the contract, so a trial that never got an entry is
 * scored 0 rather than void.
 */
export function bootFailureState(checkIds: readonly CheckId[], groupCounts: Readonly<Record<string, number>>, notes: readonly string[] = [BOOT_FAILED_NOTE]): StateFile {
  const checks: Record<CheckId, Bit> = {};
  for (const id of checkIds) checks[id] = 0;
  return {
    version: STATE_VERSION,
    working: 0,
    checks,
    counts: emptyCounts(groupCounts, checkIds.length),
    perfTiers: {},
    notes: notes.slice(),
  };
}

/** The perf export a run with no timings writes (a boot failure or a skipped benchmark): all zero. */
export function emptyPerfFile(notes: readonly string[] = [BOOT_FAILED_NOTE]): PerfFile {
  return {
    version: PERF_VERSION,
    calibrated: false,
    workloads: [],
    tiers: {},
    points: {},
    perf_p50_us: 0,
    points_total: 0,
    notes: notes.slice(),
  };
}

// ---------------------------------------------------------------- the seeded scenario (PRNG)

/** The one seed every generated byte derives from. Never change it: it is the contest's fixed data. */
export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
/** SCENARIO_SEED as lowercase hex, for a report or a log line. */
export const SCENARIO_SEED_HEX = '6a09e667f3bcc909';
/** 2^64 - 1: the PRNG's state mask. */
export const U64_MASK = 0xffffffffffffffffn;
/** The scenario's day one, 2025-01-01T00:00:00Z: every generated timestamp is this plus a seeded offset. */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;
/** How many users the scenario builds. */
export const SCENARIO_USERS = 12;
/** How many repositories the viewer owns in the scenario. */
export const SCENARIO_VIEWER_REPOS = 30;
/** How many repositories the scenario's org owns. */
export const SCENARIO_ORG_REPOS = 6;
/** How many repositories the scenario's stranger owns. */
export const SCENARIO_STRANGER_REPOS = 3;
/** How many file paths the scenario builds. */
export const SCENARIO_FILE_PATHS = 60;
/** How many blobs (path + content) the scenario builds. */
export const SCENARIO_BLOBS = 24;
/** How many commit messages the scenario builds. */
export const SCENARIO_COMMITS = 60;
/** How many issue templates the scenario builds. */
export const SCENARIO_ISSUES = 60;
/** How many pull request templates the scenario builds. */
export const SCENARIO_PULLS = 30;
/** The default branch every scenario repository is born with. */
export const DEFAULT_BRANCH = 'main';

/** FNV-1a, 64-bit: a label's stable seed contribution. */
export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from: a stable function of SCENARIO_SEED and the label. */
export function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** A named stream: same label, same numbers, in any process and any order of use. */
export function scenarioRng(label: string): Rng {
  return new Rng(scenarioSeedFor(label));
}

const HEX_DIGITS = '0123456789abcdef';

/**
 * xorshift64*: a 64-bit state walked by three shifts and one multiply, seeded from a bigint. Every
 * method is deterministic and has no hidden state but `#state`; clone() gives an independent stream
 * from the same point. Never seeded from a clock or Math.random.
 */
export class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  /** A stream from a label (scenarioSeedFor) under this scenario's seed. */
  static fromLabel(label: string): Rng {
    return new Rng(scenarioSeedFor(label));
  }

  /** An independent stream from this one's current state. */
  clone(): Rng {
    return new Rng(this.#state);
  }

  /** The next 64-bit value. */
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  /** The next 32-bit value, from the top half of nextU64(). */
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new WireError(`nextInt needs a positive safe integer, not ${String(maxExclusive)}`);
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** A number in [0, 1), 32 bits of resolution. */
  fraction(): number {
    return this.nextU32() / 4_294_967_296;
  }

  /** True with probability `probability`. */
  chance(probability: number): boolean {
    return this.fraction() < probability;
  }

  /** One element, uniformly (a WireError on an empty list). */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new WireError('pick from an empty list');
    return items[this.nextInt(items.length)];
  }

  /** A shuffled copy, Fisher-Yates. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const swap = copy[i];
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }

  /** `length` bytes. */
  bytes(length: number): Uint8Array {
    const size = Number.isSafeInteger(length) ? Math.max(0, length) : 0;
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 4) {
      const word = this.nextU32();
      out[i] = word & 0xff;
      if (i + 1 < size) out[i + 1] = (word >>> 8) & 0xff;
      if (i + 2 < size) out[i + 2] = (word >>> 16) & 0xff;
      if (i + 3 < size) out[i + 3] = (word >>> 24) & 0xff;
    }
    return out;
  }

  /** `length` lowercase hex characters. */
  hex(length: number): string {
    let out = '';
    while (out.length < length) out += HEX_DIGITS[this.nextInt(16)];
    return out;
  }

  /** `count` picks from `list`, in order. */
  words(count: number, list: readonly string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) out.push(this.pick(list));
    return out;
  }
}

// ---------------------------------------------------------------- the seeded scenario (data)

const FIRST_NAMES: readonly string[] = Object.freeze([
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
]);
const LAST_NAMES: readonly string[] = Object.freeze([
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
]);
const REPO_ADJECTIVES: readonly string[] = Object.freeze([
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
]);
const REPO_NOUNS: readonly string[] = Object.freeze([
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
]);
const REPO_DESCRIPTIONS: readonly string[] = Object.freeze([
  'a small service with a sharp edge',
  'notes and experiments, kept until they are not',
  'the tooling behind the thing',
  'a reference implementation, for reading',
  'what the prototype became',
  'fixtures, generators and the odd benchmark',
  'the parts that must not break',
  'a sandbox for the next idea',
]);
const PATH_SEGMENTS: readonly string[] = Object.freeze([
  'src', 'lib', 'docs', 'test', 'scripts', 'api', 'core', 'util', 'config', 'data', 'web', 'cli', 'pkg',
  'internal', 'examples', 'assets', 'build', 'tools', 'server', 'client',
]);
const FILE_STEMS: readonly string[] = Object.freeze([
  'index', 'request', 'response', 'server', 'client', 'schema', 'parser', 'router', 'config', 'store',
  'clock', 'queue', 'render', 'format', 'validate', 'session', 'token', 'event', 'stream', 'cache',
]);
const FILE_EXTENSIONS: readonly string[] = Object.freeze(['ts', 'js', 'json', 'md', 'txt', 'yml', 'toml', 'css', 'html', 'sql']);
const BLOB_WORDS: readonly string[] = Object.freeze([
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo',
  'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor',
  'whiskey', 'xray', 'yankee', 'zulu', 'amber', 'basalt', 'cobalt', 'drift', 'ember', 'frost', 'granite',
  'hollow', 'ivory', 'jasper', 'kelp', 'lichen', 'moss', 'nickel',
]);
const COMMIT_VERBS: readonly string[] = Object.freeze([
  'Add', 'Fix', 'Refactor', 'Document', 'Test', 'Tidy', 'Speed up', 'Simplify', 'Handle', 'Extract',
  'Inline', 'Rename', 'Guard', 'Wire', 'Drop',
]);
const COMMIT_OBJECTS: readonly string[] = Object.freeze([
  'the request parser', 'repo lookup', 'issue pagination', 'the merge path', 'token checks',
  'the clone endpoint', 'packfile handling', 'error bodies', 'branch listing', 'the GraphQL node query',
  'MCP tool dispatch', 'rate limit headers', 'the upload pack', 'the ref advertisement', 'commit ancestry',
]);
const ISSUE_ADJECTIVES: readonly string[] = Object.freeze([
  'Broken', 'Slow', 'Missing', 'Confusing', 'Unexpected', 'Flaky', 'Incorrect', 'Unclear', 'Stale', 'Noisy',
]);
const ISSUE_SUBJECTS: readonly string[] = Object.freeze([
  'clone over HTTP', 'push report-status', 'issue pagination', 'merge button', 'GraphQL node ids',
  'MCP tool list', 'shallow fetch', 'tag listing', 'repo creation', 'content update', 'branch deletion',
  'commit listing',
]);
const PULL_VERBS: readonly string[] = Object.freeze(['Add', 'Fix', 'Improve', 'Simplify', 'Document', 'Refactor', 'Speed up', 'Harden']);
const PULL_SUBJECTS: readonly string[] = Object.freeze([
  'shallow fetch support', 'push report status checks', 'issue label validation', 'merge conflict detection',
  'GraphQL cursor pagination', 'MCP tool schemas', 'packfile delta reuse', 'conditional requests',
  'repo pagination', 'branch protection stubs',
]);
const SENTENCE_STARTS: readonly string[] = Object.freeze([
  'Steps to reproduce are below', 'This showed up after the last change', 'The expected behaviour is clear',
  'A minimal case is attached', 'It works on a fresh repository', 'The same flow works over the API',
]);
const SENTENCE_ENDS: readonly string[] = Object.freeze([
  'and the server answers with a JSON error', 'but the second request fails', 'and nothing is written to the log',
  'while the reply body stays empty', 'and the status is wrong for the method', 'so the client gives up',
]);
const ISSUE_LABELS: readonly string[] = Object.freeze(['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']);
const DEFAULT_BRANCHES: readonly string[] = Object.freeze(['main', 'develop', 'release/1.0']);

/** A generated user. */
export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** A generated repository. */
export interface ScenarioRepo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
}

/** A generated file path and its content (ASCII text, so bytes and characters agree). */
export interface ScenarioBlob {
  readonly path: string;
  readonly content: string;
  readonly base64: string;
}

/** A generated commit. */
export interface ScenarioCommit {
  readonly message: string;
  readonly author: ScenarioUser;
  readonly epochSec: number;
  readonly iso: string;
}

/** A generated issue template. */
export interface ScenarioIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/** A generated pull request template. */
export interface ScenarioPull {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
}

/** Everything the suite's checks name, once, from SCENARIO_SEED. */
export interface Scenario {
  readonly seed: string;
  readonly viewer: ScenarioUser;
  readonly teammate: ScenarioUser;
  readonly stranger: ScenarioUser;
  readonly users: readonly ScenarioUser[];
  readonly org: string;
  readonly repos: readonly ScenarioRepo[];
  readonly orgRepos: readonly ScenarioRepo[];
  readonly strangerRepos: readonly ScenarioRepo[];
  readonly labels: readonly string[];
  readonly branches: readonly string[];
  readonly filePaths: readonly string[];
  readonly blobs: readonly ScenarioBlob[];
  readonly commits: readonly ScenarioCommit[];
  readonly issues: readonly ScenarioIssue[];
  readonly pulls: readonly ScenarioPull[];
}

/** `count` users with unique logins, deterministic for `rng`. */
export function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push(Object.freeze({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` }));
  }
  return users;
}

/**
 * `count` repositories for `owner` with unique names, deterministic for `rng`. `firstId` keeps the
 * ids globally unique across owners (the scenario gives each owner a distinct block).
 */
export function generateRepos(rng: Rng, owner: string, count: number, firstId = 5000): ScenarioRepo[] {
  const used = new Set<string>();
  const repos: ScenarioRepo[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const base = `${rng.pick(REPO_ADJECTIVES)}-${rng.pick(REPO_NOUNS)}`;
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(name);
    repos.push(
      Object.freeze({
        id: firstId + i,
        owner,
        name,
        fullName: `${owner}/${name}`,
        description: rng.pick(REPO_DESCRIPTIONS),
        private: i % 7 === 3,
        defaultBranch: DEFAULT_BRANCH,
      }),
    );
  }
  return repos;
}

/** `count` unique file paths, deterministic for `rng`. */
export function generateFilePaths(rng: Rng, count: number): string[] {
  const used = new Set<string>();
  const paths: string[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const depth = rng.nextInt(3) === 0 ? 0 : 1 + rng.nextInt(2);
    const dirs = depth === 0 ? [] : rng.shuffle(PATH_SEGMENTS).slice(0, depth);
    const base = [...dirs, `${rng.pick(FILE_STEMS)}.${rng.pick(FILE_EXTENSIONS)}`].join('/');
    let path = base;
    let suffix = 2;
    while (used.has(path)) {
      path = [...dirs, `${suffix}-${base.split('/').pop() ?? base}`].join('/');
      suffix += 1;
    }
    used.add(path);
    paths.push(path);
  }
  return paths;
}

/** ASCII text of exactly `sizeBytes` bytes, deterministic for `rng` (the blob generator). */
export function generateBlobText(rng: Rng, sizeBytes: number): string {
  const size = Number.isFinite(sizeBytes) ? Math.max(0, Math.trunc(sizeBytes)) : 0;
  let out = '';
  while (out.length < size) {
    out += rng.pick(BLOB_WORDS);
    if (out.length < size) out += rng.chance(0.14) ? '\n' : ' ';
  }
  return out.slice(0, size);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 of bytes, no imports (the contents API's encoding). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triplet >> 18) & 63] ?? '';
    out += BASE64_ALPHABET[(triplet >> 12) & 63] ?? '';
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triplet >> 6) & 63] ?? '' : '=';
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triplet & 63] ?? '' : '=';
  }
  return out;
}

/** UTF-8 text as base64 (the contents API's encoding for a text file). */
export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** A blob at `path` of `sizeBytes` ASCII bytes, deterministic for `rng`. */
export function generateBlob(rng: Rng, path: string, sizeBytes: number): ScenarioBlob {
  const content = generateBlobText(rng, sizeBytes);
  return Object.freeze({ path, content, base64: textToBase64(content) });
}

/** A fixed, seeded timestamp for a commit: SCENARIO_EPOCH_SEC plus up to 90 days. */
export function scenarioDate(rng: Rng): { readonly epochSec: number; readonly iso: string } {
  const epochSec = SCENARIO_EPOCH_SEC + rng.nextInt(90 * 24 * 60 * 60);
  return Object.freeze({ epochSec, iso: new Date(epochSec * 1000).toISOString() });
}

/** A commit message: a verb and object, sometimes with a body line. */
export function generateCommitMessage(rng: Rng): string {
  const head = `${rng.pick(COMMIT_VERBS)} ${rng.pick(COMMIT_OBJECTS)}`;
  return rng.chance(0.35) ? `${head}\n\n${generateSentence(rng)}` : head;
}

/** A commit by `author` with a seeded timestamp and message. */
export function generateCommit(rng: Rng, author: ScenarioUser): ScenarioCommit {
  const when = scenarioDate(rng);
  return Object.freeze({ message: generateCommitMessage(rng), author, epochSec: when.epochSec, iso: when.iso });
}

/** One sentence of body text. */
export function generateSentence(rng: Rng): string {
  return `${rng.pick(SENTENCE_STARTS)} ${rng.pick(SENTENCE_ENDS)}.`;
}

/** A body of one to three sentences. */
export function generateBody(rng: Rng): string {
  const sentences: string[] = [];
  const count = 1 + rng.nextInt(3);
  for (let i = 0; i < count; i += 1) sentences.push(generateSentence(rng));
  return sentences.join(' ');
}

/** An issue template: a seeded title, body and labels. */
export function generateIssue(rng: Rng): ScenarioIssue {
  return Object.freeze({
    title: `${rng.pick(ISSUE_ADJECTIVES)} ${rng.pick(ISSUE_SUBJECTS)}`,
    body: generateBody(rng),
    labels: rng.chance(0.5) ? [rng.pick(ISSUE_LABELS)] : [],
  });
}

/** A branch name: one of the kinds and a slugged subject. */
export function generateBranchName(rng: Rng): string {
  const kind = rng.pick(['feature', 'fix', 'perf', 'docs', 'chore']);
  const subject = rng
    .pick(PULL_SUBJECTS)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${kind}/${subject}`;
}

/** A pull request template: a seeded title, body, head branch and base branch. */
export function generatePull(rng: Rng, base: string = DEFAULT_BRANCH): ScenarioPull {
  return Object.freeze({
    title: `${rng.pick(PULL_VERBS)} ${rng.pick(PULL_SUBJECTS)}`,
    body: generateBody(rng),
    head: generateBranchName(rng),
    base,
  });
}

function uniqueBranch(rng: Rng, used: Set<string>): string {
  let branch = generateBranchName(rng);
  let suffix = 2;
  while (used.has(branch)) {
    branch = `${generateBranchName(rng)}-${suffix}`;
    suffix += 1;
  }
  used.add(branch);
  return branch;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

let cachedScenario: Scenario | null = null;

/**
 * The scenario, built once from SCENARIO_SEED and frozen. Every check reads its names, paths and bytes
 * from here; two processes with this file make the same object, field for field, byte for byte.
 */
export function buildScenario(): Scenario {
  if (cachedScenario !== null) return cachedScenario;
  const users = generateUsers(scenarioRng('users'), SCENARIO_USERS);
  const viewer = users[0] as ScenarioUser;
  const teammate = users[1] as ScenarioUser;
  const stranger = users[2] as ScenarioUser;
  const orgRng = scenarioRng('org');
  const org = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;
  const branchRng = scenarioRng('branches');
  const branchSet = new Set<string>(DEFAULT_BRANCHES);
  for (let i = 0; i < 8; i += 1) uniqueBranch(branchRng, branchSet);
  const filePaths = generateFilePaths(scenarioRng('paths'), SCENARIO_FILE_PATHS);
  const blobRng = scenarioRng('blobs');
  const blobs = filePaths.slice(0, SCENARIO_BLOBS).map((path) => generateBlob(blobRng, path, 64 + blobRng.nextInt(4_033)));
  const commitRng = scenarioRng('commits');
  const commits = Array.from({ length: SCENARIO_COMMITS }, () => generateCommit(commitRng, commitRng.pick(users)));
  const issueRng = scenarioRng('issues');
  const issues = Array.from({ length: SCENARIO_ISSUES }, () => generateIssue(issueRng));
  const pullRng = scenarioRng('pulls');
  const pulls = Array.from({ length: SCENARIO_PULLS }, () => generatePull(pullRng));
  const repos = generateRepos(scenarioRng('repos.viewer'), viewer.login, SCENARIO_VIEWER_REPOS, 5000);
  const orgRepos = generateRepos(scenarioRng('repos.org'), org, SCENARIO_ORG_REPOS, 6000);
  const strangerRepos = generateRepos(scenarioRng('repos.stranger'), stranger.login, SCENARIO_STRANGER_REPOS, 7000);
  cachedScenario = deepFreeze({
    seed: SCENARIO_SEED_HEX,
    viewer,
    teammate,
    stranger,
    users,
    org,
    repos,
    orgRepos,
    strangerRepos,
    labels: ISSUE_LABELS,
    branches: [...branchSet],
    filePaths,
    blobs,
    commits,
    issues,
    pulls,
  });
  return cachedScenario;
}
