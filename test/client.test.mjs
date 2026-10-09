import test from 'node:test';
import assert from 'node:assert/strict';
import { NewApiClient, formatSnapshot } from '../dist/client.js';
import { apiRoot, parseConfig, safeText } from '../dist/config.js';
import { resolvePeriod } from '../dist/period.js';

const credential = { provider: 'tenant-a', baseUrl: 'https://billing.example/v1', apiKey: 'sk-test-a', accountBilling: true };
const options = { cacheSeconds: 60, timeoutMs: 1000 };
const status = { success: true, data: { quota_display_type: 'CNY', quota_per_unit: 500000, usd_exchange_rate: 7.3 } };
const token = { code: true, data: { name: '客服', total_used: 500000, total_available: -500000, unlimited_quota: true, expires_at: 0 } };
function mock(overrides = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const custom = overrides[path];
    if (custom instanceof Error) throw custom;
    if (typeof custom === 'function') return custom(url, init);
    if (custom instanceof Response) return new Response('mock upstream failure', { status: custom.status, headers: custom.headers });
    const body = custom ?? {
      '/api/status': status,
      '/api/usage/token/': token,
      '/v1/dashboard/billing/subscription': { hard_limit_usd: 100 },
      '/v1/dashboard/billing/usage': { total_usage: 2000 },
      '/api/log/token': { success: true, data: [] },
    }[path];
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return { fetcher, calls };
}

test('CNY account balance, key usage and unlimited quota are distinct', async () => {
  const { fetcher, calls } = mock();
  const result = await new NewApiClient(options, fetcher).query(credential, 'balance');
  assert.equal(result.account.available, 80);
  assert.equal(result.account.used, 20);
  assert.equal(result.token.availableQuota, undefined);
  const text = formatSnapshot(result);
  assert.match(text, /¥80.00/);
  assert.match(text, /¥7.30/);
  assert.doesNotMatch(text, /不限额|不单独限额|new-api|tenant-a|标识|-500,000|sk-test-a/);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer sk-test-a');
  assert.ok(calls.every(c => c.init.redirect === 'error' && c.init.method === 'GET'));
});

test('zero account balance is a valid result, not a failed query', async () => {
  const { fetcher } = mock({ '/v1/dashboard/billing/subscription': { hard_limit_usd: 20 } });
  const result = await new NewApiClient(options, fetcher).query(credential, 'balance');
  assert.equal(result.account.available, 0);
  assert.equal(result.issues.length, 0);
});

test('limited key reports its own quota separately', async () => {
  const { fetcher } = mock({ '/api/usage/token/': { code: true, data: { ...token.data, unlimited_quota: false, total_available: 1000000 } } });
  const result = await new NewApiClient(options, fetcher).query(credential, 'balance');
  assert.equal(result.token.availableQuota, 1000000);
  assert.match(formatSnapshot(result), /¥14.60/);
});

test('billing scope must be explicitly confirmed before account labels are used', async () => {
  const { fetcher, calls } = mock();
  const result = await new NewApiClient(options, fetcher).query({ ...credential, accountBilling: false }, 'balance');
  assert.equal(result.account, undefined);
  assert.equal(result.issues[0].code, 'SCOPE_UNCONFIRMED');
  assert.equal(calls.length, 2);
});

for (const unit of ['USD', 'TOKENS']) {
  test(`${unit} display follows server settings`, async () => {
    const { fetcher } = mock({ '/api/status': { ...status, data: { ...status.data, quota_display_type: unit } } });
    const result = await new NewApiClient(options, fetcher).query(credential, 'balance');
    assert.match(formatSnapshot(result), unit === 'USD' ? /\$1.00 USD/ : /500,000.00 积分/);
  });
}

test('unavailable exchange metadata does not guess account currency', async () => {
  const { fetcher } = mock({ '/api/status': { success: true, data: {} } });
  const result = await new NewApiClient(options, fetcher).query(credential, 'balance');
  assert.equal(result.account, undefined);
  assert.equal(result.token.usedQuota, 500000);
  assert.match(formatSnapshot(result), /暂无法换算/);
});

