import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [parentPidFile, childPidFile, heartbeatFile] = process.argv.slice(2);
writeFileSync(parentPidFile, String(process.pid));
process.on("SIGTERM", () => {});
spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "process-tree-child.mjs"), childPidFile, heartbeatFile], {
  stdio: "ignore",
});
setInterval(() => appendFileSync(heartbeatFile, "parent\n"), 25);
