#!/usr/bin/env python3
"""Archive each new local QoderWake Bun binary as an immutable source snapshot."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
RECOVER_SCRIPT = SCRIPT_DIR / "recover_qoderwake.py"
spec = importlib.util.spec_from_file_location("qoderwake_recovery", RECOVER_SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load recovery engine: {RECOVER_SCRIPT}")
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def read_version(binary_path: Path) -> str:
    info_path = binary_path.parent / "run" / "daemon.info.json"
    try:
        payload = json.loads(info_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = None
    if isinstance(payload, dict):
        version = payload.get("version")
        if version:
            return str(version).strip()
    installed_version = binary_path.parent / ".installed-version"
    try:
        version = installed_version.read_text(encoding="utf-8").strip()
    except OSError:
        version = ""
    return version or "unknown"


def safe_version(value: str) -> str:
    value = value.strip() or "unknown"
    return "".join(char if char.isalnum() or char in ".-_" else "-" for char in value)


def load_index(archive_root: Path) -> dict[str, object]:
    index_path = archive_root / "index.json"
    if not index_path.exists():
        return {"format": "qoderwake-version-archive-v1", "snapshots": []}
    try:
        payload = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"invalid archive index: {index_path}") from exc
    if payload.get("format") != "qoderwake-version-archive-v1":
        raise RuntimeError(f"unsupported archive index format: {index_path}")
    if not isinstance(payload.get("snapshots"), list):
        raise RuntimeError(f"archive index snapshots must be a list: {index_path}")
    return payload


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def file_map(manifest: dict[str, object]) -> dict[str, str]:
    return {
        str(item["output_path"]): str(item["output_sha256"])
        for item in manifest.get("files", [])
        if isinstance(item, dict) and "output_path" in item and "output_sha256" in item
    }


def asset_map(manifest: dict[str, object]) -> dict[str, str]:
    assets = manifest.get("embedded_assets", {})
    if not isinstance(assets, dict):
        return {}
    return {
        str(item["output_path"]): str(item["sha256"])
        for item in assets.get("files", [])
        if isinstance(item, dict) and "output_path" in item and "sha256" in item
    }


def diff_manifests(previous: dict[str, object], current: dict[str, object]) -> dict[str, object]:
    previous_files = file_map(previous)
    current_files = file_map(current)
    previous_assets = asset_map(previous)
    current_assets = asset_map(current)

    def changes(old: dict[str, str], new: dict[str, str]) -> dict[str, list[str]]:
        old_paths = set(old)
        new_paths = set(new)
        return {
            "added": sorted(new_paths - old_paths),
            "removed": sorted(old_paths - new_paths),
            "changed": sorted(path for path in old_paths & new_paths if old[path] != new[path]),
        }

    previous_bundle = previous.get("bundle", {})
    current_bundle = current.get("bundle", {})
    previous_bundle_hash = previous_bundle.get("sha256") if isinstance(previous_bundle, dict) else None
    current_bundle_hash = current_bundle.get("sha256") if isinstance(current_bundle, dict) else None
    return {
        "source": changes(previous_files, current_files),
        "web_assets": changes(previous_assets, current_assets),
        "bundle_changed": previous_bundle_hash != current_bundle_hash,
        "previous_bundle_sha256": previous_bundle_hash,
        "current_bundle_sha256": current_bundle_hash,
        "previous_counts": {"source_files": len(previous_files), "web_assets": len(previous_assets)},
        "current_counts": {"source_files": len(current_files), "web_assets": len(current_assets)},
    }


def write_change_report(changes_dir: Path, current_id: str, previous_id: str, diff: dict[str, object]) -> Path:
    report_path = changes_dir / f"{current_id}-from-{previous_id}.md"
    source = diff["source"]
    assets = diff["web_assets"]
    asset_paths = sorted(set(assets["added"] + assets["removed"] + assets["changed"]))
    lines = [
        f"# QoderWake 版本变更：`{current_id}` ← `{previous_id}`",
        "",
        f"- 完整 bundle 是否变化：`{'是' if diff['bundle_changed'] else '否'}`",
        f"- 源码：新增 {len(source['added'])}，删除 {len(source['removed'])}，内容变化 {len(source['changed'])}",
        f"- Web 资源：新增 {len(assets['added'])}，删除 {len(assets['removed'])}，内容变化 {len(assets['changed'])}",
        "",
        "## 源码新增",
        "",
        *[f"- `{path}`" for path in source["added"]],
        "",
        "## 源码删除",
        "",
        *[f"- `{path}`" for path in source["removed"]],
        "",
        "## 源码内容变化",
        "",
        *[f"- `{path}`" for path in source["changed"]],
        "",
        "## Web 资源变化",
        "",
        *[f"- `{path}`" for path in asset_paths],
        "",
        "完整文件内容保存在两个不可覆盖的版本目录中；本报告只列路径和摘要。",
        "",
    ]
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines), encoding="utf-8")
    return report_path


def resolve_input(args: argparse.Namespace) -> tuple[Path, dict[str, object]]:
    if args.url:
        port = recovery.parse_source_url(args.url)
        process = recovery.resolve_listener(port)
        return recovery.resolve_executable(int(process["pid"])), process
    binary_path = args.binary.expanduser().resolve()
    if not binary_path.is_file():
        raise RuntimeError(f"binary does not exist: {binary_path}")
    return binary_path, {"pid": None, "command": "", "port": None, "process_command": ""}


def archive_one(binary_path: Path, process: dict[str, object], archive_root: Path) -> dict[str, object]:
    archive_root.mkdir(parents=True, exist_ok=True)
    index = load_index(archive_root)
    binary_hash = recovery.sha256_file(binary_path)
    version = read_version(binary_path)
    snapshot_id = f"{safe_version(version)}-{binary_hash[:12]}"

    for snapshot in index["snapshots"]:
        if isinstance(snapshot, dict) and snapshot.get("source_binary_sha256") == binary_hash:
            return {
                "status": "already_archived",
                "snapshot_id": snapshot.get("snapshot_id"),
                "archive_root": str(archive_root),
                "source_binary": str(binary_path),
            }

    snapshot_dir = archive_root / "versions" / snapshot_id
    if snapshot_dir.exists() and any(snapshot_dir.iterdir()):
        raise RuntimeError(f"snapshot directory exists but is not indexed: {snapshot_dir}")

    previous = index["snapshots"][-1] if index["snapshots"] else None
    previous_manifest = None
    if isinstance(previous, dict):
        previous_dir = archive_root / "versions" / str(previous["snapshot_id"])
        previous_manifest_path = previous_dir / "_recovery/manifest.json"
        if not previous_manifest_path.is_file():
            raise RuntimeError(f"previous snapshot manifest is missing: {previous_manifest_path}")
        previous_manifest = json.loads(previous_manifest_path.read_text(encoding="utf-8"))

    manifest = recovery.recover(binary_path, snapshot_dir, process)
    manifest["version"] = version
    manifest["snapshot_id"] = snapshot_id
    write_json(snapshot_dir / "_recovery/manifest.json", manifest)

    change_report = None
    diff = None
    if isinstance(previous, dict) and isinstance(previous_manifest, dict):
        diff = diff_manifests(previous_manifest, manifest)
        change_report = write_change_report(archive_root / "changes", snapshot_id, str(previous["snapshot_id"]), diff)

    snapshot_record = {
        "snapshot_id": snapshot_id,
        "version": version,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "source_binary": str(binary_path),
        "source_binary_sha256": binary_hash,
        "source_binary_bytes": binary_path.stat().st_size,
        "snapshot_path": str(snapshot_dir.relative_to(archive_root)),
        "previous_snapshot_id": previous.get("snapshot_id") if isinstance(previous, dict) else None,
        "change_report": str(change_report.relative_to(archive_root)) if change_report else None,
        "first_party_files": manifest["first_party_files"],
        "first_party_segments": manifest["first_party_segments"],
        "embedded_assets": manifest["embedded_assets"]["count"],
        "bundle_bytes": manifest["bundle"]["bytes"],
    }
    index["snapshots"].append(snapshot_record)
    write_json(archive_root / "index.json", index)

    return {"status": "archived", "snapshot": snapshot_record, "diff": diff, "archive_root": str(archive_root)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Archive every new local QoderWake Bun version.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--url", help="loopback management URL")
    source.add_argument("--binary", type=Path, help="local QoderWake executable")
    parser.add_argument("--archive", type=Path, default=Path("qoderwake-source-archive"), help="version archive root")
    args = parser.parse_args()

    try:
        binary_path, process = resolve_input(args)
        result = archive_one(binary_path, process, args.archive.resolve())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, TypeError) as exc:
        print(f"version archive failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
