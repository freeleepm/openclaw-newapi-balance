import test from 'node:test';
import assert from 'node:assert/strict';
import plugin, { createHandlers, selectProvider } from '../dist/index.js';
import { parseConfig } from '../dist/config.js';

test('imports the installed SDK and registers direct command plus two tools', () => {
  const commands = [], tools = [];
  plugin.register({ pluginConfig: {}, registerCommand: c => commands.push(c), registerTool: (t, o) => tools.push({ t, o }) });
  assert.equal(commands[0].name, 'balance');
  assert.equal(commands[0].requireAuth, true);
  assert.equal(commands[0].acceptsArgs, true);
  assert.deepEqual(tools[0].o.names, ['newapi_balance', 'newapi_usage']);
});
test('runtime current provider wins over the global default, with no unrelated fallback', () => {
  const config = parseConfig({ providers: { companyA: {}, companyB: {} } });
  assert.equal(selectProvider({ config, activeProvider: 'companyB', defaultProvider: 'companyA' }), 'companyB');
  assert.equal(selectProvider({ config, sessionProvider: 'companyB', defaultProvider: 'companyA' }), 'companyB');
  assert.throws(() => selectProvider({ config, activeProvider: 'unrelated', defaultProvider: 'companyA' }), { code: 'PROVIDER' });
});
test('command help and denied tools perform neither network nor LLM calls', async () => {
  let requests = 0;
  const handlers = createHandlers({ pluginConfig: {}, config: {} }, async () => { requests++; throw new Error('unexpected'); });
  assert.match((await handlers.command({ args: 'bad', config: {} })).text, /用法/);
  const tool = handlers.tools({ config: {} })[0];
  assert.equal((await tool.execute('test', {})).isError, true);
  assert.equal((await tool.execute('test', { apiKey: 'sk-forged' })).details.error.code, 'ARGUMENTS');
  assert.equal(requests, 0);
});

function integration(overrides = {}) {
  const queries = [], credentials = [];
  const config = {
    models: { providers: { companyA: { baseUrl: 'https://a.example/v1', api: 'openai-completions' }, companyB: { baseUrl: 'https://b.example/v1', api: 'openai-completions' } } },
    plugins: { entries: { 'openclaw-newapi-balance': { config: { providers: { companyA: { accountBilling: true }, companyB: { accountBilling: true } },
      allowedSenders: [{ channel: 'telegram', senderId: '123', agentIds: ['a'] }] } } } },
  };
  const api = { config, pluginConfig: config.plugins.entries['openclaw-newapi-balance'].config,
    runtime: { modelConfig: { resolveDefaultModelForAgent: () => ({ provider: 'companyA', model: 'model' }) } } };
  const host = {
    getSessionEntry: () => ({ chatType: 'direct' }), resolveAgentDir: () => '/unused-test-agent',
    ensureAuthProfileStore: () => ({ version: 1, profiles: {} }), listProfilesForProvider: () => [],
    resolveApiKeyForProvider: async input => { credentials.push(input); return { apiKey: `sk-${input.provider}`, mode: 'api-key', source: 'test' }; },
    ...overrides,
  };
  const fetcher = async (url, init) => {
    queries.push({ url: url.toString(), auth: init.headers.Authorization });
    const body = {
      '/api/status': { success: true, data: { quota_display_type: 'USD', quota_per_unit: 500000 } },
      '/api/usage/token/': { code: true, data: { name: 'test', total_used: 500000, unlimited_quota: true, expires_at: 0 } },
      '/v1/dashboard/billing/subscription': { hard_limit_usd: 25 },
      '/v1/dashboard/billing/usage': { total_usage: 500 },
      '/api/log/token': { success: true, data: [] },
    }[url.pathname];
    return new Response(JSON.stringify(body));
  };
  return { handlers: createHandlers(api, fetcher, host), config, queries, credentials };
}

test('direct command reuses session-selected provider/key and makes no LLM request', async () => {
  const fixture = integration({ getSessionEntry: () => ({ chatType: 'direct', providerOverride: 'companyB' }) });
  const result = await fixture.handlers.command({ config: fixture.config, agentId: 'a', channel: 'telegram', senderId: '123',
    sessionKey: 'agent:a:telegram:direct:123', isAuthorizedSender: true });
  assert.doesNotMatch(result.text, /companyB|new-api/);
  assert.match(result.text, /\$20.00 USD/);
  assert.ok(fixture.queries.every(q => q.url.startsWith('https://b.example/')));
  assert.equal(fixture.credentials[0].provider, 'companyB');
  assert.doesNotMatch(result.text, /sk-companyB/);
});

