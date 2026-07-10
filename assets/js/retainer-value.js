/* ============================================================
   RETAINER VALUE (SOW $ ÷ hourly rate) — Google Apps Script feed
   READ-ONLY. The deployed script (doGet only, no write methods) reads
   the revenue-forecasting workbook and returns each client's signed
   retainer SOW(s): { sow, code, rate, total $ }. We do NOT touch the
   workbook — this only fetches its published web-app JSON.

   This gives an ADVISORY monthly-hours TARGET per client (total $ ÷
   rate ÷ 12 months) — a reference number for the admin, not an
   auto-fill. We never guess a per-discipline split from it (a client's
   real service mix isn't in this feed), so it never silently shows a
   client a fabricated number. See retainerValueTarget on the retainer
   engagement + the burn tile's "unset" hint in exec-summary.js.
   ============================================================ */
window.WMJ_RETAINER_VALUE = (function () {
  const URL = "https://script.google.com/macros/s/AKfycbzXjSg15uTCAnahwUlDIHf7p1j139V4yvHElGG4hABxHkvPCZoOLaZsu7Zh44wyitzZ/exec";
  const PENDING = /pending|proposal|draft|on\s*hold/i;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  async function fetchRaw() {
    const res = await fetch(URL, { cache: "no-store" });
    if (!res.ok) throw new Error("retainer-value fetch " + res.status);
    return res.json();
  }

  // Current-month key candidates matching the sheet's "Jul 2026" / "July 2026" headers
  function monthKeys() {
    const d = new Date(), y = d.getFullYear();
    return [d.toLocaleString("en-US", { month: "short" }) + " " + y,
            d.toLocaleString("en-US", { month: "long" }) + " " + y];
  }

  // Hours for one tab's retainer SOWs. PREFER the current month's actual billing $ ÷ rate
  // (exact — handles partial-year retainers like DNA's Jul–Dec schedule); fall back to
  // total $ ÷ rate ÷ 12 (annual average) for SOWs whose month columns aren't in the feed.
  function hrsForRetainers(retainers) {
    const keys = monthKeys();
    let hrs = 0, hasHrs = false, anyMonthly = false, hasPending = false;
    (retainers || []).forEach(r => {
      if (PENDING.test(r.sow || "")) { hasPending = true; return; }
      if (!r.rate) return;
      let m = null;
      if (r.months) for (const k of keys) { if (r.months[k] != null) { m = r.months[k]; break; } }
      if (m != null) { hrs += m / r.rate; hasHrs = true; anyMonthly = true; }
      else if (r.total != null) { hrs += r.total / r.rate / 12; hasHrs = true; }
    });
    return { hrs: hasHrs ? Math.round(hrs * 100) / 100 : null, monthly: anyMonthly, hasPending };
  }

  // → Map<code, {hrs, monthly, hasPending, sows}>, keyed by the SOW's own leading-token code
  // (matches our WMJ Campaign_Name-derived client.code) AND by the tab name (normalized) as a
  // fallback for SOWs named generically, e.g. "Organic Social Media Retainer" on the
  // "Innerbloom" tab — the retainer's own code ("Organic") won't match any client code,
  // but the tab name will.
  function buildIndex(data) {
    const byCode = new Map(), byTab = new Map();
    (data.clients || []).forEach(t => {
      const { hrs, monthly, hasPending } = hrsForRetainers(t.retainers);
      const sows = (t.retainers || []).map(r => ({ sow: r.sow, total: r.total, rate: r.rate, pending: PENDING.test(r.sow || "") }));
      const entry = { hrs, monthly, hasPending, sows };
      (t.retainers || []).forEach(r => { if (r.code) byCode.set(r.code.toUpperCase(), entry); });
      byTab.set(norm(t.tab), entry);
    });
    return { byCode, byTab };
  }

  let cached = null;
  async function forRoster(roster) {
    if (!cached) cached = buildIndex(await fetchRaw());
    const out = new Map();   // clientId -> entry
    roster.forEach(c => {
      const entry = (c.code && cached.byCode.get(c.code.toUpperCase())) || cached.byTab.get(norm(c.name));
      if (entry) out.set(c.id, entry);
    });
    return out;
  }

  return { forRoster };
})();
