/* ============================================================
   SLACK PR WINS — per-hit "send to Slack" (admin-curated)
   The team chooses which PR hits go to the wins channel — nothing
   is sent automatically. The button POSTs the hit to a tiny Apps
   Script PROXY that holds the Slack webhook privately (the webhook
   can never live in this public repo: GitHub secret-scanning would
   get it auto-revoked, and anyone could read it).

   Setup: deploy the proxy script (Claude provides it) as a Web App
   (Execute as: Me · Access: Anyone), then paste its /exec URL below.
   Blank URL = the buttons stay hidden.

   PRODUCTION NOTE: moves to the real authenticated backend in the
   Step-6 build (see PM-PLANNING-BOOKMARKS.md).
   ============================================================ */
window.SLACK_WINS = (function () {
  const PROXY_URL = "";   // ← paste the Apps Script proxy /exec URL here

  function enabled() { return !!PROXY_URL; }
  // stable identity for a hit (date+outlet+link), used to remember what's been sent
  function keyFor(h) { return [h.date || "", h.outlet || "", h.link || ""].join("|"); }

  async function send(clientName, hit) {
    // no custom headers → "simple" POST (no CORS preflight, which Apps Script can't answer)
    const res = await fetch(PROXY_URL, {
      method: "POST",
      body: JSON.stringify({
        client: clientName,
        outlet: hit.outlet || "",
        date: hit.date || "",
        link: hit.link || "",
        impressions: hit.impressions || "",
        adValue: hit.adValue || "",
      }),
    });
    const j = await res.json().catch(() => null);
    if (!j || !j.ok) throw new Error((j && j.error) || ("send failed: " + res.status));
    return true;
  }

  return { enabled, keyFor, send };
})();