test('natural-language tool uses runtime model and exact trusted member identity', async () => {
  const fixture = integration();
  const ctx = { config: fixture.config, agentId: 'a', messageChannel: 'telegram', requesterSenderId: '123',
    sessionKey: 'agent:a:telegram:direct:123', activeModel: { provider: 'companyB' },
    resolveApiKeyForProvider: async provider => `sk-active-${provider}` };
  const result = await fixture.handlers.tools(ctx)[0].execute('call', {});
  assert.equal(result.details.account.available, 20);
  assert.equal(result.details.provider, 'companyB');
  assert.equal(fixture.credentials.length, 0);
  assert.equal(fixture.queries[1].auth, 'Bearer sk-active-companyB');
});

test('group and unknown member never resolve credentials or make HTTP requests', async () => {
  for (const patch of [{ senderId: '456' }, { sessionKey: 'agent:a:telegram:group:456' }]) {
    const fixture = integration();
    const result = await fixture.handlers.command({ config: fixture.config, agentId: 'a', channel: 'telegram', senderId: '123',
      sessionKey: 'agent:a:telegram:direct:123', isAuthorizedSender: true, ...patch });
    assert.match(result.text, /私聊|指定成员/);
    assert.equal(fixture.queries.length, 0);
    assert.equal(fixture.credentials.length, 0);
  }
});

test('ambiguous profiles fail closed rather than picking another company', async () => {
  const fixture = integration({ listProfilesForProvider: () => ['profile-a', 'profile-b'] });
  const result = await fixture.handlers.command({ config: fixture.config, agentId: 'a', channel: 'telegram', senderId: '123',
    sessionKey: 'agent:a:telegram:direct:123', isAuthorizedSender: true });
  assert.match(result.text, /多个凭据/);
  assert.equal(fixture.queries.length, 0);
});

test('session-selected profile stays locked and does not use the generic context resolver', async () => {
  const fixture = integration({ listProfilesForProvider: () => ['profile-a', 'profile-b'],
    getSessionEntry: () => ({ chatType: 'direct', authProfileOverride: 'profile-b' }) });
  const result = await fixture.handlers.tools({ config: fixture.config, agentId: 'a', messageChannel: 'telegram', requesterSenderId: '123',
    sessionKey: 'agent:a:telegram:direct:123', resolveApiKeyForProvider: async () => { throw new Error('wrong resolver'); } })[0].execute('call', {});
  assert.equal(result.details.account.available, 20);
  assert.equal(fixture.credentials[0].profileId, 'profile-b');
  assert.equal(fixture.credentials[0].lockedProfile, true);
});

test('period commands and tools use existing identity and reject arbitrary sensitive arguments', async () => {
  const f = integration();
  const command = { config: f.config, agentId: 'a', channel: 'telegram', senderId: '123', sessionKey: 'agent:a:telegram:direct:123', isAuthorizedSender: true };
  assert.match((await f.handlers.command({ ...command, args: 'today' })).text, /时段消费/);
  const ctx = { config: f.config, agentId: 'a', messageChannel: 'telegram', requesterSenderId: '123', sessionKey: command.sessionKey };
  const tool = f.handlers.tools(ctx)[1];
  const result = await tool.execute('call', { startDate: '2026-01-01', endDate: '2026-01-31' });
  assert.equal(result.details.period.startDate, '2026-01-01');
  const count = f.queries.length;
  for (const params of [{ period: 'today', apiKey: 'sk-forged' }, { period: 'today', userId: 1 }, { period: 'today', baseUrl: 'https://evil.example' }, { startDate: '2026-02-30' }, { period: null }]) {
    assert.equal((await tool.execute('bad', params)).isError, true);
  }
  assert.equal(f.queries.length, count);
  const denied = await f.handlers.command({ ...command, senderId: '456', args: 'month' });
  assert.match(denied.text, /指定成员/);
  assert.equal(f.queries.length, count);
});
