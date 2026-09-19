# Retail Store Manager skills for vanilla Hermes

This is a self-contained synthetic Store Manager demo for an existing vanilla
Hermes Agent installation. It contains only the use-case runtime:

- six Hermes Store Manager skills;
- Apache Camel routes and synthetic retail fixtures;
- the Store Manager web UI and image assets;
- signed loopback webhooks and a Hermes lifecycle hook; and
- Phoenix 19.7 with Hermes's built-in NeMo Relay OpenInference exporter.

It does not install Hermes or use NemoClaw, NemoHermes, OpenShell, policy
management, Switchyard, OpenViking, or the original toolkit bootstrap.

## Requirements

- A working host-installed vanilla Hermes Agent with its primary model already
  configured.
- Docker Engine and Docker Compose v2.
- `bash`, `curl`, `jq`, `openssl`, `python3`, and `sha256sum`.
- A Telegram bot configured in Hermes and exactly one numeric Telegram user ID.
- Hermes auxiliary vision configured to a vision-capable model. A local
  OpenAI-compatible model endpoint is supported.

Configure a missing Telegram bot locally with:

```bash
hermes gateway setup
```

Enter the bot token only in Hermes's local masked prompt. Never put it in chat
or a command argument.

## Install

If auxiliary vision is already configured:

```bash
./install.sh --telegram-user-id <NUMERIC_TELEGRAM_USER_ID>
```

To configure auxiliary vision at the same time:

```bash
./install.sh \
  --telegram-user-id <NUMERIC_TELEGRAM_USER_ID> \
  --vision-provider custom \
  --vision-model <VISION_MODEL_ID> \
  --vision-base-url http://127.0.0.1:8000/v1
```

The defaults are store `SEA-014`, fixture date `2026-08-03`, UI port `3000`,
Phoenix port `6006`, Hermes webhook port `8644`, and Camel port `18080`. All
listeners remain on `127.0.0.1`.

Verify without changing the deployment:

```bash
./install.sh --verify
```

Open:

- Store Manager UI: http://127.0.0.1:3000
- Phoenix: http://127.0.0.1:6006

After a fresh install, send `/reset` once to the Telegram bot.

## Copy/paste prompt for Codex

Replace the repository URL or local-model details only if needed, then paste
this into Codex on the target machine:

```text
Clone https://github.com/antoniomtz/retail-store-manager-skills.git and deploy
it into the vanilla Hermes Agent already installed for my current Linux user.

Read AGENTS.md and README.md before doing anything. This is an independent
vanilla-Hermes deployment: do not install or configure NemoClaw, NemoHermes,
OpenShell, policies, Switchyard, OpenViking, or another Hermes instance. Do not
change my working primary model route.

First perform read-only checks for the OS/architecture, free disk space,
Docker and Docker Compose, Hermes version and home, gateway status, the current
primary model, auxiliary vision configuration, Telegram configuration presence,
and whether loopback ports 3000, 6006, 8644, and 18080 are available. Summarize
the result and ask for my approval before pulling/building images, changing
Hermes configuration, restarting the gateway, or starting containers.

Never ask me to paste a bot token, API key, password, or other credential in
chat. If the Telegram bot token is missing, launch `hermes gateway setup` in my
interactive terminal so Hermes collects it through its masked local prompt.
Ask me only for the numeric Telegram user ID if you cannot determine it safely.

Use my existing auxiliary vision configuration if it is valid. Otherwise use
the local OpenAI-compatible vision endpoint and model I provide, without
changing the primary model. Then run the repository's ./install.sh with the
numeric Telegram ID and, only if needed, all three --vision-provider,
--vision-model, and --vision-base-url options. Do not substitute manual file
copies or custom Docker commands for the installer.

After installation, run `./install.sh --verify`. Open or report the loopback UI
at http://127.0.0.1:3000 and Phoenix at http://127.0.0.1:6006. Trigger one
synthetic Store incident from the UI, wait for the Hermes webhook turn to
finish, and verify that Telegram receives the advisory and the UI telemetry API
shows Phoenix connected, Relay/OpenInference active or recent, and at least one
completed plain-language Hermes activity. If telemetry is arriving but the
plain-language activity is empty, check for the `hermes.turn` compatibility
already included in this repository rather than repinning Relay.

Keep every service loopback-only. Use only the checked-in synthetic data and
incident image. Report exact failed checks; do not weaken webhook
authentication, expose ports publicly, or print secrets.
```

## Demo commands

Trigger OPD or checkout synthetic events from the checkout root:

```bash
store-manager/scripts/simulate-opd-event.sh reset
store-manager/scripts/simulate-opd-event.sh incident

store-manager/scripts/simulate-checkout-event.sh reset
store-manager/scripts/simulate-checkout-event.sh incident
```

Generate the independent end-of-day fixture, then ask Hermes for the review:

```bash
store-manager/scripts/simulate-store-day.sh run
```

The Store incident scenario is triggered from the UI. It uses only the
checked-in synthetic image and has no execution or approval endpoint.

## Runtime state

Generated state is stored outside the repository under:

```text
~/.local/share/retail-store-manager-skills
```

Hermes-owned files are installed under the active `HERMES_HOME` (default
`~/.hermes`). No credentials or generated state belong in this repository.
