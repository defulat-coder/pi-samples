#!/usr/bin/env python3
"""Recover readable source material from a local QoderWake Bun executable.

The script only reads process metadata and the selected executable. It never
starts, stops, patches, or sends requests to the daemon, and it never opens
the daemon's account or database files.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import struct
import subprocess
import sys
from collections import defaultdict
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit


LC_SEGMENT_64 = 0x19
MACHO_64_LE_MAGIC = 0xFEEDFACF
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
EXPECTED_BUN_HEADER = b"#!/usr/bin/env bun\n// @bun\n"

MODULE_MARKER = re.compile(
    rb"// (?P<path>(?:src/|packages/|\.\./packages/)[A-Za-z0-9_@+.,=/\-]+"
    rb"\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|html))\r?\n"
)
EMBEDDED_ASSET = re.compile(
    r'^\s+"(?P<path>(?:\\.|[^"\\])+)": \{ contentBase64: "(?P<data>[A-Za-z0-9+/=]+)" \},$',
    re.MULTILINE,
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run_capture(argv: list[str]) -> str:
    try:
        result = subprocess.run(argv, check=True, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise RuntimeError(f"required command is unavailable: {argv[0]}") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout).strip()
        raise RuntimeError(f"command failed: {' '.join(argv)}\n{detail}") from exc
    return result.stdout


def resolve_listener(port: int) -> dict[str, object]:
    output = run_capture(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fpctn"])
    pid: int | None = None
    command = ""
    for line in output.splitlines():
        if line.startswith("p") and line[1:].isdigit() and pid is None:
            pid = int(line[1:])
        elif line.startswith("c") and not command:
            command = line[1:]
    if pid is None:
        raise RuntimeError(f"no TCP listener found on loopback port {port}")
    return {
        "pid": pid,
        "command": command,
        "port": port,
        "process_command": run_capture(["ps", "-ww", "-p", str(pid), "-o", "command="]).strip(),
    }


def resolve_executable(pid: int) -> Path:
    output = run_capture(["lsof", "-nP", "-a", "-p", str(pid), "-d", "txt", "-Fn"])
    candidates = [Path(line[1:]) for line in output.splitlines() if line.startswith("n")]
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            header = candidate.open("rb").read(4)
        except OSError:
            continue
        if header == b"\xcf\xfa\xed\xfe":
            return candidate.resolve()
    raise RuntimeError(f"could not resolve a Mach-O executable for pid {pid}")


def parse_source_url(value: str) -> int:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in LOOPBACK_HOSTS:
        raise ValueError("--url must point to a loopback management URL")
    if parsed.port is None:
        raise ValueError("--url must include the daemon port")
    return parsed.port


def c_string(raw: bytes) -> str:
    return raw.split(b"\0", 1)[0].decode("ascii")


def find_bun_section(binary: bytes) -> tuple[int, int]:
    if len(binary) < 32:
        raise ValueError("file is too small to be a 64-bit Mach-O executable")
    magic, _, _, _, ncmds, _, _, _ = struct.unpack_from("<IIIIIIII", binary, 0)
    if magic != MACHO_64_LE_MAGIC:
        raise ValueError(f"unsupported Mach-O magic: 0x{magic:08x}")

    command_offset = 32
    for _ in range(ncmds):
        if command_offset + 8 > len(binary):
            raise ValueError("invalid Mach-O load command header")
        cmd, cmdsize = struct.unpack_from("<II", binary, command_offset)
        if cmdsize < 8 or command_offset + cmdsize > len(binary):
            raise ValueError("invalid Mach-O load command")
        if cmd == LC_SEGMENT_64:
            segment = struct.unpack_from("<II16sQQQQiiII", binary, command_offset)
            segname = c_string(segment[2])
            nsects = segment[9]
            section_offset = command_offset + 72
            for section_index in range(nsects):
                current = section_offset + section_index * 80
                if current + 80 > command_offset + cmdsize:
                    raise ValueError("invalid Mach-O section table")
                section = struct.unpack_from("<16s16sQQIIIIIIII", binary, current)
                sectname = c_string(section[0])
                section_segname = c_string(section[1])
                size = section[3]
                file_offset = section[4]
                if segname == "__BUN" and section_segname == "__BUN" and sectname == "__bun":
                    if file_offset + size > len(binary):
                        raise ValueError("__BUN/__bun section extends beyond the file")
                    return file_offset, size
        command_offset += cmdsize
    raise ValueError("Mach-O does not contain a __BUN/__bun section")


def is_first_party(path: str) -> bool:
    return path.startswith("src/") or bool(re.match(r"^(?:\.\./)?packages/[^/]+/src/", path))


def output_path_for(source_path: str) -> PurePosixPath:
    normalized = source_path[3:] if source_path.startswith("../") else source_path
    result = PurePosixPath(normalized)
    if result.is_absolute() or ".." in result.parts:
        raise ValueError(f"unsafe recovered path: {source_path}")
    return result


def clean_chunk(raw: bytes) -> str:
    raw = raw.split(b"\0", 1)[0]
    text = raw.decode("utf-8", errors="replace")
    return "".join(char for char in text if char in "\n\r\t" or ord(char) >= 32).rstrip()


def recover_embedded_assets(output_dir: Path) -> list[dict[str, object]]:
    source = output_dir / "src/daemon/embedded-assets.generated.ts"
    if not source.exists():
        return []
    assets_dir = output_dir / "web-assets"
    assets: list[dict[str, object]] = []
    for match in EMBEDDED_ASSET.finditer(source.read_text(encoding="utf-8")):
        asset_path = json.loads(f'"{match.group("path")}"')
        relative = PurePosixPath(asset_path.lstrip("/"))
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"unsafe embedded asset path: {asset_path}")
        content = base64.b64decode(match.group("data"), validate=True)
        destination = assets_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        assets.append(
            {
                "asset_path": asset_path,
                "output_path": str(destination.relative_to(output_dir)),
                "bytes": len(content),
                "sha256": sha256_bytes(content),
            }
        )
    return assets


def recover(binary_path: Path, output_dir: Path, process: dict[str, object]) -> dict[str, object]:
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RuntimeError(f"output directory is not empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    binary = binary_path.read_bytes()
    bun_offset, bun_size = find_bun_section(binary)
    bun_data = binary[bun_offset : bun_offset + bun_size]
    markers = list(MODULE_MARKER.finditer(bun_data))
    if not markers:
        raise ValueError("no Bun module markers found")

    recovered: dict[str, list[dict[str, object]]] = defaultdict(list)
    for index, marker in enumerate(markers):
        source_path = marker.group("path").decode("utf-8")
        if not is_first_party(source_path):
            continue
        next_start = markers[index + 1].start() if index + 1 < len(markers) else len(bun_data)
        raw_chunk = bun_data[marker.start() : next_start]
        text = clean_chunk(raw_chunk)
        if text:
            recovered[source_path].append(
                {
                    "absolute_offset": bun_offset + marker.start(),
                    "bundle_length": len(raw_chunk),
                    "text": text,
                    "text_sha256": sha256_bytes(text.encode("utf-8")),
                }
            )

    manifest_files: list[dict[str, object]] = []
    for source_path in sorted(recovered):
        destination = output_dir / output_path_for(source_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        chunks = recovered[source_path]
        rendered_parts = [
            "// RECOVERED FROM A BUN-COMPILED BINARY.",
            "// This is transpiled bundle output, not the original TypeScript source.",
            "",
        ]
        for chunk_index, chunk in enumerate(chunks, start=1):
            if chunk_index > 1:
                rendered_parts.extend(["", f"// ---- recovered bundle segment {chunk_index} ----", ""])
            rendered_parts.append(str(chunk["text"]))
        destination.write_text("\n".join(rendered_parts).rstrip() + "\n", encoding="utf-8")
        manifest_files.append(
            {
                "source_path": source_path,
                "output_path": str(destination.relative_to(output_dir)),
                "segments": [
                    {
                        "absolute_offset": chunk["absolute_offset"],
                        "bundle_length": chunk["bundle_length"],
                        "text_sha256": chunk["text_sha256"],
                    }
                    for chunk in chunks
                ],
                "output_bytes": destination.stat().st_size,
                "output_sha256": sha256_file(destination),
            }
        )

    embedded_assets = recover_embedded_assets(output_dir)
    payload_start = bun_data.rfind(b"\0", 0, markers[0].start()) + 1
    payload_end = bun_data.find(b"\0", markers[-1].end())
    if payload_end < 0:
        payload_end = len(bun_data)
    bundle = bun_data[payload_start:payload_end]
    bundle_path = output_dir / "runtime/qoderwake.bundle.js"
    bundle_path.parent.mkdir(parents=True, exist_ok=True)
    bundle_path.write_bytes(bundle)
    bundle_path.chmod(0o755)

    manifest = {
        "format": "qoderwake-bun-recovery-v1",
        "source_binary": str(binary_path),
        "source_binary_bytes": binary_path.stat().st_size,
        "source_binary_sha256": sha256_file(binary_path),
        "process": process,
        "bun_section": {"file_offset": bun_offset, "size": bun_size},
        "all_module_markers": len(markers),
        "first_party_files": len(manifest_files),
        "first_party_segments": sum(len(item["segments"]) for item in manifest_files),
        "recovered_output_bytes": sum(item["output_bytes"] for item in manifest_files),
        "bundle": {
            "output_path": str(bundle_path.relative_to(output_dir)),
            "bytes": len(bundle),
            "sha256": sha256_bytes(bundle),
            "header_ok": bundle.startswith(EXPECTED_BUN_HEADER),
        },
        "files": manifest_files,
        "embedded_assets": {
            "count": len(embedded_assets),
            "bytes": sum(item["bytes"] for item in embedded_assets),
            "files": embedded_assets,
        },
    }
    recovery_dir = output_dir / "_recovery"
    recovery_dir.mkdir()
    (recovery_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_report(output_dir, manifest)
    return manifest


def write_report(output_dir: Path, manifest: dict[str, object]) -> None:
    bundle = manifest["bundle"]
    assets = manifest["embedded_assets"]
    report = f"""# QoderWake 本机 Bun 源码恢复

