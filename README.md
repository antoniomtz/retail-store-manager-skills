# Retail Store Manager skills for vanilla Hermes

This is a self-contained synthetic Store Manager demo for an existing vanilla
Hermes Agent installation. It contains only the use-case runtime:

- six Hermes Store Manager skills;
- Apache Camel routes and synthetic retail fixtures;
- the Store Manager web UI and image assets;
- a dynamic opening dashboard and stateful Hermes chat;
- signed loopback webhooks and a Hermes lifecycle hook; and
- Phoenix 19.7 with Hermes's built-in NeMo Relay OpenInference exporter.

It does not install Hermes or use NemoClaw, NemoHermes, OpenShell, policy
management, Switchyard, OpenViking, or the original toolkit bootstrap.

## Requirements

- A working host-installed vanilla Hermes Agent with its primary model already
  configured.
- Docker Engine and Docker Compose v2.
- `bash`, `curl`, `jq`, `openssl`, `python3`, and `sha256sum`.
- Optional: a Telegram bot configured in Hermes and one numeric Telegram user
  ID for notifications and manager action buttons.
- Hermes auxiliary vision configured to a vision-capable model. A local
  OpenAI-compatible model endpoint is supported.

To enable Telegram, configure the bot locally with:

```bash
hermes gateway setup
```

Enter the bot token only in Hermes's local masked prompt. Never put it in chat
or a command argument.

## Install

If auxiliary vision is already configured, install with UI delivery only:

```bash
./install.sh
```

Add Telegram delivery when needed:

```bash
./install.sh --telegram-user-id <NUMERIC_TELEGRAM_USER_ID>
```

To configure auxiliary vision at the same time:

```bash
./install.sh \
  --vision-provider custom \
  --vision-model <VISION_MODEL_ID> \
  --vision-base-url http://127.0.0.1:8000/v1
```

The defaults are store `SEA-014`, fixture date `2026-08-03`, UI port `3000`,
Phoenix port `6006`, Hermes API port `8642`, Hermes webhook port `8644`, and
Camel port `18080`. All listeners remain on `127.0.0.1`.

The installer enables vanilla Hermes's authenticated loopback API server for
UI incident assessment and enables the Chat tab by default. It reuses an
existing strong `API_SERVER_KEY` or
creates a random 64-character key when none exists. The key remains in the
mode-`0600` Hermes environment and package state; it is mounted read-only into
the UI server and never sent to the browser. Disable chat explicitly with:

```bash
STORE_MANAGER_ENABLE_CHAT=0 \
  ./install.sh
```

Verify without changing the deployment:

```bash
./install.sh --verify
```

Open:

- Store Manager UI: http://127.0.0.1:3000
- Phoenix: http://127.0.0.1:6006

When Telegram is configured, send `/reset` once to the bot after a fresh
install.

The UI opens on the Dashboard tab. A successful morning briefing publishes its
one-to-four current manager priorities to that dashboard. Reset clears only
the UI presentation and telemetry window; it does not delete Phoenix traces.
When no briefing is present, select **Give me a morning briefing** to open Chat
and send that prompt to Hermes.
The Chat tab maintains one Hermes session per browser tab and includes example
prompts for the morning briefing, current priorities, OPD, and checkout.
The Store incident tab defaults to UI delivery: it runs an isolated Hermes
session while keeping the incident image visible. Filtered tool progress appears
in the scenario panel. Select **View live output** or **View assessment** to
open the closeable result dialog. Telegram is selectable only when
`--telegram-user-id` was provided during installation.

The store view is an animated 3D store (Three.js) you can orbit freely, with
8-bit shoppers and associates walking routes computed from its shelves and
walls. Checkout customers, OPD pickers and backlog, and the incident spill
follow the live scenario state. Drag to rotate, scroll or use the zoom
controls to zoom, and right-drag or use the arrow keys to pan; Home or Reset
returns to the whole store. Selecting **Checkout queue**, **OPD surge**, or
**Store incident** glides back to the isometric angle and frames that area.
The browser needs WebGL 2; without it, the store area shows an unavailable
message and the scenario controls keep working.

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
primary model, auxiliary vision configuration, optional Telegram configuration,
and whether loopback ports 3000, 6006, 8642, 8644, and 18080 are available. Summarize
the result and ask for my approval before pulling/building images, changing
Hermes configuration, restarting the gateway, or starting containers.

Never ask me to paste a bot token, API key, password, or other credential in
chat. Telegram is optional. If I request Telegram delivery and its bot token is
missing, launch `hermes gateway setup` in my interactive terminal so Hermes
collects it through its masked local prompt. Ask me only for the numeric
Telegram user ID if I request Telegram and you cannot determine it safely.

Use my existing auxiliary vision configuration if it is valid. Otherwise use
the local OpenAI-compatible vision endpoint and model I provide, without
changing the primary model. Then run the repository's ./install.sh and, only if
needed, all three --vision-provider, --vision-model, and --vision-base-url
options. Add --telegram-user-id only if I request Telegram delivery. Do not
substitute manual file copies or custom Docker commands for the installer.

Allow the installer to enable Hermes's authenticated API server on loopback for
the Store Manager incident workflow and Chat tab. Do not print or request its
API key, enable browser CORS, or expose the API server directly.

After installation, run `./install.sh --verify`. Open or report the loopback UI
at http://127.0.0.1:3000 and Phoenix at http://127.0.0.1:6006. Trigger one
synthetic Store incident with UI delivery, wait for Hermes to finish, and
select **View assessment** to verify the rich result in the UI dialog. If
Telegram was requested, verify delivery separately. Confirm that the UI telemetry
API shows Phoenix connected, Relay/OpenInference active or recent, and at least
one completed plain-language Hermes activity. If telemetry is arriving but the
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
`~/.hermes`). Protected runtime state includes the webhook secret and a
server-only copy of the Hermes API key. No credentials or generated state
belong in this repository.
