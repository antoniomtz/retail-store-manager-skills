#!/usr/bin/env python3
"""Deliver one explicitly requested morning briefing to configured Telegram."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import sys


DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.json"
EXPECTED_REPORT = Path("/tmp/store-manager-morning-briefing-telegram.md")
HERMES_HOME = Path("__HERMES_HOME__")
MAX_REPORT_BYTES = 32_768
TELEGRAM_USER_ID = re.compile(r"^[1-9][0-9]{4,19}$")
MARKDOWN_TABLE = re.compile(r"(?m)^\|(?:\s*:?-+:?\s*\|){2,}\s*$")
DELIVERY_DIRECTIVE = re.compile(
    r"(?:MEDIA:|\[\[as_document\]\]|<[A-Za-z/][^>]*>)",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send one rendered morning briefing to configured Telegram."
    )
    parser.add_argument("--report-file", type=Path, required=True)
    return parser.parse_args()


def configured_recipient(config_path: Path = DEFAULT_CONFIG) -> str:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("the installed Store Manager delivery configuration is invalid") from error

    recipient = config.get("telegram_chat_id") if isinstance(config, dict) else None
    if not isinstance(recipient, str) or not TELEGRAM_USER_ID.fullmatch(recipient):
        raise ValueError("the installed Telegram recipient is unavailable")
    return recipient


def read_report(report_path: Path) -> str:
    if report_path != EXPECTED_REPORT or report_path.is_symlink():
        raise ValueError("the report must use the managed temporary path")
    try:
        payload = report_path.read_bytes()
    except OSError as error:
        raise ValueError("the rendered Telegram report is unavailable") from error
    if not payload or len(payload) > MAX_REPORT_BYTES or b"\x00" in payload:
        raise ValueError("the rendered Telegram report is invalid")
    try:
        report = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("the rendered Telegram report must be UTF-8 text") from error
    if not report.strip():
        raise ValueError("the rendered Telegram report is empty")
    if not MARKDOWN_TABLE.search(report):
        raise ValueError("the rendered Telegram report is not the rich template")
    if DELIVERY_DIRECTIVE.search(report):
        raise ValueError("the rendered Telegram report contains an unsupported directive")
    return report


def telegram_runtime() -> tuple[str, str | None]:
    os.environ["HERMES_HOME"] = str(HERMES_HOME)
    try:
        from hermes_cli.send_cmd import _load_hermes_env

        _load_hermes_env()
        from gateway.config import load_gateway_config, Platform

        runtime = load_gateway_config()
        telegram = runtime.platforms.get(Platform.TELEGRAM)
    except Exception as error:
        raise RuntimeError("Hermes Telegram configuration is unavailable") from error

    if not telegram or not telegram.enabled or not telegram.token:
        raise RuntimeError("Hermes Telegram is not configured")
    extra = telegram.extra if isinstance(telegram.extra, dict) else {}
    rich_enabled = str(extra.get("rich_messages", "")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if not rich_enabled:
        raise RuntimeError("Hermes Telegram rich messages are not enabled")

    try:
        from gateway.platforms.base import resolve_proxy_url

        proxy = resolve_proxy_url("TELEGRAM_PROXY", target_hosts=["api.telegram.org"])
    except Exception:
        proxy = None
    return str(telegram.token), proxy


async def deliver_rich(report: str, recipient: str, token: str, proxy: str | None) -> None:
    try:
        from telegram import Bot
        from telegram.request import HTTPXRequest
        from plugins.platforms.telegram.adapter import _rich_normalize_linebreaks
        from plugins.platforms.telegram.telegram_ids import normalize_telegram_chat_id
    except ImportError as error:
        raise RuntimeError("Hermes Telegram rich messaging is unavailable") from error

    request = HTTPXRequest(proxy=proxy) if proxy else HTTPXRequest()
    bot = Bot(token=token, request=request)
    payload = {
        "chat_id": normalize_telegram_chat_id(recipient),
        "rich_message": {"markdown": _rich_normalize_linebreaks(report)},
    }
    try:
        async with bot:
            result = await bot.do_api_request(
                "sendRichMessage",
                api_kwargs=payload,
                connect_timeout=10,
                read_timeout=30,
                write_timeout=30,
                pool_timeout=5,
            )
    except Exception as error:
        raise RuntimeError("Telegram rejected the rich morning briefing") from error
    if not result:
        raise RuntimeError("Telegram did not confirm rich morning briefing delivery")


def deliver(report: str, recipient: str) -> None:
    token, proxy = telegram_runtime()
    asyncio.run(deliver_rich(report, recipient, token, proxy))


def main() -> int:
    args = parse_args()
    try:
        recipient = configured_recipient()
        report = read_report(args.report_file)
        deliver(report, recipient)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Morning briefing delivery failed: {error}", file=sys.stderr)
        return 1
    finally:
        if args.report_file == EXPECTED_REPORT and not args.report_file.is_symlink():
            args.report_file.unlink(missing_ok=True)

    print("Telegram morning briefing delivered.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