本目录只读恢复自本机安装的 Bun/Mach-O 可执行文件。它是可读的转译后 bundle 源码，不是官方原始 TypeScript 仓库。

## 输入

- 可执行文件：`{manifest['source_binary']}`
- SHA-256：`{manifest['source_binary_sha256']}`
- 进程：`{manifest['process'].get('process_command', '')}`

## 结果

- Bun `__BUN/__bun` 段：偏移 `{manifest['bun_section']['file_offset']}`，大小 `{manifest['bun_section']['size']}` 字节
- bundle 模块标记：`{manifest['all_module_markers']}`
- 第一方文件：`{manifest['first_party_files']}`
- 第一方源码片段：`{manifest['first_party_segments']}`
- 第一方源码文本：`{manifest['recovered_output_bytes']}` 字节
- 嵌入 Web 资源：`{assets['count']}` 个，共 `{assets['bytes']}` 字节
- 完整 bundle：`{bundle['output_path']}`，`{bundle['bytes']}` 字节

## 边界

- 服务端源码是 Bun 转译后的可读文本；类型、原始 import/export、测试、Git 历史和完整构建配置不在恢复结果中。
- Web 目录是生产构建资源；是否存在 source map 需要以输出目录中的实际文件为准。
- 本脚本没有启动或停止 daemon，没有读取 `.auth`、SQLite 或其他业务运行数据。
"""
    (output_dir / "README.md").write_text(report, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Recover readable source from a local QoderWake Bun executable.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--url", help="loopback management URL, for example http://127.0.0.1:19820/management")
    source.add_argument("--binary", type=Path, help="local QoderWake executable")
    parser.add_argument("--output", type=Path, default=Path("qoderwake-recovered"), help="empty output directory")
    args = parser.parse_args()

    try:
        if args.url:
            port = parse_source_url(args.url)
            process = resolve_listener(port)
            binary_path = resolve_executable(int(process["pid"]))
        else:
            binary_path = args.binary.expanduser().resolve()
            if not binary_path.is_file():
                raise RuntimeError(f"binary does not exist: {binary_path}")
            process = {"pid": None, "command": "", "port": None, "process_command": ""}
        manifest = recover(binary_path, args.output.resolve(), process)
    except (OSError, RuntimeError, ValueError, struct.error) as exc:
        print(f"recovery failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps({
        "output": str(args.output.resolve()),
        "source_binary": str(binary_path),
        "first_party_files": manifest["first_party_files"],
        "first_party_segments": manifest["first_party_segments"],
        "embedded_assets": manifest["embedded_assets"]["count"],
        "bundle_bytes": manifest["bundle"]["bytes"],
        "bundle_header_ok": manifest["bundle"]["header_ok"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
