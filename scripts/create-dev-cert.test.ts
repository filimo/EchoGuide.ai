// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "create-dev-cert.sh");
const tempDirs: string[] = [];

function createTempDir() {
  const tempDir = mkdtempSync(join(tmpdir(), "echoguide-dev-cert-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("create-dev-cert.sh", () => {
  it("uses mkcert to create a trusted local development certificate when available", () => {
    const tempDir = createTempDir();
    const binDir = join(tempDir, "bin");
    mkdirSync(binDir);

    writeFileSync(
      join(binDir, "mkcert"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${tempDir}/mkcert.log"
if [ "$1" = "-install" ]; then
  exit 0
fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    -key-file)
      key_path="$2"
      shift 2
      ;;
    -cert-file)
      cert_path="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
printf 'trusted key\\n' > "$key_path"
printf 'trusted cert\\n' > "$cert_path"
`,
      { mode: 0o755 }
    );

    const output = execFileSync(scriptPath, {
      cwd: tempDir,
      env: {
        ...process.env,
        ECHOGUIDE_DEV_HOST: "echoguide-dev.local",
        PATH: `${binDir}:${process.env.PATH ?? ""}`
      },
      encoding: "utf8"
    });

    expect(output).toContain("created trusted local HTTPS certificate");
    expect(readFileSync(join(tempDir, "mkcert.log"), "utf8")).toContain("-install");
    expect(readFileSync(join(tempDir, "mkcert.log"), "utf8")).toContain(
      "-key-file .certs/echoguide-dev.key -cert-file .certs/echoguide-dev.crt localhost 127.0.0.1 ::1 echoguide-dev.local"
    );
    expect(readFileSync(join(tempDir, ".certs/echoguide-dev.key"), "utf8")).toBe("trusted key\n");
    expect(readFileSync(join(tempDir, ".certs/echoguide-dev.crt"), "utf8")).toBe("trusted cert\n");
  });
});
