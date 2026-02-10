import { execSync } from "node:child_process";

if (process.env.CI !== "true") {
  try {
    execSync("npm run setup-hooks", { stdio: "inherit" });
  } catch {
    process.exit(1);
  }
}
