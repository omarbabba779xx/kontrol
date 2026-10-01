// Prints the built-in crosswalk as JSON: { framework: { requirementId: [unifiedControlCodes] } }.
//   node --conditions=react-server --import tsx scripts/export-crosswalk.ts > crosswalk.json
import { FRAMEWORKS } from "../src/lib/frameworks/catalog";
import { baseControls } from "../src/lib/frameworks/mapping";

const out: Record<string, Record<string, string[]>> = {};
for (const framework of FRAMEWORKS) {
  out[framework.id] = {};
  for (const requirement of framework.requirements) out[framework.id][requirement.id] = baseControls(framework.id, requirement.id);
}
process.stdout.write(JSON.stringify(out));
