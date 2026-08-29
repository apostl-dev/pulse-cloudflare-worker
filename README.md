<p align="center">
  <img src="https://raw.githubusercontent.com/apostl-dev/pulse-sdk/main/docs/pulse-readme.svg" alt="Apostl Pulse — live AI agent traffic signal" width="100%" />
</p>

# Apostl Pulse for Cloudflare

Understand every request reaching your Cloudflare zone and discover AI agents
before their User-Agents are known.

This open-source Worker runs in front of your existing origin. It forwards the
request unchanged, then sends a server-side observation to Apostl Pulse in
background. No browser JavaScript and no application middleware are required.

- Tracks every request supported by Pulse v2, not only known bots.
- Includes the trusted Cloudflare client IP and full bounded User-Agent.
- Keeps classification in Pulse so new agents appear without a Worker update.
- Never sends query strings, fragments, bodies, cookies, authorization, or
  arbitrary request headers.
- Fails open: Pulse delivery cannot break or delay the origin response.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/apostl-dev/pulse-cloudflare-worker)

## Choose the collector before deployment

Use this Worker only for a confirmed Cloudflare-proxied hostname when you can attach or edit the matching Worker route. Confirm the exact hostname in the
Cloudflare control plane when possible; Cloudflare nameservers alone do not
prove that its DNS record is proxied. A trusted live edge signal such as
`CF-Ray` can support the decision when route authority is also available.

- For an existing origin behind Cloudflare, deploy this Worker on the narrowest
  matching route. Do not use a Worker Custom Domain that points back to the
  existing hostname; that can bypass the origin or create a loop.
- If the hostname is already served by a Cloudflare Worker or Pages app,
  integrate this template's observation logic into that controlled edge runtime
  or use an explicitly supported non-looping route. Do not stack a second
  Worker in front blindly.
