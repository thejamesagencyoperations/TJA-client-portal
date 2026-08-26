/* ============================================================
   FETCH WITH A HARD TIMEOUT (+ bounded retries)

   WHY THIS EXISTS — 2026-08-26, "Monthly data snapshot" failed:
     curl: (22) ... error: 504
     {"code":"IDLE_TIMEOUT","message":"Request idle timeout limit (150s) reached"}

   A bare fetch() has NO timeout. The retainer-actuals read (a 770KB published-CSV from
   Google Sheets) stalled mid-transfer, snapshot-months sat on that promise, and Supabase
   killed the entire request at its 150s idle limit — on a run that normally finishes in
   18-27 seconds.

   Two things made it worse than a slow day:
     • A HANG NEVER THROWS. The caller's try/catch around fetchRetainerActuals() reports the
       failure to _health, but it never fired, so System Health showed nothing wrong. The only
       trace was the Actions log.
     • No retry anywhere, so one transient Google stall lost the whole run.

   AbortSignal.timeout() converts the hang into a fast, catchable error, which restores both
   the health reporting and the function's own 502 path. Retries then absorb the transient
   case that caused this in the first place — the sheet tested healthy minutes later.

   Budget: attempts × timeoutMs must stay well under Supabase's 150s ceiling, since the
   caller still has work to do afterwards. The defaults (3 × 20s + ~1.5s backoff ≈ 62s worst
   case) leave the snapshot ample room for its per-client writes.
   ============================================================ */

export interface FetchTOpts {
  timeoutMs?: number;    // per ATTEMPT, not for the whole call
  retries?: number;      // additional attempts after the first
  label?: string;        // what to call this in the error message
  retryOn5xx?: boolean;  // treat a 5xx as transient (default true — these are all idempotent reads)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchT(url: string, init: RequestInit = {}, opts: FetchTOpts = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const retries = opts.retries ?? 2;
  const label = opts.label ?? url.split("?")[0];
  const retryOn5xx = opts.retryOn5xx !== false;
  let lastErr = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (retryOn5xx && res.status >= 500 && attempt < retries) {
        lastErr = `HTTP ${res.status}`;
      } else {
        return res;
      }
    } catch (e) {
      // TimeoutError is what AbortSignal.timeout() raises; everything else here is a network
      // fault. Both are worth another go — neither means the request was wrong.
      const err = e as Error;
      lastErr = err?.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : String(err?.message || err);
      if (attempt >= retries) break;
    }
    await sleep(500 * Math.pow(2, attempt));   // 0.5s, then 1s
  }
  throw new Error(`${label} failed after ${retries + 1} attempt(s): ${lastErr}`);
}
