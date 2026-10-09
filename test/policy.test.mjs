import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAccess } from '../dist/policy.js';
import { parseConfig } from '../dist/config.js';

const config = parseConfig({ allowedSenders: [{ channel: 'telegram', senderId: '123', agentIds: ['agent-a'] }] });
const identity = { channel: 'telegram', senderId: '123', agentId: 'agent-a', chatType: 'direct' };

test('only an explicitly configured channel/sender/agent tuple is allowed', () => {
  assert.doesNotThrow(() => assertAccess(identity, config));
  for (const patch of [{ channel: 'feishu' }, { senderId: '456' }, { agentId: 'agent-b' }, { senderId: undefined }]) {
    assert.throws(() => assertAccess({ ...identity, ...patch }, config), { code: 'FORBIDDEN' });
  }
});
test('group denial takes precedence over member or owner status', () => {
  for (const patch of [{ chatType: 'group' }, { chatType: 'channel' }, { sessionKey: 'agent:a:telegram:group:456' }]) {
    assert.throws(() => assertAccess({ ...identity, ...patch }, config, ['telegram:123']), { code: 'PRIVATE_ONLY' });
  }
});
test('unknown conversation type denies disclosure', () => {
  assert.throws(() => assertAccess({ ...identity, chatType: undefined }, config), { code: 'PRIVATE_ONLY' });
});
test('explicit owner allowlist works but wildcard never grants ownership', () => {
  assert.doesNotThrow(() => assertAccess(identity, parseConfig({}), ['telegram:123']));
  assert.throws(() => assertAccess(identity, parseConfig({}), ['*']), { code: 'FORBIDDEN' });
});
test('authenticated admin control plane is distinct from ordinary chat access', () => {
  assert.doesNotThrow(() => assertAccess({ channel: 'webchat', gatewayClientScopes: ['operator.admin'] }, config));
  assert.throws(() => assertAccess({ channel: 'telegram', gatewayClientScopes: ['operator.admin'], chatType: 'direct' }, config), { code: 'FORBIDDEN' });
  assert.throws(() => assertAccess({ ...identity, isAuthorizedSender: false }, config), { code: 'FORBIDDEN' });
});
