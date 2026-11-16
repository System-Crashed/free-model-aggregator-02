// free-model-aggregator-02's starter kit: one server, two client wires, and a real free model behind
// every answer.
//
// This is a working entry to start from, not a competitive answer. It is the house baseline for the
// bounty, deliberately weak, and worth a fraction of the score: use it to see the shape of a trial, then
// replace its routing, its failover and its catalog with your own. The gaps are marked TODO below.
//
// WHAT A TRIAL GIVES YOU
//   A trial runs this server as `node /bot/main.ts` from your repository's root, with Node 22's standard
//   library alone (nothing is installed; TypeScript runs directly, and a relative import needs its .ts
//   extension). The env is at $MAKEFUN_ENV_URL; your model calls go through the grader's gateway at
//   $OPENAI_BASE_URL, an OpenAI-compatible endpoint that reaches OpenRouter on the key you pushed to the
//   competition. The brief at $MAKEFUN_PROMPT_FILE carries two documents:
//     - the free model list: each free OpenRouter model's gateway id
//       (`openrouter/<vendor>/<model>:free`), its published rating in milli-points, what it can do
//       (tools, vision, JSON mode, context length) and its free flag;
//     - the six prompts: each one's id, its api (openai or anthropic), whether it streams, its weight
//       (1 or 2) and the requirements a model must meet to serve it. Each prompt carries a unique token
//       the answer must contain.
//   The server:
//     1. listens on 0.0.0.0 at a free port (never 8080: the env itself is there on one layout);
//     2. POSTs $MAKEFUN_ENV_URL/register {"protocol_version": 1, "port": <port>, "catalog": <catalog>};
//     3. serves GET /v1/models (answering in the shape of the auth header it got: x-api-key means
//        Anthropic, Authorization means OpenAI), POST /v1/chat/completions and POST /v1/messages, each
//        with a JSON body or with server-sent events;
//     4. answers each prompt by dialling ONE free model through the gateway. OPENAI_API_KEY in the
//        sandbox is a dummy the gateway swaps for the OpenRouter key you pushed; the real key never
//        enters the sandbox;
//     5. polls GET $MAKEFUN_ENV_URL/work every 100 ms and exits 0 when the env says {"done": true}. A
//        process still running when the wall ends scores zero, so never wait for anything else.
//   `node main.ts --list` prints the same catalog JSON and exits 0 before any server starts; the
//   register body's catalog is that same document, byte for byte.
//
// THE MODEL RULE
//   Whatever this server reports in a response's `model` field must be the model it actually dialled.
//   The house records every gateway call and scores the model that really answered. This starter sends
//   the brief's model id in the gateway request and puts that same id back on every answer and every
//   streamed chunk (the provider's own answer spells it without the gateway's `openrouter/` prefix), so
//   its claim is the call it made, never another. A prompt whose reported model has no matching
//   successful call in the house's record earns nothing.
//
// ROUTING (implemented; verified against the kit's practice trials 0-2, 2026-11-16)
//   Capability-based, never prompt-id-based: the JSON-mode prompts move between trials
//   (t0: p01/p04, t1/t2: p04/p06), so routing reads each request's own requirements.
//   Candidates meeting the requirements are ranked by the brief's rating_milli, best first:
//     - every prompt -> openrouter/nvidia/nemotron-3.5-super-vl:free (1303, best
//       JSON-capable AND answers plain text; verified live 2026-11-16: HTTP 200, exact answer)
//     - inkling-2-small (1475) is EXCLUDED: verified live 2026-11-16 it returns HTTP 403
//       "only available on agentic harnesses" on the public API, and no leaderboard entry
//       is above quality 90, so it does not answer through the gateway either. Dialling it
//       first would burn one extra gateway call per non-JSON prompt (10 calls instead of 6)
//       and lose the fewer-calls tie-break.
//     - fallback order by rating: nemotron-3-ultra (1285), nemotron-3.5-lightning (1221),
//       gemma-4-31b (1210), then the 1150s. Super-VL on all 6 prompts = quality 90,
//       score 94 (6 calls), tying the leaderboard's top tie of 94 (earned 10424, bound
//       11456, quality floor(90.99)=90). Ultra + Super-VL = quality 90 / score 94, the
//       same tie. Score 94 is the ceiling without inkling (blocked); the edge is
//       robustness in the final's 3 trials, not a higher single-trial score.
//   Failover (10%): a 429/5xx refusal is retried once on the same model, then the prompt moves
//   to the next candidate (max 4 distinct models per prompt). A model that refuses twice is
//   exhausted for the rest of the trial. A 401/400 is not a model refusal: the prompt is given
//   up at once instead of burning calls on models that would refuse the same way. Every
//   refusal behind a served prompt is reported in `x-makefun-upstream-failures` (max 8 rows),
//   the only way the failover column can see a recovered refusal.
//   Determinism: routing depends only on the brief, the prompt order and the refusal history
//   (no clock, no randomness), so a replay from the gateway cassette makes the same calls.
//   The catalog (5%) is kept exact: all fourteen free ids, on both auth headers.
//   The trial's rules are in the kit's RULES.txt; read them for the score's columns and the tie-break.
//
// FILES
//   main.ts            this server: the brief, the catalog, the routes, the register and the poll.
//   lib/providers.ts   the brief's types and parser, the free model list, the catalog.
//   lib/wire.ts        Anthropic <-> Chat Completions translation, the model field, the SSE writers.
//   LICENSE            MIT: keep it or replace it with another OSI-approved license.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this baseline reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/** One refusal behind a prompt this server still served, for the failover trail header. */
interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

