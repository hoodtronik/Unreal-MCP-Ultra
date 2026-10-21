// Run ONE call from the Tools/python libs against the live editor (probe helper, same path the tools use).
//   node Tools/test/manual/py-call.mjs "<python call using P>" '<json P>' [lib.py,lib2.py]
import { runPose } from "../../dist/tools/posing.js";
const [call, json = "{}", libs = "ue_posing.py"] = process.argv.slice(2);
const r = await runPose(call, JSON.parse(json), libs.split(","));
console.log(JSON.stringify(r, null, 1));
if (!r.ok) process.exit(1);
