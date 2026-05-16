const fs = require("node:fs");
const [file, thresholdText] = process.argv.slice(2);
const threshold = Number(thresholdText);

if (!fs.existsSync(file)) {
  console.error(`Coverage file not found: ${file}`);
  process.exit(1);
}

const coverage = JSON.parse(fs.readFileSync(file, "utf8"));
const percent = Number(coverage.percent);

if (!Number.isFinite(percent)) {
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
