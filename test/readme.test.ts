import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('README routes newcomers through the safe accountless Worker handoff', () => {
  assert.match(
    readme,
    /https:\/\/github\.com\/apostl-dev\/apostl-skills\/tree\/main\/skills\/agent-traffic-analytics/,
    'link the canonical public agent-traffic-analytics skill',
  );
  assert.match(readme, /https:\/\/apostl\.dev\/auth\.md/, 'link the canonical Auth.md instructions');
  assert.match(
    readme,
    /confirmed[^\n.]*Cloudflare-proxied[^\n.]*hostname[^\n.]*route/i,
    'state when the Cloudflare Worker path applies',
  );
  assert.match(
    readme,
    /DNS-only|unreachable|ambiguous/i,
    'fail closed when Cloudflare routing cannot be confirmed',
  );
  assert.match(
    readme,
    /existing origin[\s\S]{0,350}narrow(?:est)?[\s\S]{0,120}route[\s\S]{0,120}(?:do not|never)[\s\S]{0,120}Custom Domain/i,
    'use a narrow route without creating a Custom Domain loop',
  );
  assert.match(
    readme,
    /Cloudflare Worker or Pages app[\s\S]{0,250}observation logic[\s\S]{0,250}non-looping route/i,
    'avoid stacking a second Worker in front of an existing Worker or Pages app',
  );
  assert.match(
    readme,
    /ordinary supported server[\s\S]{0,120}not routed through Cloudflare[\s\S]{0,160}pulse-sdk/i,
    'route ordinary non-Cloudflare servers to the SDK',
  );
  assert.match(
    readme,
    /exactly one[^\n.]*collector|one collector[^\n.]*request path/i,
    'prohibit Worker and SDK double instrumentation',
  );
  assert.match(
    readme,
    /without (?:a human )?account|accountless/i,
    'describe accountless key acquisition',
  );
  assert.match(
    readme,
    /owner-only[^\n.]*0600[^\n.]*file/i,
    'keep the one-time key in an owner-only credential file',
  );
  assert.match(
    readme,
    /(?:never|do not)[\s\S]{0,100}(?:print|stdout|chat)[\s\S]{0,100}raw[\s\S]{0,50}(?:API )?key|(?:never|do not)[\s\S]{0,100}raw[\s\S]{0,50}(?:API )?key[\s\S]{0,100}(?:print|stdout|chat)/i,
    'forbid raw key output',
  );
});
