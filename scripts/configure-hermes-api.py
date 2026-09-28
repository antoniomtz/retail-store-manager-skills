#!/usr/bin/env python3
"""Enable the loopback Hermes API server without exposing its bearer key."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import secrets
import tempfile


ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
API_KEY = re.compile(r"^[A-Za-z0-9._~+/=-]{32,512}$")


def assignment_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return value


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent, text=True
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("env_file", type=Path)
    parser.add_argument("key_file", type=Path)
    parser.add_argument("--port", type=int, default=8642)
    args = parser.parse_args()

    if not 1024 <= args.port <= 65535:
        parser.error("API server port must be between 1024 and 65535")
    if args.env_file.is_symlink() or args.key_file.is_symlink():
        parser.error("Hermes API state files must not be symbolic links")

    lines = (
        args.env_file.read_text(encoding="utf-8").splitlines()
        if args.env_file.exists()
        else []
    )
    existing_keys: list[str] = []
    for line in lines:
        match = ASSIGNMENT.match(line)
        if match and match.group(1) == "API_SERVER_KEY":
            existing_keys.append(assignment_value(match.group(2)))
    if len(existing_keys) > 1:
        parser.error("Hermes .env contains more than one API_SERVER_KEY")
    api_key = existing_keys[0] if existing_keys else secrets.token_hex(32)
    if not API_KEY.fullmatch(api_key):
        parser.error(
            "existing API_SERVER_KEY must contain 32-512 safe token characters"
        )

    updates = {
        "API_SERVER_ENABLED": "true",
        "API_SERVER_HOST": "127.0.0.1",
        "API_SERVER_PORT": str(args.port),
        "API_SERVER_KEY": api_key,
    }
    rendered: list[str] = []
    seen: set[str] = set()
    for line in lines:
        match = ASSIGNMENT.match(line)
        key = match.group(1) if match else None
        if key in updates:
            if key not in seen:
                rendered.append(f"{key}={updates[key]}")
                seen.add(key)
        else:
            rendered.append(line)
    for key, value in updates.items():
        if key not in seen:
            rendered.append(f"{key}={value}")

    atomic_write(args.env_file, "\n".join(rendered) + "\n")
    atomic_write(args.key_file, api_key + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
