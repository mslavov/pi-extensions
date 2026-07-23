import { appendFileSync, writeFileSync } from "node:fs";

const [pidFile, heartbeatFile] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => appendFileSync(heartbeatFile, "child\n"), 25);
