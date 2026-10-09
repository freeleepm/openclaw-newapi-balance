import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, resolvePeriod, formatTime } from '../dist/period.js';
const now = Date.parse('2026-10-01T01:02:03Z');
test('presets use Beijing calendar dates and inclusive end dates', () => {
  const today = resolvePeriod({ period: 'today' }, now);
  assert.equal(today.start, Date.parse('2026-09-30T16:00:00Z'));
  assert.equal(today.end, now);
  assert.equal(resolvePeriod({ period: 'yesterday' }, now).startDate, '2026-09-30');
  assert.equal(resolvePeriod({ period: 'month' }, now).startDate, '2026-10-01');
  assert.equal(resolvePeriod({ period: 'last7days' }, now).startDate, '2026-09-25');
  const range = resolvePeriod({ startDate: '2024-02-28', endDate: '2024-02-29' }, now);
  assert.equal(range.end - range.start, 2 * 86400000);
  assert.equal(formatTime('2026-09-30T16:00:00Z'), '2026-10-01 00:00:00');
});
test('invalid, reversed, ambiguous and future dates are rejected', () => {
  for (const params of [{ startDate: '2026-02-29' }, { startDate: '2026-9-1' }, { startDate: '2026-10-02' },
    { startDate: '2026-09-20', endDate: '2026-09-01' }, { endDate: '2026-09-01' }, { period: 'today', startDate: '2026-09-01' },
    { period: 'all' }, { period: null }, { startDate: 42 }, { startDate: '2026-09-01T10:00:00' }]) {
    assert.throws(() => resolvePeriod(params, now), { code: 'ARGUMENTS' });
  }
});
test('commands support old recent usage, presets, Chinese aliases and custom dates', () => {
  assert.equal(parseCommand('', now).mode, 'balance');
  assert.deepEqual(parseCommand('usage', now), { mode: 'usage' });
  assert.equal(parseCommand('今日', now).period.startDate, '2026-10-01');
  assert.equal(parseCommand('usage yesterday', now).period.endDate, '2026-09-30');
  assert.equal(parseCommand('usage 2026-09-01 2026-09-30', now).period.endDate, '2026-09-30');
  assert.throws(() => parseCommand('usage garbage', now), { code: 'ARGUMENTS' });
});
