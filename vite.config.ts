import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { createDevHttpsConfig } from "./src/config/devHttps";
import { createRealtimeDevServerPlugin } from "./src/realtime/realtimeDevServer";
import { createMacAudioPlugin } from "./src/macAudio/server";

const additionalAllowedHost = process.env.ECHOGUIDE_DEV_HOST?.trim();

export default defineConfig({
  plugins: [react(), createMacAudioPlugin(), createRealtimeDevServerPlugin()],
  server: {
    allowedHosts: additionalAllowedHost ? [additionalAllowedHost] : [],
    https: createDevHttpsConfig({ existsSync, readFileSync })
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    globals: true
  }
});
