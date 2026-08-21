/**
 * Shared cadence for Cloudflare-gated daily work (play logs and GET /health/time).
 *
 * Cloudflare is probed every 5 minutes. Pathnatya APIs still wait 24 hours from
 * their last success: a Cloudflare hit that is not due does not call
 * /health/time or /logs.
 */
export const DAILY_ONLINE_TICK_MS = 24 * 60 * 60 * 1000

/** How often to probe Cloudflare (and then run a due Pathnatya task). */
export const DAILY_ONLINE_POLL_MS = 5 * 60 * 1000
