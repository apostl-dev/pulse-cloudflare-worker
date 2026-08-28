export type PulseCategory = 'interactive_agent' | 'developer_tool' | 'crawler' | 'human_browser' | 'unknown_automation';
export type PulseConfidence = 'high' | 'medium' | 'low';
export type PulseSurface = 'html' | 'markdown' | 'llms' | 'mcp' | 'skill' | 'api' | 'other';
export type PulseAcceptFamily = 'html' | 'markdown' | 'json' | 'other';

export interface Env {
  APOSTL_PULSE_API_KEY?: string;
  APOSTL_PULSE_ENDPOINT?: string;
  APOSTL_PULSE_ENVIRONMENT?: string;
}

export interface PulseEvent {
  event_id: string;
  occurred_at: string;
  session_id: string;
  ip: string;
  user_agent: string;
  page_url: string;
  page_path: string;
  category: PulseCategory;
  confidence: PulseConfidence;
  agent_family: string;
  accept_family: PulseAcceptFamily;
  surface: PulseSurface;
  surface_name: string;
  method: string;
  status_code: number;
  duration_ms: number;
  eligible: boolean;
  public_api_route: boolean;
  classification_reason: string;
}

export interface PulseBatch {
  schema_version: 2;
  sent_at: string;
  events: PulseEvent[];
}

export interface PulseWorker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

export interface PulseWorkerDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  clockMs?: () => number;
  randomUUID?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface CanonicalPage {
  url: string;
  path: string;
}

const DEFAULT_ENDPOINT = 'https://ingest.apostl.dev';
const SCHEMA_VERSION = 2 as const;
const DELIVERY_TIMEOUT_MS = 1_000;
const MAX_USER_AGENT_LENGTH = 1_024;
const SUPPORTED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const RETRYABLE_STATUS = new Set([429]);
export const PULSE_VERIFICATION_CHALLENGE_HEADER = 'x-apostl-pulse-challenge';
export const PULSE_VERIFICATION_PROOF_HEADER = 'x-apostl-pulse-proof';
export const PULSE_VERIFICATION_PAGE_HEADER = 'x-apostl-pulse-page';

export function createPulseWorker(dependencies: PulseWorkerDependencies = {}): PulseWorker {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  const clockMs = dependencies.clockMs ?? (() => performance.now());
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  return {
    async fetch(request, env, ctx) {
      const startedAt = clockMs();
      const response = await fetcher(request);
      const finishedAt = clockMs();
      const configuration = configure(env);

      if (!configuration) return response;

      const tracking = trackRequest({
        request,
        response,
        durationMs: clamp(finishedAt - startedAt, 0, 300_000),
        configuration,
        fetcher,
        now,
        randomUUID,
        sleep,
      }).catch(() => undefined);
      ctx.waitUntil(tracking);

      return addVerificationHeaders(request, response, configuration.apiKey);
    },
  };
}

interface Configuration {
  apiKey: string;
  endpoint: string;
  environment: string;
}

interface TrackRequestInput {
  request: Request;
  response: Response;
  durationMs: number;
  configuration: Configuration;
  fetcher: typeof globalThis.fetch;
  now: () => Date;
  randomUUID: () => string;
  sleep: (milliseconds: number) => Promise<void>;
}