for (const httpStatus of [401, 403, 500]) {
  test(`HTTP ${httpStatus} preserves partial key result and never invents zero balance`, async () => {
    const { fetcher } = mock({ '/v1/dashboard/billing/subscription': new Response('sk-secret-should-not-leak', { status: httpStatus }) });
    const result = await new NewApiClient(options, fetcher).query(credential, 'balance');
    assert.equal(result.account, undefined);
    assert.ok(result.token);
    assert.equal(result.issues.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /sk-secret|available":0/);
  });
}

test('HTTP 200 error payloads are rejected without reflecting upstream messages', async () => {
  const { fetcher } = mock({ '/v1/dashboard/billing/usage': { error: { message: 'sk-secret' } } });
  const result = await new NewApiClient(options, fetcher).query(credential, 'balance');
  assert.equal(result.account, undefined);
  assert.equal(result.issues[0].code, 'BAD_RESPONSE');
  assert.doesNotMatch(JSON.stringify(result), /sk-secret/);
});

test('network timeout returns a sanitized partial error', async () => {
  const { fetcher } = mock({ '/api/usage/token/': new Error('URL sk-secret leaked?') });
  const result = await new NewApiClient(options, fetcher).query(credential, 'balance');
  assert.equal(result.token, undefined);
  assert.equal(result.account.available, 80);
  assert.equal(result.issues[0].code, 'NETWORK');
  assert.doesNotMatch(JSON.stringify(result), /sk-secret/);
});

test('same key concurrent queries are coalesced and cached', async () => {
  const { fetcher, calls } = mock();
  const client = new NewApiClient(options, fetcher);
  const results = await Promise.all(Array.from({ length: 8 }, () => client.query(credential, 'balance')));
  assert.equal(calls.length, 4);
  results[0].account.available = 999;
  assert.equal(results[1].account.available, 80);
  const cached = await client.query(credential, 'balance');
  assert.equal(cached.cached, true);
  assert.equal(cached.account.available, 80);
});

test('two keys of the same account share wallet balance, not key usage or cache', async () => {
  const { fetcher, calls } = mock({ '/api/usage/token/': (_url, init) => new Response(JSON.stringify({ code: true,
    data: { ...token.data, total_used: init.headers.Authorization.endsWith('a') ? 500000 : 900000 } })) });
  const client = new NewApiClient(options, fetcher);
  const a = await client.query(credential, 'balance');
  const b = await client.query({ ...credential, apiKey: 'sk-test-b' }, 'balance');
  assert.equal(a.account.available, b.account.available);
  assert.notEqual(a.token.usedQuota, b.token.usedQuota);
  assert.notEqual(a.keyFingerprint, b.keyFingerprint);
  assert.equal(calls.length, 8);
});

test('429 blocks requests for the whole platform, including other keys, until Retry-After', async () => {
  let now = 100000;
  const { fetcher, calls } = mock({ '/api/usage/token/': new Response('', { status: 429, headers: { 'Retry-After': '1200' } }) });
  const client = new NewApiClient(options, fetcher, () => now);
  const result = await client.query(credential, 'balance');
  assert.equal(result.issues[0].code, 'RATE_LIMITED');
  assert.equal(calls.length, 2);
  await assert.rejects(client.query({ ...credential, apiKey: 'sk-test-b' }, 'balance'), { code: 'RATE_LIMITED' });
  assert.equal(calls.length, 2);
  now += 1200001;
  await client.query(credential, 'balance');
  assert.equal(calls.length, 4);
});

test('stale cache on rate limit remains labeled with its original query time', async () => {
  let now = 100000;
  let limited = false;
  const { fetcher } = mock();
  const client = new NewApiClient(options, (...args) => limited ? Promise.resolve(new Response('', { status: 429, headers: { 'Retry-After': '60' } })) : fetcher(...args), () => now);
  const first = await client.query(credential, 'balance');
  now += 61000; limited = true;
  await client.query({ ...credential, apiKey: 'sk-another' }, 'balance');
  const cached = await client.query(credential, 'balance');
  assert.equal(cached.stale, true);
  assert.equal(cached.queriedAt, first.queriedAt);
  assert.match(formatSnapshot(cached), /旧缓存/);
});

test('usage returns ten recent consume/refund records, no raw log content or monthly claims', async () => {
  const logs = Array.from({ length: 15 }, (_, i) => ({ created_at: 1700000000 + i,
    type: i === 14 ? 6 : 2, model_name: 'model-a', quota: 500000, prompt_tokens: 10, completion_tokens: 20,
    content: 'private prompt', ip: 'private IP' }));
  const { fetcher } = mock({ '/api/log/token': { success: true, data: logs } });
  const result = await new NewApiClient(options, fetcher).query(credential, 'usage');
  assert.equal(result.recent.length, 10);
  assert.equal(result.recent[0].type, 6);
  assert.match(formatSnapshot(result), /非完整账单/);
  assert.doesNotMatch(JSON.stringify(result), /private prompt|private IP/);
});

test('invalid numeric values are not coerced to zero', async () => {
  const { fetcher } = mock({ '/v1/dashboard/billing/subscription': { hard_limit_usd: null } });
  const result = await new NewApiClient(options, fetcher).query(credential, 'balance');
  assert.equal(result.account, undefined);
  assert.equal(result.issues[0].code, 'BAD_RESPONSE');
});

test('URL derivation preserves deployment prefix and requires HTTPS', () => {
  assert.equal(apiRoot('https://billing.example/new-api/v1/'), 'https://billing.example/new-api/');
  for (const url of ['http://billing.example', 'https://user:pass@billing.example', 'https://billing.example/v1?key=secret']) {
    assert.throws(() => apiRoot(url), { code: 'CONFIG' });
  }
});

test('config and text sanitization fail closed', () => {
  assert.deepEqual(parseConfig({}).allowedSenders, []);
  assert.throws(() => parseConfig({ allowedSenders: [{ channel: 'telegram', senderId: '*' }] }), { code: 'CONFIG' });
  assert.equal(safeText('name\nsk-test-123'), 'name [已隐藏凭据]');
});

test('compact wallet hides duplicate totals and uses padded Beijing time', async () => {
  const { fetcher } = mock({ '/api/usage/token/': { code: true, data: { ...token.data, total_used: 20 / 7.3 * 500000 } } });
  const snapshot = await new NewApiClient(options, fetcher, () => Date.parse('2026-10-08T11:02:07.979Z')).query(credential, 'balance');
  const text = formatSnapshot(snapshot);
  assert.match(text, /更新时间：2026-10-08 19:02:07（北京时间）/);
  assert.doesNotMatch(text, /当前 Key|T11:|\.979|CNY|new-api|兼容接口/);
  assert.equal((text.match(/累计消费/g) ?? []).length, 1);
});

test('period totals include Beijing boundaries, refunds, and never expose raw logs', async () => {
  const now = Date.parse('2026-10-08T11:00:00Z');
  const period = resolvePeriod({ startDate: '2026-10-07' }, now);
  const row = (time, quota, type = 2) => ({ created_at: Date.parse(time) / 1000, quota, type, content: 'private content' });
  const logs = [row('2026-10-06T15:59:59Z', 999999), row('2026-10-06T16:00:00Z', 500000),
    row('2026-10-07T15:59:59Z', 100000), row('2026-10-07T10:00:00Z', 200000, 6), row('2026-10-07T16:00:00Z', 999999)];
  const { fetcher, calls } = mock({ '/api/log/token': { success: true, data: logs } });
  const result = await new NewApiClient(options, fetcher, () => now).query(credential, 'usage', undefined, period);
  assert.equal(result.period.spentQuota, 600000);
  assert.equal(result.period.refundQuota, 200000);
  assert.equal(result.period.count, 2);
  assert.equal(result.period.refundCount, 1);
  assert.equal(result.recent, undefined);
  assert.match(formatSnapshot(result), /净消费：¥5.84/);
  assert.match(formatSnapshot(result), /当前 Key 的可查记录/);
  assert.doesNotMatch(JSON.stringify(result), /private content/);
  assert.equal(calls.length, 2);
});

test('1000-record cap warns of incompleteness even if all records are recent', async () => {
  const now = Date.parse('2026-10-08T11:00:00Z');
  const logs = Array.from({ length: 1000 }, () => ({ created_at: now / 1000 - 10, type: 2, quota: 100 }));
  const { fetcher } = mock({ '/api/log/token': { success: true, data: logs } });
  const client = new NewApiClient(options, fetcher, () => now);
  const result = await client.query(credential, 'usage', undefined, resolvePeriod({ period: 'today' }, now));
  assert.equal(result.period.limited, true);
  assert.match(formatSnapshot(result), /最近1,000条记录，统计可能不完整/);
  const empty = await client.query(credential, 'usage', undefined, resolvePeriod({ period: 'yesterday' }, now));
  assert.match(formatSnapshot(empty), /不代表实际消费为零/);
  assert.doesNotMatch(formatSnapshot(empty), /消费合计：.*0.00/);
});

test('period cache is isolated by dates, credentials and recent mode', async () => {
  const { fetcher, calls } = mock();
  const now = Date.parse('2026-10-08T11:00:00Z');
  const client = new NewApiClient(options, fetcher, () => now);
  const today = resolvePeriod({ period: 'today' }, now);
  await client.query(credential, 'usage', undefined, today);
  assert.equal((await client.query(credential, 'usage', undefined, today)).cached, true);
  await client.query(credential, 'usage', undefined, resolvePeriod({ period: 'yesterday' }, now));
  await client.query(credential, 'usage');
  await client.query({ ...credential, apiKey: 'sk-other' }, 'usage', undefined, today);
  assert.equal(calls.length, 8);
});

test('invalid refund signs or malformed records cannot produce invented period totals', async () => {
  const now = Date.parse('2026-10-08T11:00:00Z');
  for (const log of [{ created_at: now / 1000 - 1, type: 6, quota: -20 }, { created_at: null, type: 2, quota: 10 }]) {
    const { fetcher } = mock({ '/api/log/token': { success: true, data: [log] } });
    const result = await new NewApiClient(options, fetcher, () => now).query(credential, 'usage', undefined, resolvePeriod({ period: 'today' }, now));
    assert.equal(result.period, undefined);
    assert.equal(result.issues[0].code, 'BAD_RESPONSE');
  }
});
