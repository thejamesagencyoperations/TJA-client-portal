/* Exercises the real fetchT source (TS types stripped) against a server that can hang,
   fail, then recover — i.e. exactly the 2026-08-26 failure and its recovery. */
const fs = require("fs"), http = require("http");
let src = fs.readFileSync(__dirname + "/../supabase/functions/_shared/http.ts", "utf8");
src = src.replace(/export interface FetchTOpts \{[\s\S]*?\n\}/, "")
         .replace(/ as Error/g, "")
         .replace(/\(ms: number\)/g, "(ms)")
         .replace(/url: string, init: RequestInit = \{\}, opts: FetchTOpts = \{\}\): Promise<Response>/, "url, init = {}, opts = {})")
         .replace(/let lastErr: string/, "let lastErr")
         .replace(/export /g, "");
const { fetchT } = new Function(src + "\n return { fetchT };")();

let mode = "hang", hits = 0;
const srv = http.createServer((req, res) => {
  hits++;
  if (mode === "hang") return;                                  // never responds — the real bug
  if (mode === "flaky" && hits <= 2) { res.writeHead(503); return res.end("nope"); }
  res.writeHead(200, {"content-type":"text/csv"}); res.end("a,b\n1,2\n");
});

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  " + m); } else { fail++; console.log("  FAIL " + m); } };

srv.listen(0, async () => {
  const url = `http://127.0.0.1:${srv.address().port}/sheet.csv`;

  // 1. A HANGING server must throw FAST, not sit there. This is the whole point.
  mode = "hang"; hits = 0;
  let t = Date.now(), threw = null;
  try { await fetchT(url, {}, { timeoutMs: 300, retries: 2, label: "hang test" }); }
  catch (e) { threw = e; }
  const el = Date.now() - t;
  ok(!!threw, "hang throws instead of waiting forever");
  ok(/timed out after 300ms/.test(threw?.message || ""), "error names the timeout: " + threw?.message);
  ok(/failed after 3 attempt/.test(threw?.message || ""), "error reports the attempt count");
  ok(el < 3000, `bounded: gave up in ${el}ms, not the 150s that killed the real run`);
  ok(hits === 3, `retried: server saw ${hits} attempts`);

  // 2. Transient 5xx then recovery — the real-world case that lost the run
  mode = "flaky"; hits = 0;
  const r2 = await fetchT(url, {}, { timeoutMs: 2000, retries: 2, label: "flaky" });
  ok(r2.status === 200, "recovers after two 503s");
  ok(hits === 3, `took ${hits} attempts to get there`);
  ok((await r2.text()).includes("1,2"), "body intact after retry");

  // 3. Healthy server: one attempt, no artificial delay
  mode = "ok"; hits = 0;
  t = Date.now();
  const r3 = await fetchT(url, {}, { timeoutMs: 2000, retries: 2 });
  ok(r3.status === 200 && hits === 1, "healthy path takes exactly one attempt");
  ok(Date.now() - t < 500, "healthy path adds no latency");

  // 4. A 4xx is NOT retried — it won't fix itself, and the caller checks res.ok
  mode = "ok"; hits = 0;
  const srv2 = http.createServer((q, s2) => { hits++; s2.writeHead(404); s2.end(); });
  await new Promise(r => srv2.listen(0, r));
  const r4 = await fetchT(`http://127.0.0.1:${srv2.address().port}/x`, {}, { retries: 2, timeoutMs: 2000 });
  ok(r4.status === 404 && hits === 1, `4xx returned once, not retried (${hits} attempt)`);
  srv2.close();

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
