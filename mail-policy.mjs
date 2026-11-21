export function resendFailure(status, name, retryAfter, now) {
  if (status === 429) {
    const date = new Date(now);
    if (name === 'daily_quota_exceeded') return {
      error: 'Resend daily quota reached',
      retryAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) + 30000,
      pauseQueue: true, definitivelyRejected: true,
    };
    if (name === 'monthly_quota_exceeded') return {
      error: 'Resend monthly quota reached',
      retryAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) + 30000,
      pauseQueue: true, definitivelyRejected: true,
    };
    const seconds = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) : 60;
    return { error: 'Resend rate limit reached', retryAt: now + Math.max(1, Math.min(seconds, 900)) * 1000,
      pauseQueue: true, definitivelyRejected: true };
  }
  if (status === 401 || status === 403) return {
    error: 'Resend rejected the sender or API key', retryAt: now + 15 * 60000,
    pauseQueue: true, definitivelyRejected: true,
  };
  return { error: 'Resend response ' + status, retryAt: now + 5 * 60000,
    pauseQueue: false, definitivelyRejected: false };
}
