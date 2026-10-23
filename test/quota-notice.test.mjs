import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotaNotice, isUserQuotaError } from '../dist/quota-notice.js';
import { parseConfig } from '../dist/config.js';

const failed = (errorMessage, provider = 'leepm', timestamp = 10000) => ({ role: 'assistant', stopReason: 'error', errorMessage, provider, timestamp });
const raw = '403 Insufficient user quota, remaining quota: ＄0.000000 (request id: fixture)';
test('verified rc.43 SDK English, Chinese and structured account errors match', () => {
  for (const s of [raw, '403 用户额度不足, 剩余额度: ￥0.000000 (request id: fixture)', '403 {"error":{"code":"insufficient_user_quota"}}']) assert.equal(isUserQuotaError(failed(s)), true);
});
test('invalid/exhausted token, banned user, rate limits, timeout and ordinary text do not match', () => {
  for (const s of ['401 Invalid token','403 User has been banned','429 rate limit','timeout', '403 billing error','403 No channel available','403 Insufficient user quota, remaining quota: zero']) assert.equal(isUserQuotaError(failed(s)), false);
  assert.equal(isUserQuotaError({ role: 'user', stopReason: 'error', errorMessage: raw }), false);
  assert.equal(isUserQuotaError({ ...failed(raw), stopReason: 'stop' }), false);
});
function fixture() {
  let clock = 10000;
  const cfg = parseConfig({ providers: { leepm: {} }, quotaNotice: { enabled: true } });
  const hooks = createQuotaNotice(() => cfg, () => clock);
  const ctx = { sessionKey: 'agent:a:telegram:direct:1', runId: 'run-a' };
  const send = (extra = {}, context = ctx) => hooks.sending({ kind: 'final', payload: { text: 'original', isError: true, mediaUrl: 'secret', channelData: { secret: true }, replyToId: '123' }, ...extra }, context);
  hooks.started({ provider: 'leepm' }, ctx);
  hooks.ended({ messages: [failed(raw)] }, ctx);
  return { hooks, ctx, send, cfg, expire: () => clock += 600001 };
}
test('only exact run final errors are rewritten, without attachments or account details', () => {
  const f = fixture();
  assert.deepEqual(f.send(), { payload: { text: '积分不足，请联系管理员充值。', isError: true, replyToId: '123' } });
  assert.equal(f.send({}, { ...f.ctx, runId: 'other' }), undefined);
  assert.equal(f.send({}, { ...f.ctx, sessionKey: 'other' }), undefined);
  assert.equal(f.send({ kind: 'tool' }), undefined);
  assert.equal(f.send({ payload: { isError: false, text: 'success' } }), undefined);
  assert.equal(f.send({}, {}), undefined);
});
test('successful or unrelated fallback clears previous quota failure', () => {
  const f = fixture(); f.hooks.started({ provider: 'other' }, f.ctx); assert.equal(f.send(), undefined);
  const g = fixture(); g.hooks.started({ provider: 'leepm' }, g.ctx); g.hooks.ended({ messages: [{ role: 'assistant', stopReason: 'stop', timestamp: 10000, provider: 'leepm' }] }, g.ctx); assert.equal(g.send(), undefined);
});
test('historical messages, missing timestamps and mismatched provider cannot mark a new failure', () => {
  for (const patch of [{ timestamp: 1 }, { timestamp: undefined }, { provider: 'other' }]) {
    const f = fixture(); f.hooks.ended({ messages: [{ ...failed(raw), ...patch }] }, f.ctx); assert.equal(f.send(), undefined);
  }
});
test('expiry and live disabling restore normal error handling', () => {
  const f = fixture(); f.expire(); assert.equal(f.send(), undefined);
  const g = fixture(); g.cfg.quotaNotice.enabled = false; assert.equal(g.send(), undefined);
});
test('notice is opt-in and configurable; secret-like copy is rejected', () => {
  assert.equal(parseConfig({}).quotaNotice.enabled, false);
  assert.equal(parseConfig({quotaNotice:{enabled:true,message:'请充值'}}).quotaNotice.message, '请充值');
  assert.throws(() => parseConfig({quotaNotice:{message:'sk-secret'}}));
});
