// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { UserConfig } from "vite";
import { createDevHttpsConfig } from "./devHttps";
import config from "../../vite.config";

describe("vite config", () => {
  it("does not expose a machine-specific hostname by default", () => {
    const viteConfig = config as UserConfig;

    expect(viteConfig.server?.allowedHosts).toEqual([]);
  });

  it("can load local HTTPS certs for iPad microphone smoke checks", () => {
    const httpsConfig = createDevHttpsConfig({
      existsSync: () => true,
      readFileSync: (path) => Buffer.from(`cert:${path}`)
    });

    expect(httpsConfig).toEqual({
      key: Buffer.from("cert:.certs/echoguide-dev.key"),
      cert: Buffer.from("cert:.certs/echoguide-dev.crt")
    });
  });

  it("keeps HTTP dev mode when local HTTPS certs are missing", () => {
    const httpsConfig = createDevHttpsConfig({
      existsSync: () => false,
      readFileSync: () => Buffer.from("unused")
    });

    expect(httpsConfig).toBeUndefined();
  });
});
