# Vanilla Hermes Store Manager deployment

## Scope

This repository installs the synthetic Store Manager demo into an existing,
host-installed vanilla Hermes Agent. It does not install or manage Hermes,
NemoClaw, OpenShell, model servers, network policies, Switchyard, or OpenViking.

Use the checked-in `install.sh`; do not replace it with a second installer or a
sequence of improvised configuration commands.

## Before deployment

1. Read `README.md` and `./install.sh --help`.
2. Use read-only checks to confirm the OS, architecture, free disk space,
   Docker Engine, Docker Compose v2, the `hermes` command, Hermes version,
   `~/.hermes/config.yaml`, gateway status, and loopback port availability for
   `3000`, `6006`, `8642`, `8644`, and `18080`.
3. Confirm that the user's primary local model already works in Hermes. This
   repository must not change the primary model route.
4. Summarize the checks and obtain approval before pulling/building images,
   writing Hermes configuration, restarting the gateway, or starting services.

## Optional Telegram and credentials

- Telegram is optional. Without `--telegram-user-id`, incident assessments are
  available in the UI; Telegram notifications and manager action buttons are
  unavailable.
- Never ask the user to paste a bot token, API key, password, or private
  endpoint into chat, source, a command argument, documentation, or a commit.
- When the user requests Telegram and it is not configured, run `hermes gateway
  setup` in the user's interactive terminal and let Hermes collect the bot
  token through its local masked prompt. Then run the installer with
  `--telegram-user-id`.
- For Telegram, the installer updates only `TELEGRAM_ALLOWED_USERS` and
  `TELEGRAM_HOME_CHANNEL`; it does not read or print the bot token.
- The installer enables Hermes's loopback API server for UI incident assessment
  and the optional Chat tab. It
  reuses a supported `API_SERVER_KEY` or generates one locally, stores a
  server-only copy with mode `0600`, and never prints or sends it to the
  browser.

## Deployment

Use the existing auxiliary-vision configuration when it is valid. If it is
missing, collect only the non-secret provider name, model ID, and API base and
pass all three `--vision-*` options. For an unauthenticated loopback model, no
credential is needed.

Run:

```bash
./install.sh
```

Add `--telegram-user-id <NUMERIC_ID>` only when Telegram delivery is requested.
Add all three `--vision-provider`, `--vision-model`, and `--vision-base-url`
flags only when `hermes config get auxiliary.vision.model` does not already
return the intended model.

The installer:

- starts loopback-only Apache Camel, Phoenix, and the Store Manager UI;
- enables the dynamic morning-priority dashboard and an authenticated,
  stateful Hermes chat session in the UI;
- installs six categorized skills, the Store Manager `USER.md`, the synthetic
  incident image, and one response lifecycle hook under the current Hermes
  home;
- configures three HMAC-signed loopback webhooks with Telegram delivery when a
  user ID is supplied and local log delivery otherwise;
- enables the webhook and API-server terminal, skills, and vision toolsets,
  plus Telegram clarify buttons only when Telegram is enabled;
- activates the NeMo Relay observability plugin already bundled with supported
  vanilla Hermes versions; and
- restarts the existing Hermes gateway.

Do not bind services to `0.0.0.0`. Do not add a tunnel, MCP server, policy
engine, or alternate agent runtime.

## Verification

Run:

```bash
./install.sh --verify
```

Treat a failed check as a diagnosis target. Do not bypass webhook
authentication, configured Telegram authorization, vision configuration, or the
metadata-only Relay exporter. Relay/Phoenix are outside inference; an
observability failure must not break Hermes inference.

For the final synthetic canary, trigger the Store incident control with UI
delivery and confirm:

- the UI streams filtered Hermes tool progress and renders the completed rich
  advisory in its dialog;
- `/api/platform-telemetry` reports Phoenix connected;
- Relay and OpenInference become active or recent; and
- the plain-language view contains a completed `hermes.turn` activity.

If Telegram was requested, also verify its delivery and send `/reset` once in
that conversation after a fresh installation.

## Data boundary

Everything in this repository is synthetic demo data. Do not connect these
direct REST helpers to customer systems or use identifiable incident images.
Prompts, responses, tool arguments, paths, commands, and session identifiers
remain excluded from the demo UI's telemetry projection.
