#!/usr/bin/env python3
import argparse
import json
import os
import tempfile
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args()

    if not args.watch and not args.once and not args.cleanup:
        parser.error("expected --watch, --once, or --cleanup")

    if args.watch:
        while True:
            sync_once()
            time.sleep(0.2)

    if args.once:
        sync_once()
    if args.cleanup:
        cleanup_secret_copies()
    return 0


def sync_once() -> None:
    source = latest_harness_auth()
    if source is None:
        return

    source_auth = read_codex_auth(source)
    if source_auth is None:
        return

    target = target_auth_path()
    target_auth = read_codex_auth(target)
    if target_auth == source_auth:
        return

    write_auth(target, source_auth)
    print("Synced refreshed Pi Codex auth from harness run config")


def latest_harness_auth() -> Path | None:
    root = Path(os.environ.get("PI_HARNESS_AUTH_ROOT", ".harness-evals"))
    candidates = [path for path in root.glob("runs/**/config/auth.json") if path.is_file()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime_ns)


def cleanup_secret_copies() -> None:
    root = Path(os.environ.get("PI_HARNESS_AUTH_ROOT", ".harness-evals"))
    for name in ("auth.json", "models.json", "model-tiers.json"):
        for path in root.glob(f"runs/**/config/{name}"):
            try:
                path.unlink()
            except FileNotFoundError:
                pass


def target_auth_path() -> Path:
    configured = os.environ.get("PI_AGENT_AUTH_FILE")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".pi" / "agent" / "auth.json"


def read_codex_auth(path: Path) -> str | None:
    try:
        data = json.loads(path.read_text())
    except Exception:
        return None

    if not isinstance(data, dict) or set(data.keys()) != {"openai-codex"}:
        return None

    codex = data.get("openai-codex")
    if not isinstance(codex, dict):
        return None
    if codex.get("type") != "oauth":
        return None
    if not isinstance(codex.get("access"), str) or not codex["access"]:
        return None
    if not isinstance(codex.get("refresh"), str) or not codex["refresh"]:
        return None

    return json.dumps(data, sort_keys=True, separators=(",", ":"))


def write_auth(path: Path, normalized_auth: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pretty_auth = json.dumps(json.loads(normalized_auth), indent=2) + "\n"

    fd, temp_path = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(pretty_auth)
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, path)
    finally:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
