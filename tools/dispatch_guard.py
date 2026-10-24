#!/usr/bin/env python3
"""Prevent near-simultaneous workflow_dispatch duplicates from doing work.

GitHub Actions concurrency prevents overlap but still permits sequential queued
runs. This preflight lets the oldest dispatch in a 120-second burst proceed and
makes later duplicates exit before build/report/Foreman steps.
"""
from __future__ import annotations
import json
import os
import sys
from datetime import datetime, timezone
from urllib.request import Request, urlopen

WINDOW_SECONDS = 120

def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None

def should_run(event_name: str, current_id: str, current_number: int,
               runs: list[dict], now: datetime | None = None) -> tuple[bool, str]:
    if event_name != "workflow_dispatch":
        return True, "scheduled/non-dispatch run"
    current = next((r for r in runs if str(r.get("id")) == str(current_id)), None)
    current_at = parse_time((current or {}).get("created_at")) or now or datetime.now(timezone.utc)
    for other in runs:
        try:
            number = int(other.get("run_number", 0))
        except (TypeError, ValueError):
            continue
        if number >= current_number or other.get("event") != "workflow_dispatch":
            continue
        created = parse_time(other.get("created_at"))
        if created is None:
            continue
        age = (current_at - created).total_seconds()
        if 0 <= age <= WINDOW_SECONDS:
            status = other.get("status")
            conclusion = other.get("conclusion")
            if status in ("queued", "in_progress") or (status == "completed" and conclusion == "success"):
                return False, f"older dispatch run #{number} is active or completed successfully within {WINDOW_SECONDS}s"
    return True, "oldest dispatch in its deduplication window"

def main() -> int:
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    current_id = os.environ.get("GITHUB_RUN_ID", "")
    try:
        current_number = int(os.environ.get("GITHUB_RUN_NUMBER", "0"))
    except ValueError:
        print("::error::missing or invalid GITHUB_RUN_NUMBER")
        return 1
    if event != "workflow_dispatch":
        print("run=true" if os.environ.get("GITHUB_OUTPUT") is None else "")
        out = os.environ.get("GITHUB_OUTPUT")
        if out:
            with open(out, "a", encoding="utf-8") as f:
                f.write("run=true\n")
        print("::notice::scheduled run allowed")
        return 0
    repo = os.environ.get("GITHUB_REPOSITORY", "ahmed10r/northbench-ops")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token or not current_id:
        print("::error::dispatch guard lacks GitHub token or run ID")
        return 1
    url = f"https://api.github.com/repos/{repo}/actions/workflows/foreman-loop.yml/runs?per_page=50"
    req = Request(url, headers={"Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json", "User-Agent": "northbench-dispatch-dedup/1.0"})
    try:
        with urlopen(req, timeout=20) as response:
            runs = json.loads(response.read().decode()).get("workflow_runs", [])
    except Exception as exc:
        print("::error::dispatch guard could not read workflow runs: " + type(exc).__name__)
        return 1
    allowed, reason = should_run(event, current_id, current_number, runs)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("run=" + ("true" if allowed else "false") + "\n")
    print("::notice::" + ("proceed: " if allowed else "skip duplicate: ") + reason)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
