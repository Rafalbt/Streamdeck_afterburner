// Standalone smoke test: dumps the MAHM sensor list (or reports unavailable).
import { readMahm, closeMahm } from "./mahm.js";
import { renderText, renderChart, formatValue } from "./renderer.js";
import { DEFAULTS } from "./settings.js";

const entries = readMahm();
if (entries === null) {
  console.log("readMahm() -> null (Afterburner not running / data not ready)");
} else {
  console.log(`readMahm() -> ${entries.length} sensors:`);
  for (const e of entries.slice(0, 60)) {
    console.log(`  ${e.name.padEnd(32)} ${formatValue(e.value).padStart(10)} ${e.unit}`);
  }
  const first = entries[0];
  if (first) {
    console.log("\n--- renderText sample ---");
    console.log(renderText(formatValue(first.value), first.unit, DEFAULTS));
    console.log("\n--- renderChart sample ---");
    console.log(renderChart([first.value, first.value * 0.9, first.value * 1.1, first.value], first.unit, DEFAULTS));
  }
}
closeMahm();
