import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessBucket, auditStorage, storageAuditConfiguration } from './check-supabase-storage.mjs';

const env = { SUPABASE_PROJECT_URL: 'https://abcdefghijklmnopqrst.supabase.co', PRIVATE_OBJECT_DIR: '/documents/private', SUPABASE_STORAGE_AUDIT_TOKEN: 'synthetic-only' };
const bucket = { id: 'documents', name: 'documents', public: false, file_size_limit: 8388608, allowed_mime_types: ['image/jpeg', 'image/png', 'application/pdf'] };

test('accepts private, bounded document bucket', () => assert.equal(assessBucket(bucket, 'documents', true).passed, true));
test('rejects public, wrong, unbounded, or wildcard buckets', () => {
  for (const replacement of [{ public: true }, { public: undefined }, { id: 'other' }, { file_size_limit: null }, { file_size_limit: 8388609 }, { allowed_mime_types: ['image/*'] }, { allowed_mime_types: null }, { allowed_mime_types: ['image/jpeg', 'text/html'] }]) {
    assert.equal(assessBucket({ ...bucket, ...replacement }, 'documents', true).passed, false);
  }
});
test('PDF activation gate is independent of privacy result', () => {
  const result = assessBucket({ ...bucket, allowed_mime_types: ['image/jpeg'] }, 'documents', true);
  assert.equal(result.checks.privateBucket, true); assert.equal(result.passed, false);
});
test('rejects credential-bearing, non-TLS, redirected, and arbitrary destinations', () => {
  for (const url of ['http://abcdefghijklmnopqrst.supabase.co', 'https://evil.test', 'https://abcdefghijklmnopqrst.supabase.co.evil.test', 'https://user:pass@abcdefghijklmnopqrst.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co/?secret=x', 'https://abcdefghijklmnopqrst.supabase.co/path']) {
    assert.throws(() => storageAuditConfiguration({ ...env, SUPABASE_PROJECT_URL: url }));
  }
});
test('audit reads only bucket metadata and redacts identities', async () => {
  let calls = 0;
  const report = await auditStorage(env, async (url, options) => {
    calls++; assert.equal(url, `${env.SUPABASE_PROJECT_URL}/storage/v1/bucket/documents`);
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer synthetic-only');
    return { ok: true, json: async () => bucket };
  });
  assert.equal(calls, 1); assert.equal(report.passed, true);
  assert.equal(JSON.stringify(report).includes('synthetic-only'), false);
  assert.equal(JSON.stringify(report).includes('abcdefghijklmnopqrst'), false);
});
test('request and provider errors never expose secrets or response bodies', async () => {
  await assert.rejects(() => auditStorage(env, async () => { throw new Error('synthetic-only'); }), { message: 'Storage metadata request failed' });
  await assert.rejects(() => auditStorage(env, async () => ({ ok: false, status: 403 })), { message: 'Storage metadata request rejected (HTTP 403)' });
});
