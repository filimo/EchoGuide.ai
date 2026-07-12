import type { ServerOptions } from "node:https";

const DEV_CERT_KEY = ".certs/echoguide-dev.key";
const DEV_CERT = ".certs/echoguide-dev.crt";

type CertFileSystem = {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => Buffer;
};

export function createDevHttpsConfig(fileSystem: CertFileSystem): ServerOptions | undefined {
  if (!fileSystem.existsSync(DEV_CERT_KEY) || !fileSystem.existsSync(DEV_CERT)) {
    return undefined;
  }

  return {
    key: fileSystem.readFileSync(DEV_CERT_KEY),
    cert: fileSystem.readFileSync(DEV_CERT)
  };
}
