import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";

// Only the helper's pre-capture test branch runs. No device discovery or capture.
const helperPath = resolve(process.argv[2]);
const supervisor = spawn(process.execPath, ["--input-type=module", "-e", `
  import { spawn } from "node:child_process";
  const helper = spawn(${JSON.stringify(helperPath)}, ["--self-test-owner-watchdog"], {
    env: { ...process.env, ECHOGUIDE_PARENT_PID: String(process.pid) },
    stdio: ["ignore", "inherit", "inherit"]
  });
  console.log(JSON.stringify({ helperPid: helper.pid }));
  helper.on("error", () => process.exit(1));
  setInterval(() => {}, 1000);
`], { stdio: ["ignore", "pipe", "pipe"] });
let helperPid;
let pending = "";
let ready = false;
let pipeClosed = false;
let spawnError;
supervisor.on("error", error => { spawnError = error; });
supervisor.stderr.resume();
supervisor.stdout.on("end", () => { pipeClosed = true; });
supervisor.stdout.on("data", chunk => {
  pending += chunk.toString();
  let end;
  while ((end = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    try {
      const event = JSON.parse(line);
      if (Number.isSafeInteger(event.helperPid)) helperPid = event.helperPid;
      if (event.type === "watchdog-test-ready") ready = true;
    } catch { /* This check consumes only synthetic readiness metadata. */ }
  }
});
async function until(predicate, message) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (spawnError) throw spawnError;
    if (Date.now() >= deadline) throw new Error(message);
    await delay(50);
  }
}
try {
  await until(() => ready && helperPid, "Native watchdog self-test did not start.");
  await delay(1500);
  process.kill(helperPid, 0);
  // The helper now blocks its main thread; only the independent watchdog can exit.
  supervisor.kill("SIGKILL");
  await until(() => pipeClosed, "Helper survived owner death with a blocked main thread.");
  console.log("Native owner watchdog passed (blocked main thread, no audio capture).");
} finally {
  supervisor.kill("SIGKILL");
  if (!pipeClosed && helperPid) {
    try { process.kill(helperPid, "SIGKILL"); } catch { /* Already exited. */ }
  }
}
