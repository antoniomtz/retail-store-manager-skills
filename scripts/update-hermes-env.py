#!/usr/bin/env python3
"""Atomically update selected non-secret Hermes environment values."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import tempfile


ALLOWED_KEYS = {
    "HERMES_NEMO_RELAY_PLUGINS_TOML",
    "TELEGRAM_ALLOWED_USERS",
    "TELEGRAM_HOME_CHANNEL",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("env_file", type=Path)
    parser.add_argument("updates", nargs="+")
    args = parser.parse_args()

    updates: dict[str, str] = {}
    for item in args.updates:
        key, separator, value = item.partition("=")
        if not separator or key not in ALLOWED_KEYS or "\n" in value or "\r" in value:
            parser.error(f"unsupported environment update: {key or item}")
        updates[key] = value

    lines = args.env_file.read_text(encoding="utf-8").splitlines() if args.env_file.exists() else []
    rendered: list[str] = []
    seen: set[str] = set()
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line and not line.lstrip().startswith("#") else None
        if key in updates:
            rendered.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            rendered.append(line)
    for key, value in updates.items():
        if key not in seen:
            rendered.append(f"{key}={value}")

    args.env_file.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{args.env_file.name}.", dir=args.env_file.parent, text=True)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write("\n".join(rendered) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, args.env_file)
        os.chmod(args.env_file, 0o600)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
