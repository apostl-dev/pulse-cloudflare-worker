import assert from 'node:assert/strict';
import test from 'node:test';
import { createPulseWorker, type Env, type PulseBatch } from '../src/index.js';

const API_KEY = `pulse_api_${'a'.repeat(48)}`;

interface HarnessOptions {
  originStatus?: number;
  originBody?: string;
  originHeaders?: HeadersInit;
  ingestStatus?: number;
}

function harness(options: HarnessOptions = {}) {
  const deliveries: PulseBatch[] = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  let clock = 1_000;
  const worker = createPulseWorker({
    fetch: async (input, init) => {
      if (input instanceof Request) {
        return new Response(options.originBody ?? 'origin-body', {
          status: options.originStatus ?? 200,
          headers: options.originHeaders ?? { 'content-type': 'text/html', 'x-origin': 'kept' },
        });
      }
      deliveries.push(JSON.parse(String(init?.body)) as PulseBatch);
      return new Response(JSON.stringify({
        accepted_event_ids: [deliveries.at(-1)?.events[0]?.event_id],
        rejected: [],
      }), {
        status: options.ingestStatus ?? 202,
        headers: { 'content-type': 'application/json' },
      });
    },
    now: () => new Date('2026-08-29T12:30:00.000Z'),
    clockMs: () => {
      clock += 17;
      return clock;
    },
    randomUUID: () => '018f8f6d-5e6a-7b8c-9d0e-1f2a3b4c5d6e',
    sleep: async () => {},
  });
  const env: Env = {
    APOSTL_PULSE_API_KEY: API_KEY,
    APOSTL_PULSE_ENDPOINT: 'https://ingest.example.test/',
    APOSTL_PULSE_ENVIRONMENT: 'production',
  };
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;

  return {
    worker,
    env,
    ctx,
    deliveries,
    async settled() {
      await Promise.all(waitUntilPromises);
    },
  };
}

function request(path = '/docs', init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '203.0.113.42');
  if (!headers.has('user-agent')) headers.set('user-agent', 'FutureAgent/9.4 (+https://agent.example)');
  if (!headers.has('accept')) headers.set('accept', 'text/markdown');

  return new Request(`https://Example.COM${path}`, { ...init, headers });
}

test('proxies the origin unchanged and delivers an unknown future agent without gating', async () => {
  const h = harness({ originStatus: 207, originBody: 'kept exactly', originHeaders: { 'content-type': 'text/plain', 'x-origin': 'kept' } });
  const response = await h.worker.fetch(request('/docs/guide?token=must-not-leak#fragment'), h.env, h.ctx);

  assert.equal(response.status, 207);
  assert.equal(response.headers.get('x-origin'), 'kept');
  assert.equal(await response.text(), 'kept exactly');
  assert.equal(h.deliveries.length, 0, 'delivery must be background work');
  await h.settled();

  assert.equal(h.deliveries.length, 1);
  const payload = h.deliveries[0]!;
  assert.equal(payload.schema_version, 2);
  assert.equal(payload.events.length, 1);
  const event = payload.events[0]!;
  assert.equal(event.ip, '203.0.113.42');
  assert.equal(event.user_agent, 'FutureAgent/9.4 (+https://agent.example)');
  assert.equal(event.page_url, 'https://example.com/docs/guide');
  assert.equal(event.page_path, '/docs/guide');
  assert.equal(event.category, 'unknown_automation');
  assert.equal(event.confidence, 'medium');
  assert.equal(event.agent_family, 'unknown');
  assert.equal(event.method, 'GET');
  assert.equal(event.status_code, 207);
  assert.equal(event.duration_ms, 17);
  assert.match(event.session_id, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(payload), /must-not-leak|fragment/);
});

test('tracks browsers, assets, private-looking paths, mutations, and 5xx responses', async () => {
  const cases: Array<{ path: string; init?: RequestInit; status: number }> = [
    { path: '/', init: { headers: { 'user-agent': 'Mozilla/5.0 Chrome/140', 'cf-connecting-ip': '198.51.100.4' } }, status: 200 },
    { path: '/assets/app.js', status: 200 },
    { path: '/auth/reset/secret-looking-path', status: 200 },
    { path: '/api/orders', init: { method: 'POST', body: '{"card":"never-send"}', headers: { 'content-type': 'application/json', authorization: 'Bearer never-send', cookie: 'sid=never-send' } }, status: 201 },
    { path: '/broken', status: 503 },
  ];

  for (const entry of cases) {
    const h = harness({ originStatus: entry.status });
    await h.worker.fetch(request(entry.path, entry.init), h.env, h.ctx);
    await h.settled();
    assert.equal(h.deliveries.length, 1, `${entry.path} should be tracked`);
    const raw = JSON.stringify(h.deliveries[0]);
    assert.doesNotMatch(raw, /card|Bearer|sid=never-send/);
    assert.equal(h.deliveries[0]?.events[0]?.status_code, entry.status);
    assert.equal(h.deliveries[0]?.events[0]?.method, entry.init?.method ?? 'GET');
  }
});

test('records IPv6 and bounds the full User-Agent to the ingest maximum', async () => {
  const h = harness();
  const longAgent = `NovelAgent/${'x'.repeat(2_000)}`;
  await h.worker.fetch(request('/openapi.json', {
    headers: {
      'cf-connecting-ip': '2001:db8:abcd:12::4',
      'user-agent': longAgent,
      accept: 'application/json',
    },
  }), h.env, h.ctx);
  await h.settled();

  const event = h.deliveries[0]!.events[0]!;
  assert.equal(event.ip, '2001:db8:abcd:12::4');
  assert.equal(event.user_agent.length, 1024);
  assert.equal(event.surface, 'api');
});

