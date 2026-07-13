# Local development

## Prerequisites

- Node.js 20+
- npm
- an OpenAI API key
- `mkcert` recommended for trusted local HTTPS

## Install and configure

```bash
npm install
cp .env.example .env.local
```

Add your key to `.env.local`:

```dotenv
OPENAI_API_KEY=your-key-here
```

Never commit `.env.local`.

## Localhost setup

Create a certificate and start the development server:

```bash
npm run dev:cert
npm run dev
```

Open `https://localhost:5173/`.

If `mkcert` is installed, the certificate script installs its local CA and creates a trusted certificate. Without `mkcert`, the script creates a short-lived self-signed fallback that browsers may warn about.

## iPad setup

Choose a Bonjour hostname for the Mac, then use the same value for certificate creation and the Vite allowed-host list:

```bash
export ECHOGUIDE_DEV_HOST="your-mac.local"
npm run dev:cert
npm run dev
```

Open `https://your-mac.local:5173/` on the iPad. The device must trust the `mkcert` root CA before Safari can use microphone permissions without a certificate warning.

For the first smoke test:

1. connect the iPad microphone;
2. place the iPad near an audible English conversation source;
3. add a short, public-safe context in `Pasted notes`;
4. enter Training Mode and select the expected speech language;
5. start the live session manually;
6. verify transcript turns, Russian meaning, bridge phrases, and suggested replies;
7. stop the session and confirm that the microphone track is released.

After editing `Pasted notes`, reload the page and confirm that the local development server restores the same context from `.echoguide/knowledge.local.md`. The file is ignored by Git and must not contain secrets that should not be sent to phrase analysis.

## Realtime Lab

Open `/realtime-lab` to inspect raw Realtime events, connection state, VAD behavior, and fallback transcription controls. The lab is a diagnostic surface, not the main product flow.

## Validation

```bash
npm run lint
npm run test
npm run build
npm run smoke
```

The optional model comparison makes real API calls:

```bash
npm run eval:models
```

## Diagnostics

Local Realtime diagnostics are written to:

```text
.echoguide/diagnostics/realtime-YYYY-MM-DD.jsonl
```

The log contains transport states and aggregate counters, not raw audio, transcripts, notes, knowledge context, or credentials.
