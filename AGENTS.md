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
   `3000`, `6006`, `8644`, and `18080`.
3. Confirm that the user's primary local model already works in Hermes. This
   repository must not change the primary model route.
4. Summarize the checks and obtain approval before pulling/building images,
   writing Hermes configuration, restarting the gateway, or starting services.

## Telegram and credentials

- The deployment requires one numeric Telegram user ID.
- Never ask the user to paste a bot token, API key, password, or private
  endpoint into chat, source, a command argument, documentation, or a commit.
- If Telegram is not configured, run `hermes gateway setup` in the user's
  interactive terminal and let Hermes collect the bot token through its local
  masked prompt. Then run the installer with `--telegram-user-id`.
- The installer updates only `TELEGRAM_ALLOWED_USERS` and
  `TELEGRAM_HOME_CHANNEL`; it does not read or print the bot token.

## Deployment

Use the existing auxiliary-vision configuration when it is valid. If it is
missing, collect only the non-secret provider name, model ID, and API base and
pass all three `--vision-*` options. For an unauthenticated loopback model, no
credential is needed.

Run:

```bash
./install.sh \
  --telegram-user-id <NUMERIC_ID> \
  --vision-provider <PROVIDER> \
  --vision-model <MODEL_ID> \
  --vision-base-url <OPENAI_COMPATIBLE_API_BASE>
```

Omit the three vision flags only when `hermes config get
auxiliary.vision.model` already returns the intended model.

The installer:

- starts loopback-only Apache Camel, Phoenix, and the Store Manager UI;
- installs six categorized skills, the Store Manager `USER.md`, the synthetic
  incident image, and one response lifecycle hook under the current Hermes
  home;
- configures three HMAC-signed loopback webhooks targeting the specified
  Telegram user;
- enables the webhook terminal, skills, and vision toolsets plus Telegram
  clarify buttons;
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
authentication, Telegram authorization, vision configuration, or the
metadata-only Relay exporter. Relay/Phoenix are outside inference; an
observability failure must not break Hermes inference.

For the final synthetic canary, trigger the Store incident control in the UI
and confirm:

- Telegram receives the completed advisory;
- `/api/platform-telemetry` reports Phoenix connected;
- Relay and OpenInference become active or recent; and
- the plain-language view contains a completed `hermes.turn` activity.

Send `/reset` once in the Telegram conversation after a fresh installation.

## Data boundary

Everything in this repository is synthetic demo data. Do not connect these
direct REST helpers to customer systems or use identifiable incident images.
Prompts, responses, tool arguments, paths, commands, and session identifiers
remain excluded from the demo UI's telemetry projection.
