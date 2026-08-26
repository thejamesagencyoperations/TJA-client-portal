/* The guard that turns a SILENT feed failure into a loud one.
   An expired IMPORTDATA linkKey returns HTTP 200 with a sheet full of #N/A. Both parsers used
   to read that as "no rows", which is indistinguishable from a quiet weekend — and because of
   the month roll-forward, every retainer client would roll to 0 hours with the burn gauge
   reading 0%. Lifted from the real source so it can't drift. */
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../supabase/functions/_shared/wmj.ts", "utf8");
const a = src.indexOf("function assertLooksLikeTimesheetCsv");
const b = src.indexOf("async function fetchRetainerCsv");
if (a < 0 || b < 0) throw new Error("markers not found");
const js = src.slice(a, b).replace(/: string|: void/g, "");
const { assertLooksLikeTimesheetCsv: guard } = new Function(js + "\n return { assertLooksLikeTimesheetCsv };")();

let pass = 0, fail = 0;
const throws = (text, why, expect) => {
  let e = null;
  try { guard(text, "TEST FEED"); } catch (err) { e = err; }
  if (!e) { console.log(`  FAIL ${why}: did NOT throw`); fail++; return; }
  if (expect && !expect.test(e.message)) { console.log(`  FAIL ${why}: wrong message — ${e.message}`); fail++; return; }
  console.log(`  ok  rejects ${why}`); pass++;
};
const accepts = (text, why) => {
  try { guard(text, "TEST FEED"); console.log(`  ok  accepts ${why}`); pass++; }
  catch (e) { console.log(`  FAIL ${why}: threw — ${e.message}`); fail++; }
};

// THE failure mode this exists for
throws('Client_Name,Actual_Billable_Hours\n#N/A,#N/A\n', "a sheet full of #N/A", /EXPIRED/);
throws('#N/A ("Could not fetch url")', "the literal IMPORTDATA error text", /EXPIRED/);
throws('Client_Name\n#REF!\n', "#REF!");
throws('Client_Name\n#ERROR!\n', "#ERROR!");
// an API error arriving as JSON rather than CSV
throws('{"error":"invalid token"}', "a JSON error envelope", /returned JSON/);
throws('[{"x":1}]', "a JSON array");
// wrong report / empty response
throws('', "an empty body", /no Client_Name/);
throws('Some_Other,Columns\n1,2\n', "a CSV without Client_Name", /no Client_Name/);
// the real thing must still pass
accepts('Client_Name,User_Department,Actual_Billable_Hours,Service_Description\nHotel Valley Ho,Creative,4.5,Design\n', "a normal timesheet export");
accepts('client_name,actual_billable_hours\nx,1\n', "lower-case headers");
accepts('"Client_Name","Actual_Billable_Hours"\n"Hotel Valley Ho","4.5"\n', "quoted headers");
// a header-only export is legitimate (a genuinely empty month), and must NOT be an error
accepts('Client_Name,User_Department,Actual_Billable_Hours\n', "a header-only export (a real empty month)");
// the error must carry evidence, or it's no better than "no rows"
{
  let msg = "";
  try { guard('Client_Name\n#N/A\n', "MY FEED"); } catch (e) { msg = e.message; }
  if (msg.includes("MY FEED") && msg.includes("#N/A")) { console.log("  ok  error names the feed and quotes the evidence"); pass++; }
  else { console.log("  FAIL error lacks feed name or evidence: " + msg); fail++; }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
