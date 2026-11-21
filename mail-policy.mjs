import { createHash } from 'node:crypto';

export const retryWindowMs = 29 * 60000;
export const dailyLimit = 300;
export const dayMs = 24 * 3600000;

export function brevoKey(id, firstAttempt) {
  const hex = createHash('sha256').update(id + '/' + firstAttempt).digest('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) +
    '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

export function brevoFailure(status, code, retryAfter, now) {
  if (status === 402 || code === 'not_enough_credits') return {
    error: 'Brevo sending credits reached', retryAt: now + 60 * 60000,
    pauseQueue: true, definitivelyRejected: true,
  };
  if (status === 429) {
    const seconds = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) : 60;
    return { error: 'Brevo rate limit reached', retryAt: now + Math.max(1, Math.min(seconds, 3600)) * 1000,
      pauseQueue: true, definitivelyRejected: true };
  }
  if (status === 401 || status === 403) return {
    error: 'Brevo rejected the sender or API key', retryAt: now + 15 * 60000,
    pauseQueue: true, definitivelyRejected: true,
  };
  return { error: 'Brevo response ' + status, retryAt: now + 5 * 60000,
    pauseQueue: false, definitivelyRejected: false };
}
