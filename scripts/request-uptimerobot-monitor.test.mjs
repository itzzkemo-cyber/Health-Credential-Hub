import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { leadingZeroBits, MONITOR_URL, requestMonitor, solveChallenge } from './request-uptimerobot-monitor.mjs';

const challenge = { nonce: 'ab'.repeat(16), signature: 'cd'.repeat(32), timestamp: 12345, difficulty: 8 };
test('counts leading bits and solves server-provided difficulty', () => {
  assert.equal(leadingZeroBits(Buffer.from([0, 1])), 15);
  assert.equal(leadingZeroBits(Buffer.from([128])), 0);
  const counter = solveChallenge(challenge);
  assert.ok(leadingZeroBits(createHash('sha256').update(`${challenge.nonce}|${counter}`).digest()) >= challenge.difficulty);
});
test('rejects malformed or excessive work and has deadline', () => {
  for (const value of [{ ...challenge, difficulty: 100 }, { ...challenge, nonce: 'bad' }, { ...challenge, signature: 'bad' }, { ...challenge, timestamp: '12345' }]) assert.throws(() => solveChallenge(value));
  assert.throws(() => solveChallenge(challenge, 0), /timed out/);
});
test('only requests fixed health endpoint and never claims activation', async () => {
  const calls = [];
  const result = await requestMonitor('synthetic@example.test', async (url, init) => {
    calls.push({ url, init }); return { ok: true, json: async () => calls.length === 1 ? challenge : { status: 'ok' } };
  });
  assert.equal(calls.length, 2); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(JSON.parse(calls[1].init.body).url, MONITOR_URL);
  assert.equal(result.active, false); assert.equal(result.status, 'activation_required');
  assert.equal(JSON.stringify(result).includes('synthetic@example.test'), false);
});
test('invalid email and provider failures are bounded and sanitized', async () => {
  await assert.rejects(() => requestMonitor('bad'), /valid owner email/);
  await assert.rejects(() => requestMonitor('synthetic@example.test', async () => { throw new Error('secret'); }), { message: 'UptimeRobot request failed' });
  await assert.rejects(() => requestMonitor('synthetic@example.test', async () => ({ ok: false, status: 503 })), /HTTP 503/);
});
