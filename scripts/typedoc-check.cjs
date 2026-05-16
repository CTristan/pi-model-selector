const fs = require("node:fs");
const [file, thresholdText] = process.argv.slice(2);
const threshold = Number(thresholdText);

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  console.error(
    `Invalid threshold: ${thresholdText}. Must be a number between 0 and 100.`,
  );
  process.exit(1);
}

if (!fs.existsSync(file)) {
  console.error(`Coverage file not found: ${file}`);
  process.exit(1);
}

let coverage;
try {
  coverage = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  console.error(`Malformed coverage JSON in ${file}: ${e.message}`);
  process.exit(1);
}

if (typeof coverage !== "object" || coverage === null) {
  console.error(`Invalid coverage JSON structure in ${file}`);
  process.exit(1);
}

const percent = Number(coverage.percent);

if (coverage.percent === null || !Number.isFinite(percent)) {
  console.error(`Invalid TypeDoc coverage percent in ${file}`);
  process.exit(1);
}

console.log(
  `TypeDoc documentation coverage: ${percent}% (${coverage.actual}/${coverage.expected})`,
);

if (percent < threshold) {
  const missing = Array.isArray(coverage.notDocumented)
    ? ` Missing documentation: ${coverage.notDocumented.join(", ")}`
    : "";
  console.error(
    `TypeDoc documentation coverage ${percent}% is below the required ${threshold}%.${missing}`,
  );
  process.exit(1);
}