async function trackRequest(input: TrackRequestInput): Promise<void> {
  const method = input.request.method.toUpperCase();
  if (!SUPPORTED_METHODS.has(method)) return;

  const ip = canonicalIp(input.request.headers.get('cf-connecting-ip') ?? '');
  if (!ip) return;

  const occurredAt = input.now();
  const page = canonicalPage(input.request.url);
  if (!page) return;

  const userAgent = canonicalUserAgent(input.request.headers.get('user-agent') ?? 'unknown');
  const accept = input.request.headers.get('accept') ?? '';
  const acceptFamily = classifyAccept(accept);
  const classification = classify(userAgent, accept);
  const surface = inferSurface(page.path, acceptFamily, input.response.headers.get('content-type') ?? '');
  const event: PulseEvent = {
    event_id: input.randomUUID(),
    occurred_at: occurredAt.toISOString(),
    session_id: await sessionId(input.configuration.apiKey, input.configuration.environment, ip, userAgent, occurredAt),
    ip,
    user_agent: userAgent,
    page_url: page.url,
    page_path: page.path,
    category: classification.category,
    confidence: classification.confidence,
    agent_family: classification.agentFamily,
    accept_family: acceptFamily,
    surface,
    surface_name: surfaceName(page.path, surface),
    method,
    status_code: clamp(input.response.status, 100, 599),
    duration_ms: input.durationMs,
    eligible: true,
    public_api_route: page.path === '/api/mcp' || page.path === '/api/turnstile-config',
    classification_reason: classification.reason,
  };
  const batch: PulseBatch = {
    schema_version: SCHEMA_VERSION,
    sent_at: occurredAt.toISOString(),
    events: [event],
  };

  await deliver(batch, input.configuration, input.fetcher, input.sleep);
}