- For an ordinary supported server that is not routed through Cloudflare, use
  [`@apostl-dev/pulse-sdk`](https://github.com/apostl-dev/pulse-sdk) in the
  existing server instead.
- If the record is DNS-only, the hostname is unreachable, Cloudflare status is
  ambiguous, or route/source authority is missing, stop and obtain that fact or
  permission. Do not guess, substitute another hostname, or silently choose a
  collector.

Exactly one Pulse collector may own a request path. Do not run this Worker and
the server SDK on the same hostname and route unless the owner has explicitly
authorized a measured migration with deduplication proof.

The canonical public
[`agent-traffic-analytics` skill](https://github.com/apostl-dev/apostl-skills/tree/main/skills/agent-traffic-analytics)
contains the complete route-selection, setup, verification, and claim workflow.
Its public files can be read directly; a global skill install is not required.

## One-line install

Give this copy-paste instruction to your AI agent:

```sh
Set up Apostl Pulse by following the public agent-traffic-analytics skill at https://github.com/apostl-dev/apostl-skills/tree/main/skills/agent-traffic-analytics and the canonical Auth.md instructions at https://apostl.dev/auth.md. Inspect the exact hostname and deployment authority first. Use https://github.com/apostl-dev/pulse-cloudflare-worker only when that hostname is confirmed Cloudflare-proxied and you can attach a narrow, non-looping route; otherwise use https://github.com/apostl-dev/pulse-sdk in the supported origin server, or stop with the missing fact or permission. Deploy exactly one collector for each request path. Obtain the key through the skill's accountless setup helper, transfer it directly from its owner-only credentials file into the server-side secret APOSTL_PULSE_API_KEY, prove one genuine public event in Cloudflare and Pulse, and never print or return any raw credential.
```

## Obtain a key safely without an account

You need a Pulse API key, but a human account is not required for initial
setup. Have your agent follow the public skill's **Start through Auth.md without
an account** flow and the canonical [`Auth.md`](https://apostl.dev/auth.md)
instructions. That flow validates the live discovery metadata before mutation,
registers an unclaimed installation for the authorized origin, and writes its
one-time credentials to an owner-only `0600` file.

The agent should transfer the saved `api_key` directly from that file into
Wrangler's secret prompt or authorized Cloudflare secret tooling. Do not use an
ad hoc credential `curl` command whose JSON response goes to stdout. Never
print, log, paste into chat, commit, or return the raw API key, setup token,
claim capability, identity assertion, or access token. If the agent cannot move
the key from local protected storage into the Worker secret without exposing
it, stop and ask for a safe secret-runtime path rather than asking the owner to
paste it into chat.

The owner claims the verified installation afterward using the non-secret
verification URI and short-lived user code produced by the skill. If you prefer
a browser-first flow, create the project at
[platform.apostl.dev](https://platform.apostl.dev) and still enter its API key
only through secret tooling.

## Copy-paste quickstart

The domain must already be proxied through Cloudflare.

```sh
git clone https://github.com/apostl-dev/pulse-cloudflare-worker.git
cd pulse-cloudflare-worker
npm install
npx wrangler login
npx wrangler secret put APOSTL_PULSE_API_KEY
npx wrangler deploy --route 'example.com/*'
```

Enter the Pulse API key only in Wrangler's secret prompt; do not include it in
the command itself. Replace
`example.com/*` with the smallest route that should be observed. The default
ingest endpoint is `https://ingest.apostl.dev` and the default environment is
`production`.

For a non-production Pulse endpoint or a different environment label, edit
the non-secret `vars` in `wrangler.jsonc` before deployment.

### One-click deploy

The **Deploy to Cloudflare** button forks this public repository into your
account, asks for the required secret, and creates the Worker. After deployment,
attach the Worker to an existing-zone route such as `docs.example.com/*` under
**Workers & Pages → your Worker → Settings → Domains & Routes**.

Do not use a Worker Custom Domain when the existing website is already the
origin for that hostname. Use a route so `fetch(request)` continues to the
origin behind Cloudflare.

## What is collected

Every request that reaches the Worker and has a valid `CF-Connecting-IP` is
sent, including unknown clients, normal browsers, static assets, private-looking
paths, mutations, 4xx responses, and 5xx responses. Pulse currently represents
these HTTP methods:

```text
GET HEAD POST PUT PATCH DELETE OPTIONS
```

Each event contains:

| Field group | Values sent |
| --- | --- |
| Identity | Raw client IP, full User-Agent (maximum 1,024 characters), hourly HMAC session ID |
| Page | Scheme, lower-cased host, canonical path |
| Request | Method, Accept family, inferred surface |
| Response | Status and Worker-observed duration |
| Delivery | Event UUID, UTC timestamp, schema version |

Local classification is only a compatibility hint. Pulse reclassifies events
centrally, so an unknown agent is still collected and can be recognized later.

## What is never collected

The Worker does not read or send:

- query parameters or URL fragments;
- request or response bodies;
- cookies;
- authorization headers;
- arbitrary headers;
- Cloudflare account credentials or the Pulse API key.

The canonical path itself is retained. Do not put password-reset tokens,
session IDs, email addresses, or other secrets in URL path segments. Query
parameters are removed before the event is created.

## Privacy and data responsibility

This template sends IP addresses and User-Agents to Apostl. Depending on your
jurisdiction, either value may be personal data. Before enabling the Worker,
the site operator is responsible for:

1. documenting Apostl in the site's privacy notice;
2. establishing an appropriate lawful basis and retention policy;
3. selecting only the Cloudflare routes that should be observed;
4. ensuring URL paths do not contain secrets or unnecessary personal data;
5. honoring applicable access, deletion, and opt-out requirements.

Do not deploy this template if raw IP collection is incompatible with your
privacy obligations.

## How delivery works

```text
client → Cloudflare Worker → existing origin
              └──────────→ Pulse ingest (background)
```

The Worker waits for the origin response, records its status and elapsed time,
and schedules Pulse delivery through `ctx.waitUntil()`. A delivery receives a
one-second timeout and retries only `429` and `5xx` responses, up to three
attempts. A network or Pulse failure is contained and never replaces the origin
response.

The first release sends one schema v2 event per batch. Cloudflare Queues and
Enterprise Logpush are intentionally separate future transports.

## Prove the first event

1. Deploy the Worker on a narrow test route.
2. Confirm the route still returns the original status, headers, and body.
3. Request the route through public Cloudflare with a distinctive User-Agent:

   ```sh
   curl -i -A 'Pulse-Cloudflare-Canary/1.0' https://example.com/llms.txt
   ```

4. In Cloudflare Workers Logs, confirm the invocation completed without an
   exception. Do not print the event or API key.
5. In Pulse, confirm that the page and request counters increased and that the
   distinctive client is present.
6. Run the Pulse installation verification. The Worker supports the same
   `x-apostl-pulse-challenge`, proof, and page headers as `pulse-sdk`.

An HTTP `200` from the website alone is not proof that Pulse received the
event. Require both the Worker invocation and the Pulse-side delta.

## Coverage boundaries

"Every request" means every representable request that reaches this Worker
route. It does not include:

- traffic that bypasses Cloudflare or uses an unproxied DNS record;
- requests blocked by an earlier Cloudflare security phase before Worker
  execution;
- requests missing a valid `CF-Connecting-IP`;
- HTTP methods not accepted by the current Pulse v2 schema.

Cloudflare Bot Management fields are not sent in v0.1 because Pulse v2 rejects
unknown fields. The raw request evidence is retained so Pulse can improve its
own classifier without redeploying customer Workers.

## Local development

Node.js 22 or newer is required by the current Wrangler release.

Install dependencies and run the full proof suite:

```sh
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run --ignore-scripts
```

For local Worker execution, create an ignored `.dev.vars` file:

```dotenv
APOSTL_PULSE_API_KEY=replace-me
```

Never commit `.dev.vars`.

## Rollback

Remove the route from **Workers & Pages → your Worker → Settings → Domains &
Routes**. Removing the route stops observation without changing the origin.
Delete the Worker only after confirming no other routes use it.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Site works but no events arrive | Confirm the route matches, the request traverses Cloudflare, and `APOSTL_PULSE_API_KEY` exists as a Worker secret. |
| Ingest rejects every event | Confirm the key is active and `APOSTL_PULSE_ENDPOINT` has not been changed to a page URL. |
| IP is missing | Test on the deployed Cloudflare route; the dashboard playground does not provide the live `CF-Connecting-IP`. |
| Origin loops or returns an error | Use a route in front of an existing origin, not a Custom Domain pointing back to the same Worker. |
| Only some traffic appears | Check route scope and Cloudflare security rules that may execute before Workers. |
| Need Cloudflare bot score | Bot Management fields require plan support and a future Pulse schema; this Worker still records the request. |

## Security

Report vulnerabilities privately to `hello@apostl.dev`. Do not include live API
keys, IP datasets, cookies, or authorization values in an issue.

## Support

For setup help, message [@SwiftAdviser](https://t.me/SwiftAdviser) on Telegram.

## License

MIT-licensed [source code is on GitHub](https://github.com/apostl-dev/pulse-cloudflare-worker).
