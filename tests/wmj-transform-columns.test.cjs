/* Column handling in the projects transform.
   Origin: on 2026-08-27 the projects feed briefly moved to the WMJ API, whose reports name
   some columns differently from the sheet, and the sync died with
   "Cannot read properties of undefined (reading 'trim')" — a message that pointed nowhere
   near the real cause. A missing column must now fail ONCE, up front, naming itself. */
const fs = require("fs");
const win = {};
new Function("window", "module", fs.readFileSync(__dirname + "/../assets/js/wmj-transform.js", "utf8"))(win, {});
const T = win.WMJ_TRANSFORM;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  " + m); } else { fail++; console.log("  FAIL " + m); } };

const sheetRow = {
  Client_Name: "Acme", Campaign_Name: "ACM 2026 Build", Project_Name: "Phase 1",
  Task_Full_Name: "1 Homepage Coding", Allocated_Hours: "10", Project_Status: "Production",
  Plan_Start_Date: "", Plan_Completion_Date: "", Service: "Web Development",
};

// the normal sheet shape still works
{
  const out = T.transform([sheetRow]);
  ok(out.length === 1 && out[0].wmjName === "Acme", "the sheet's column names still parse");
}
// the API spelling of the task column is accepted rather than crashing
{
  const apiRow = Object.assign({}, sheetRow);
  delete apiRow.Task_Full_Name; apiRow.Task_Name = "1 Homepage Coding";
  let out = null, err = null;
  try { out = T.transform([apiRow]); } catch (e) { err = e; }
  ok(!err, "Task_Name (the API spelling) does not crash: " + (err && err.message));
  ok(out && out.length === 1, "and still produces the client");
}
// a genuinely missing column fails clearly, naming itself AND what did arrive
{
  const bad = { Campaign_Name: "X", Project_Name: "Y", Task_Full_Name: "Z", Some_Other: "1" };
  let err = null;
  try { T.transform([bad]); } catch (e) { err = e; }
  ok(!!err, "a missing required column throws");
  ok(err && /Client_Name/.test(err.message), "the error names the missing column");
  ok(err && /Some_Other/.test(err.message), "the error lists what DID arrive, for diagnosis");
  ok(err && !/reading 'trim'/.test(err.message), "and is not a null-pointer message");
}
// empty input is not an error — a genuinely empty report is legitimate
{
  let err = null;
  try { T.transform([]); } catch (e) { err = e; }
  ok(!err, "an empty feed does not throw");
}
// a row missing an OPTIONAL value must not crash the run
{
  const sparse = Object.assign({}, sheetRow, { Project_Name: "", Allocated_Hours: "" });
  let err = null;
  try { T.transform([sparse]); } catch (e) { err = e; }
  ok(!err, "blank optional values are tolerated");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
