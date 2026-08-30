import { pathToFileURL } from 'node:url';

const MAX_BYTES = 8 * 1024 * 1024;
const SAFE_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);

export function storageAuditConfiguration(env) {
  let url;
  try { url = new URL(env.SUPABASE_PROJECT_URL); } catch { throw new Error('Invalid Supabase project URL'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use the exact HTTPS Supabase project URL');
  }
  const match = /^\/([a-z0-9][a-z0-9._-]{0,62})\/private$/.exec(env.PRIVATE_OBJECT_DIR ?? '');
  const token = env.SUPABASE_STORAGE_AUDIT_TOKEN?.trim();
  if (!match || !token || /[\r\n]/.test(token)) throw new Error('Storage audit configuration is incomplete');
  return { base: url.origin, bucket: match[1], token,
    apiKey: env.SUPABASE_STORAGE_AUDIT_API_KEY?.trim() || token,
    requirePdf: env.STORAGE_AUDIT_REQUIRE_PDF === 'true' };
}

export function assessBucket(bucket, expectedId, requirePdf = false) {
  const types = bucket?.allowed_mime_types;
  const checks = {
    expectedBucket: bucket?.id === expectedId && bucket?.name === expectedId,
    privateBucket: bucket?.public === false,
    boundedFileSize: bucket?.file_size_limit === MAX_BYTES,
    restrictedMimeTypes: Array.isArray(types) && types.length > 0 &&
      types.every(type => SAFE_TYPES.has(type)) && types.includes('image/jpeg'),
    pdfPermitted: Array.isArray(types) && types.includes('application/pdf'),
  };
  return { passed: checks.expectedBucket && checks.privateBucket && checks.boundedFileSize &&
    checks.restrictedMimeTypes && (!requirePdf || checks.pdfPermitted), checks };
}

/** Read bucket settings only: no objects are listed, downloaded, or changed. */
export async function auditStorage(env = process.env, fetcher = fetch) {
  const config = storageAuditConfiguration(env);
  let response;
  try {
    response = await fetcher(`${config.base}/storage/v1/bucket/${encodeURIComponent(config.bucket)}`, {
      headers: { apikey: config.apiKey, Authorization: `Bearer ${config.token}` },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error('Storage metadata request failed'); }
  if (!response.ok) throw new Error(`Storage metadata request rejected (HTTP ${response.status})`);
  let bucket;
  try { bucket = await response.json(); } catch { throw new Error('Invalid storage metadata response'); }
  return { checkedAt: new Date().toISOString(), ...assessBucket(bucket, config.bucket, config.requirePdf),
    limitations: ['Does not prove object ACLs, key scope, retention, backup, region, or legal approval'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const report = await auditStorage(); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