async function deliver(
  batch: PulseBatch,
  configuration: Configuration,
  fetcher: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const body = JSON.stringify(batch);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetcher(`${configuration.endpoint}/api/v1/pulse/events/batch`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${configuration.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch {
      return;
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 202) return;
    if ((!RETRYABLE_STATUS.has(response.status) && response.status < 500) || attempt === 3) return;
    await sleep(50 * (2 ** (attempt - 1)));
  }
}

async function addVerificationHeaders(request: Request, response: Response, apiKey: string): Promise<Response> {
  const challenge = (request.headers.get(PULSE_VERIFICATION_CHALLENGE_HEADER) ?? '').trim();
  if (!/^verify-[A-Za-z0-9_-]{16,128}$/.test(challenge)) return response;

  const page = canonicalPage(request.url);
  if (!page) return response;
  const message = `pulse-verify-v1\n${challenge}\n${page.url}`;
  const proof = await hmacHex(apiKey, message);
  const verifiedResponse = new Response(response.body, response);
  verifiedResponse.headers.set(PULSE_VERIFICATION_PROOF_HEADER, `v1:${proof}`);
  verifiedResponse.headers.set(PULSE_VERIFICATION_PAGE_HEADER, page.url);

  return verifiedResponse;
}

function configure(env: Env): Configuration | null {
  const apiKey = String(env.APOSTL_PULSE_API_KEY ?? '').trim();
  if (!isApiKey(apiKey)) return null;

  const endpoint = String(env.APOSTL_PULSE_ENDPOINT ?? DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch {
    return null;
  }

  return {
    apiKey,
    endpoint,
    environment: safeLabel(env.APOSTL_PULSE_ENVIRONMENT ?? 'production', 'production'),
  };
}

async function sessionId(apiKey: string, environment: string, ip: string, userAgent: string, timestamp: Date): Promise<string> {
  const epoch = Math.floor(timestamp.getTime() / 3_600_000) - (timestamp.getUTCMinutes() < 5 ? 1 : 0);
  const identity = JSON.stringify([environment, ip, userAgent, epoch]);

  return hmacHex(apiKey, identity);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));

  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function classify(userAgent: string, accept: string): { category: PulseCategory; confidence: PulseConfidence; agentFamily: string; reason: string } {
  const ua = userAgent.toLowerCase();
  const patterns: Array<[string, PulseCategory, PulseConfidence, string, string]> = [
    ['chatgpt-user', 'interactive_agent', 'high', 'chatgpt', 'known_chatgpt_user_agent'],
    ['openai-operator', 'interactive_agent', 'high', 'openai-operator', 'known_openai_operator'],
    ['claude-code', 'developer_tool', 'high', 'claude-code', 'known_claude_code'],
    ['codex', 'developer_tool', 'high', 'codex', 'known_codex'],
    ['cursor', 'developer_tool', 'high', 'cursor', 'known_cursor'],
    ['github-copilot', 'developer_tool', 'high', 'github-copilot', 'known_copilot'],
    ['googlebot', 'crawler', 'high', 'googlebot', 'known_googlebot'],
    ['gptbot', 'crawler', 'high', 'gptbot', 'known_gptbot'],
    ['claudebot', 'crawler', 'high', 'claudebot', 'known_claudebot'],
    ['perplexitybot', 'crawler', 'high', 'perplexitybot', 'known_perplexitybot'],
  ];
  for (const [needle, category, confidence, agentFamily, reason] of patterns) {
    if (ua.includes(needle)) return { category, confidence, agentFamily, reason };
  }
  if (/mozilla\/5\.0.*(?:chrome|safari|firefox|edg)/i.test(userAgent)) {
    return { category: 'human_browser', confidence: 'high', agentFamily: 'browser', reason: 'browser_signature' };
  }
  if (classifyAccept(accept) === 'markdown') {
    return { category: 'unknown_automation', confidence: 'medium', agentFamily: 'unknown', reason: 'markdown_accept' };
  }

  return { category: 'unknown_automation', confidence: 'low', agentFamily: 'unknown', reason: 'unrecognized_client' };
}

function classifyAccept(accept: string): PulseAcceptFamily {
  const value = accept.toLowerCase();
  if (value.includes('text/markdown') || value.includes('text/x-markdown')) return 'markdown';
  if (value.includes('application/json')) return 'json';
  if (value.includes('text/html')) return 'html';
  return 'other';
}

function inferSurface(path: string, accept: PulseAcceptFamily, contentType: string): PulseSurface {
  const normalized = path.toLowerCase();
  if (/^\/llms(?:-full)?\.txt$/.test(normalized)) return 'llms';
  if (normalized === '/api/mcp') return 'mcp';
  if (normalized.startsWith('/.well-known/skills/') || normalized.endsWith('/skill.md')) return 'skill';
  if (normalized.endsWith('.md')) return 'markdown';
  if (normalized === '/openapi.json' || normalized.startsWith('/api/')) return 'api';
  if (accept === 'markdown') return 'markdown';
  if (accept === 'json' || contentType.toLowerCase().includes('application/json')) return 'api';
  if (accept === 'html' || contentType.toLowerCase().includes('text/html')) return 'html';
  return 'other';
}

function surfaceName(path: string, surface: PulseSurface): string {
  const normalized = path.toLowerCase();
  if (normalized === '/llms.txt') return 'llms-index';
  if (normalized === '/llms-full.txt') return 'llms-full';
  if (surface === 'mcp') return 'mcp';
  if (normalized === '/openapi.json') return 'openapi';
  return surface;
}

function canonicalPage(input: string): CanonicalPage | null {
  if (!input || input.length > 4_096) return null;
  try {
    const parsed = new URL(input);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return null;
    parsed.search = '';
    parsed.hash = '';
    const path = parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') || '/' : '/';
    const url = `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
    if (url.length > 2_048 || path.length > 1_024) return null;

    return { url, path };
  } catch {
    return null;
  }
}

function canonicalIp(input: string): string {
  const candidate = input.split(',')[0]?.trim().toLowerCase() ?? '';
  if (!candidate) return '';
  const ipv4 = candidate.split('.');
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)) {
    return candidate;
  }
  if (!candidate.includes(':') || !/^[0-9a-f:.]+$/.test(candidate)) return '';
  try {
    const parsed = new URL(`http://[${candidate}]/`);
    if (!parsed.hostname.startsWith('[') || !parsed.hostname.endsWith(']')) return '';
    return candidate;
  } catch {
    return '';
  }
}

function canonicalUserAgent(input: string): string {
  return String(input).trim().slice(0, MAX_USER_AGENT_LENGTH) || 'unknown';
}

function isApiKey(input: string): boolean {
  return (input.startsWith('pulse_api_') || input.startsWith('pulse_wk_')) && input.length >= 32;
}

function safeLabel(input: string, fallback: string): string {
  const label = String(input).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return label || fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

const worker = createPulseWorker();

export default worker satisfies ExportedHandler<Env>;
