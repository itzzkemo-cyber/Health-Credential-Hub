import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MONITOR_URL = 'https://app.wathaiqihealth.com/api/readyz';
const API = 'https://api.uptimerobot.com';

export function leadingZeroBits(buffer) {
  let count = 0;
  for (const byte of buffer) {
    if (!byte) count += 8;
    else { count += Math.clz32(byte) - 24; break; }
  }
  return count;
}

export function solveChallenge(challenge, deadlineMs = 30_000) {
  if (!challenge || !/^[a-f0-9]{16,256}$/i.test(challenge.nonce) ||
      !/^[a-f0-9]{16,256}$/i.test(challenge.signature) ||
      !Number.isSafeInteger(challenge.timestamp) || !Number.isSafeInteger(challenge.difficulty) ||
      challenge.difficulty < 0 || challenge.difficulty > 28) throw new Error('Invalid monitor challenge');
  const deadline = Date.now() + deadlineMs;
  for (let counter = 0; counter < Number.MAX_SAFE_INTEGER; counter++) {
    if (counter % 4096 === 0 && Date.now() >= deadline) throw new Error('Monitor challenge timed out');
    const digest = createHash('sha256').update(`${challenge.nonce}|${counter}`).digest();
    if (leadingZeroBits(digest) >= challenge.difficulty) return counter;
  }
  throw new Error('Monitor challenge exhausted');
}

async function requestJson(url, init, fetcher) {
  let response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error('UptimeRobot request failed'); }
  if (!response.ok) throw new Error(`UptimeRobot rejected request (HTTP ${response.status})`);
  try { return await response.json(); } catch { throw new Error('Invalid UptimeRobot response'); }
}

/** Requests activation only. A 200 is deliberately NOT proof of a live monitor. */
export async function requestMonitor(email, fetcher = fetch) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid owner email is required');
  const query = new URLSearchParams({ email, url: MONITOR_URL });
  const challenge = await requestJson(`${API}/agentic/agent-monitor/challenge?${query}`, {}, fetcher);
  const counter = solveChallenge(challenge);
  const response = await requestJson(`${API}/agentic/agent-monitor`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, url: MONITOR_URL, nonce: challenge.nonce, timestamp: challenge.timestamp, counter, signature: challenge.signature }),
  }, fetcher);
  if (response.status !== 'ok') throw new Error('Monitor activation request was not accepted');
  return { status: 'activation_required', monitorUrl: MONITOR_URL, active: false,
    message: 'Check the owner inbox and confirm activation. HTTP 200 does not prove email delivery or monitor creation.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await requestMonitor(process.env.UPTIMEROBOT_OWNER_EMAIL), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