test('derives the same hourly HMAC session identity as pulse-sdk', async () => {
  let delivered: PulseBatch | null = null;
  const waitUntilPromises: Promise<unknown>[] = [];
  const worker = createPulseWorker({
    fetch: async (input, init) => {
      if (input instanceof Request) return new Response('ok');
      delivered = JSON.parse(String(init?.body)) as PulseBatch;
      return new Response('{}', { status: 202 });
    },
    now: () => new Date('2026-08-25T12:30:00.000Z'),
    randomUUID: () => '018f8f6d-5e6a-7b8c-9d0e-1f2a3b4c5d6e',
  });
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;
  await worker.fetch(request('/docs', {
    headers: {
      'cf-connecting-ip': '203.0.113.42',
      'user-agent': 'ChatGPT-User/1.0',
      accept: 'text/markdown',
    },
  }), {
    APOSTL_PULSE_API_KEY: `pulse_api_${'a'.repeat(48)}`,
    APOSTL_PULSE_ENVIRONMENT: 'production',
  }, ctx);
  await Promise.all(waitUntilPromises);

  const pulseDelivery = delivered as PulseBatch | null;
  assert.ok(pulseDelivery);
  assert.equal(
    pulseDelivery.events[0]?.session_id,
    'cc88c7a5ab5992ccba6d890dc430b89373bb7bbd81eae859ed2d608d12f1fc15',
  );
});

test('proxies but does not deliver when the trusted Cloudflare IP is missing or invalid', async () => {
  for (const ip of ['', 'not-an-ip', '999.1.1.1']) {
    const h = harness();
    const headers = new Headers({ 'user-agent': 'FutureAgent/1' });
    if (ip) headers.set('cf-connecting-ip', ip);
    const response = await h.worker.fetch(new Request('https://example.com/', { headers }), h.env, h.ctx);
    await h.settled();
    assert.equal(response.status, 200);
    assert.equal(h.deliveries.length, 0);
  }
});

test('never exposes request secrets in the payload', async () => {
  const h = harness();
  await h.worker.fetch(request('/account/alice?api_key=query-secret#fragment-secret', {
    method: 'PUT',
    body: 'body-secret',
    headers: {
      authorization: 'Bearer auth-secret',
      cookie: 'session=cookie-secret',
      'x-private': 'header-secret',
      'cf-connecting-ip': '203.0.113.8',
      'user-agent': 'UnknownClient/1',
    },
  }), h.env, h.ctx);
  await h.settled();

  const raw = JSON.stringify(h.deliveries[0]);
  for (const secret of ['query-secret', 'fragment-secret', 'body-secret', 'auth-secret', 'cookie-secret', 'header-secret']) {
    assert.doesNotMatch(raw, new RegExp(secret));
  }
});

test('Pulse delivery failure is contained and does not affect the origin response', async () => {
  let calls = 0;
  const waitUntilPromises: Promise<unknown>[] = [];
  const worker = createPulseWorker({
    fetch: async (input) => {
      if (input instanceof Request) return new Response('origin-ok', { status: 200 });
      calls += 1;
      throw new Error('Pulse is unavailable');
    },
    sleep: async () => {},
  });
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;
  const response = await worker.fetch(request('/'), { APOSTL_PULSE_API_KEY: API_KEY }, ctx);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'origin-ok');
  await assert.doesNotReject(() => Promise.all(waitUntilPromises));
  assert.equal(calls, 1);
});

test('retries only retryable ingest responses with bounded backoff', async () => {
  let ingestCalls = 0;
  const backoffs: number[] = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  const worker = createPulseWorker({
    fetch: async (input) => {
      if (input instanceof Request) return new Response('origin-ok');
      ingestCalls += 1;
      return new Response('{}', { status: ingestCalls < 3 ? 503 : 202 });
    },
    sleep: async (milliseconds) => {
      backoffs.push(milliseconds);
    },
  });
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;
  await worker.fetch(request('/'), { APOSTL_PULSE_API_KEY: API_KEY }, ctx);
  await Promise.all(waitUntilPromises);

  assert.equal(ingestCalls, 3);
  assert.deepEqual(backoffs, [50, 100]);
});

test('adds pulse-sdk-compatible verification headers for a valid challenge', async () => {
  const h = harness();
  const response = await h.worker.fetch(request('/docs?secret=removed', {
    headers: {
      'cf-connecting-ip': '203.0.113.42',
      'user-agent': 'Codex/1.0',
      'x-apostl-pulse-challenge': 'verify-abcdefghijklmnop',
    },
  }), h.env, h.ctx);

  assert.equal(response.headers.get('x-apostl-pulse-page'), 'https://example.com/docs');
  assert.match(response.headers.get('x-apostl-pulse-proof') ?? '', /^v1:[a-f0-9]{64}$/);
  await h.settled();
});

test('is a safe no-op when the API key is absent', async () => {
  const h = harness();
  const response = await h.worker.fetch(request('/'), {}, h.ctx);
  await h.settled();

  assert.equal(response.status, 200);
  assert.equal(h.deliveries.length, 0);
  assert.equal(response.headers.has('x-apostl-pulse-proof'), false);
});
