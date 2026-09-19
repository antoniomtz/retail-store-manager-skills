#!/usr/bin/env python3
"""Install the managed Store Manager webhook routes inside Hermes."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile

from hermes_cli.config import set_config_value
from hermes_constants import get_hermes_home


LOOPBACK_HOST = "127.0.0.1"
SECRET_PATTERN = re.compile(r"^[0-9a-f]{64}$")
ROUTE_SPECS = {
    "opd-surge": {
        "events": ["opd_incident", "opd_checkpoint"],
        "skills": ["opd-surge-response"],
    },
    "checkout-queue": {
        "events": ["checkout_queue_incident", "checkout_queue_checkpoint"],
        "skills": ["checkout-queue-recovery"],
    },
    "store-incident": {
        "events": ["store_incident_detected"],
        "skills": ["store-incident-response"],
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Configure the Store Manager webhook routes."
    )
    parser.add_argument("--routes-file", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    return parser.parse_args()


def validate_route(name: str, route: object) -> dict:
    if not isinstance(route, dict):
        raise ValueError(f"the staged {name} webhook route must be an object")
    spec = ROUTE_SPECS[name]
    if not SECRET_PATTERN.fullmatch(str(route.get("secret", ""))):
        raise ValueError(f"the staged {name} webhook route has no valid secret")
    if route.get("events") != spec["events"]:
        raise ValueError(f"the staged {name} webhook route has unsupported events")
    if route.get("skills") != spec["skills"]:
        raise ValueError(f"the staged {name} webhook route has an unsupported skill")
    if route.get("deliver") != "telegram" or route.get("deliver_only") is True:
        raise ValueError(f"the staged {name} route must run the agent and deliver to Telegram")
    deliver_extra = route.get("deliver_extra")
    if (
        not isinstance(deliver_extra, dict)
        or not isinstance(deliver_extra.get("chat_id"), str)
        or not re.fullmatch(r"^-?[0-9]+$", deliver_extra["chat_id"])
    ):
        raise ValueError(f"the staged {name} route has no configured Telegram user ID")
    if not isinstance(route.get("prompt"), str) or not route["prompt"].strip():
        raise ValueError(f"the staged {name} route has no prompt")
    return route


def load_routes(path: Path) -> dict[str, dict]:
    try:
        routes = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("the staged Store Manager webhook routes are invalid") from error
    if not isinstance(routes, dict) or set(routes) != set(ROUTE_SPECS):
        raise ValueError("the staged Store Manager webhook route set is incomplete")
    return {name: validate_route(name, routes[name]) for name in ROUTE_SPECS}


def load_subscriptions(path: Path) -> dict:
    if not path.exists():
        return {}
    if path.is_symlink():
        raise ValueError("the Hermes webhook subscription file must not be a symlink")
    try:
        subscriptions = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("the existing Hermes webhook subscriptions are invalid") from error
    if not isinstance(subscriptions, dict):
        raise ValueError("the existing Hermes webhook subscriptions must be an object")
    return subscriptions


def save_subscriptions(path: Path, subscriptions: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, text=True
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(subscriptions, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, path)
        os.chmod(path, 0o600)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def main() -> int:
    args = parse_args()
    if not 1024 <= args.port <= 65535:
        print("Error: webhook port must be between 1024 and 65535", file=sys.stderr)
        return 2
    try:
        routes = load_routes(args.routes_file)
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    set_config_value("platforms.webhook.enabled", "true")
    set_config_value("platforms.webhook.extra.host", LOOPBACK_HOST)
    set_config_value("platforms.webhook.extra.port", str(args.port))
    set_config_value("platforms.webhook.extra.rate_limit", "10")
    set_config_value("platforms.webhook.extra.max_body_bytes", "16384")

    subscriptions_path = get_hermes_home() / "webhook_subscriptions.json"
    subscriptions = load_subscriptions(subscriptions_path)
    subscriptions.update(routes)
    save_subscriptions(subscriptions_path, subscriptions)
    print("Configured Store Manager webhooks on 127.0.0.1.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