/** Models that refused twice in this trial: never dialled again (deterministic, no clock). */
const exhausted = new Set<string>();

/** The most distinct models one prompt may try, and the most trail rows one answer may carry. */
const MAX_MODELS_PER_PROMPT = 4;
const MAX_TRAIL_ROWS = 8;

/**
 * Models verified to refuse on the public gateway and never dialled: inkling-2-small
 * returns HTTP 403 "only available on agentic harnesses" on a live call (2026-11-16),
 * and no leaderboard entry is above quality 90, so it does not answer via the gateway.
 */
const BLOCKED_MODELS = new Set(['openrouter/thinkingmachines/inkling-2-small:free']);

/**
 * The free models that can serve a request, best rating first. Exhausted models are left out;
 * when every candidate is exhausted the full list is returned, so a prompt is still attempted
 * rather than given up without a call. Array.sort is stable, so equal ratings keep brief order.
 */
function rankedCandidates(requires: Requirement): ModelRow[] {
  const meeting = freeModels(brief).filter((model) => !BLOCKED_MODELS.has(model.id) && meetsRequirements(requires, capabilitiesOf(model)));
  const ranked = [...meeting].sort((a, b) => b.rating_milli - a.rating_milli);
  const fresh = ranked.filter((model) => !exhausted.has(model.id));
  return fresh.length > 0 ? fresh : ranked;
}

/** A short error code for one refused gateway call, read off its error body when possible. */
function failureCode(status: number, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      if (typeof parsed.error.code === 'string' && parsed.error.code !== '') return parsed.error.code.slice(0, 64);
      if (typeof parsed.error.type === 'string' && parsed.error.type !== '') return parsed.error.type.slice(0, 64);
    }
  } catch {
    // Not JSON: fall through to the status-derived code.
  }
  if (status === 429) return 'rate_limited';
  if (status === 502) return 'bad_gateway';
  if (status === 503) return 'service_unavailable';
  if (status >= 500) return 'upstream_error';
  return 'upstream_error';
}

type ServedUpstream =
  | { ok: true; model: string; upstream: Response; failures: UpstreamFailure[] }
  | { ok: false; status: number; failures: UpstreamFailure[] };

/**
 * Dial the gateway for one prompt until a model answers or the candidates run out. Each model
 * gets one immediate retry on a 429/5xx refusal; a second refusal exhausts it for the trial.
 * A 4xx other than 429 (bad key, bad body) is not a model refusal, so the prompt is given up
 * at once instead of spending calls on models that would refuse the same way. A refusal the
 * server recovers from is kept in `failures` for the `x-makefun-upstream-failures` header.
 */
