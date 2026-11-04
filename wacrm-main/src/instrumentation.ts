// ============================================================
// Built-in scheduler for self-hosted installs. Nothing else pings the
// cron endpoints on a plain `npm run dev` / `npm start` / Docker
// deployment, so automation Wait steps, flow timeouts and wallet
// reconciliation never ran. When AUTOMATION_CRON_SECRET is set, this
// calls them once a minute on the local server with that secret.
//
// Turn it off with BUILTIN_SCHEDULER=false when an external scheduler
// (Vercel Cron, cron-job.org, …) already hits the endpoints.
// ============================================================

const ENDPOINTS = ['/api/automations/cron', '/api/flows/cron', '/api/wallet/reconcile']
const INTERVAL_MS = 60_000

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const secret = process.env.AUTOMATION_CRON_SECRET
  if (!secret || process.env.BUILTIN_SCHEDULER === 'false') return

  // Dev hot reload re-runs register(); keep a single timer per process.
  const g = globalThis as { __wacrmScheduler?: ReturnType<typeof setInterval> }
  if (g.__wacrmScheduler) return

  const base = `http://127.0.0.1:${process.env.PORT || 3000}`
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      for (const path of ENDPOINTS) {
        try {
          const res = await fetch(base + path, {
            headers: { 'x-cron-secret': secret },
            signal: AbortSignal.timeout(50_000),
          })
          if (!res.ok && res.status !== 503) console.warn(`[scheduler] ${path} → ${res.status}`)
        } catch (err) {
          console.warn(`[scheduler] ${path} failed:`, err instanceof Error ? err.message : err)
        }
      }
    } finally {
      running = false
    }
  }
  g.__wacrmScheduler = setInterval(() => void tick(), INTERVAL_MS)
  console.log('[scheduler] built-in scheduler on: automations, flows and wallet crons every 60s')
}