async function serveUpstream(body: Json, candidates: ModelRow[]): Promise<ServedUpstream> {
  const failures: UpstreamFailure[] = [];
  let lastStatus = 502;
  let tried = 0;
  // Super-VL reasons before it answers, and that reasoning eats the prompt's
  // max_tokens budget: a 258-token cap can truncate the answer itself. Boost
  // the upstream cap to 2000 (deterministic, a function of the body alone) so
  // the model has room to reason and still return the exact token.
  const dialBody: Json = {
    ...body,
    max_tokens: Math.max(typeof body.max_tokens === 'number' ? body.max_tokens : 0, 2000),
  };
  for (const model of candidates) {
    if (tried >= MAX_MODELS_PER_PROMPT) break;
    tried += 1;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let upstream: Response;
      try {
        upstream = await dial(model.id, { ...dialBody, model: model.id });
      } catch (err) {
        lastStatus = 502;
        if (failures.length < MAX_TRAIL_ROWS) {
          failures.push({ status: 502, code: 'upstream_unreachable', model: model.id });
        }
        log(`gateway unreachable dialling ${model.id}: ${(err as Error).message}`);
        if (attempt === 0) continue;
        exhausted.add(model.id);
        break;
      }
      if (upstream.ok && upstream.body !== null) {
        return { ok: true, model: model.id, upstream, failures };
      }
      lastStatus = upstream.status;
      if (upstream.status !== 429 && upstream.status < 500) {
        await upstream.text().catch(() => '');
        return { ok: false, status: upstream.status, failures };
      }
      const text = await upstream.text().catch(() => '');
      if (failures.length < MAX_TRAIL_ROWS) {
        failures.push({ status: upstream.status, code: failureCode(upstream.status, text), model: model.id });
      }
      log(`gateway refused ${model.id} with HTTP ${upstream.status} (attempt ${attempt + 1})`);
      if (attempt === 0) continue;
      exhausted.add(model.id);
    }
  }
  return { ok: false, status: lastStatus, failures };
}

/** The failover trail header for a served prompt, or no header when nothing refused. */
function failuresHeader(failures: UpstreamFailure[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(failures.slice(0, MAX_TRAIL_ROWS)) };
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  // TODO(workload): the brief's prompt list is the declared source of each request's requirements; this
  // fallback is a guess for a brief that holds none.
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
}

/** A refused or broken gateway call as a 502 in the client's wire: the prompt is lost. */
function refused(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, text: string): void {
  if (wire === 'anthropic') {
    sendError(res, wire, 502, 'api_error', `the gateway answered HTTP ${status}${text === '' ? '' : `: ${text.slice(0, 500)}`}`);
  } else {
    sendError(res, wire, 502, 'upstream_error', `the gateway answered HTTP ${status}${text === '' ? '' : `: ${text.slice(0, 500)}`}`);
  }
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const candidates = rankedCandidates(requirementsFor(body));
  if (candidates.length === 0) return sendError(res, 'openai', 503, 'no_free_model', 'no free model in the brief meets this request');
  const served = await serveUpstream(body, candidates);
  if (!served.ok) {
    return refused(res, 'openai', served.status, `the gateway refused every free model that meets this request (last HTTP ${served.status})`);
  }
  const upstream = served.upstream;
  const model = served.model;
  const trail = failuresHeader(served.failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...trail });
    try {
      for await (const frame of openAIStreamWithModel(upstream.body, model)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, model), trail);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const candidates = rankedCandidates(requirementsFor(body));
  if (candidates.length === 0) return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model in the brief meets this request');
  const served = await serveUpstream(anthropicToOpenAI(body, candidates[0].id), candidates);
  if (!served.ok) {
    return refused(res, 'anthropic', served.status, `the gateway refused every free model that meets this request (last HTTP ${served.status})`);
  }
  const upstream = served.upstream;
  const model = served.model;
  const trail = failuresHeader(served.failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...trail });
    try {
      for await (const event of anthropicEventsFromOpenAI(upstream.body, model)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, model), trail);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
