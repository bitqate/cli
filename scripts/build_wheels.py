import base64
import hashlib
import json
import re
import struct
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BIN_DIR = ROOT / "dist" / "bin"
OUT_DIR = ROOT / "dist" / "wheels"
NAME = "bitqate"
TARGETS = {
    "linux-x64": "x86_64",
    "linux-arm64": "aarch64",
    "darwin-x64": "x86_64",
    "darwin-arm64": "arm64",
    "windows-x64": "amd64",
}
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)
SHT_GNU_VERNEED = 0x6FFFFFFE
MACHO_64_MAGIC = 0xFEEDFACF
LC_BUILD_VERSION = 0x32


def exe_suffix(target: str) -> str:
    return ".exe" if target.startswith("windows") else ""


def glibc_minor(elf: bytes) -> int:
    if elf[:6] != b"\x7fELF\x02\x01":
        raise ValueError("expected a 64-bit little-endian ELF binary")
    (shoff,) = struct.unpack_from("<Q", elf, 0x28)
    shentsize, shnum = struct.unpack_from("<HH", elf, 0x3A)
    sections = [
        struct.unpack_from("<IIQQQQIIQQ", elf, shoff + i * shentsize)
        for i in range(shnum)
    ]
    best = 0
    for _, sh_type, _, _, offset, _, link, count, _, _ in sections:
        if sh_type != SHT_GNU_VERNEED:
            continue
        strtab = sections[link][4]
        need = offset
        for _ in range(count):
            _, aux_count, _, aux, next_need = struct.unpack_from("<HHIII", elf, need)
            entry = need + aux
            for _ in range(aux_count):
                _, _, _, name, next_aux = struct.unpack_from("<IHHII", elf, entry)
                start = strtab + name
                label = elf[start : elf.index(b"\0", start)]
                if m := re.fullmatch(rb"GLIBC_2\.(\d+)(?:\.\d+)?", label):
                    best = max(best, int(m[1]))
                entry += next_aux
            need += next_need
    if not best:
        raise ValueError("no GLIBC version requirements found")
    return best


def macos_minimum(macho: bytes) -> tuple[int, int]:
    magic, _, _, _, ncmds = struct.unpack_from("<IiiII", macho, 0)
    if magic != MACHO_64_MAGIC:
        raise ValueError("expected a 64-bit Mach-O binary")
    offset = 32
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", macho, offset)
        if cmd == LC_BUILD_VERSION:
            (minos,) = struct.unpack_from("<I", macho, offset + 12)
            return minos >> 16, (minos >> 8) & 0xFF
        offset += size
    raise ValueError("no LC_BUILD_VERSION load command found")


def platform_tag(target: str, binary: bytes) -> str:
    os_name, arch = target.split("-")[0], TARGETS[target]
    if os_name == "linux":
        return f"manylinux_2_{glibc_minor(binary)}_{arch}"
    if os_name == "darwin":
        major, minor = macos_minimum(binary)
        if major == 10:
            return f"macosx_10_{minor}_{arch}"
        return f"macosx_{major + (minor > 0)}_0_{arch}"
    return f"win_{arch}"


def record_line(path: str, data: bytes) -> str:
    digest = hashlib.sha256(data).digest()
    encoded = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return f"{path},sha256={encoded},{len(data)}\n"


def build_wheel(target: str, version: str, metadata: bytes, license_text: bytes) -> Path:
    ext = exe_suffix(target)
    binary = (BIN_DIR / f"{NAME}-{target}{ext}").read_bytes()
    tag = f"py3-none-{platform_tag(target, binary)}"
    dist_info = f"{NAME}-{version}.dist-info"
    files = {
        f"{NAME}-{version}.data/scripts/{NAME}{ext}": binary,
        f"{dist_info}/METADATA": metadata,
        f"{dist_info}/WHEEL": (
            "Wheel-Version: 1.0\n"
            "Generator: bitqate scripts/build_wheels.py\n"
            "Root-Is-Purelib: false\n"
            f"Tag: {tag}\n"
        ).encode(),
        f"{dist_info}/licenses/LICENSE": license_text,
    }
    record = f"{dist_info}/RECORD"
    files[record] = (
        "".join(record_line(p, d) for p, d in files.items()) + f"{record},,\n"
    ).encode()

    wheel = OUT_DIR / f"{NAME}-{version}-{tag}.whl"
    with zipfile.ZipFile(wheel, "w") as zf:
        for path, data in files.items():
            info = zipfile.ZipInfo(path, ZIP_EPOCH)
            info.create_system = 3
            mode = 0o755 if "/scripts/" in path else 0o644
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data, compresslevel=9)
    return wheel


def main() -> None:
    pkg = json.loads((ROOT / "package.json").read_text())
    version = pkg["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit(f"package.json version {version!r} is not plain X.Y.Z")
    missing = [
        t for t in TARGETS if not (BIN_DIR / f"{NAME}-{t}{exe_suffix(t)}").is_file()
    ]
    if missing:
        sys.exit(f"missing binaries for {', '.join(missing)}; run `bun run build:binaries`")

    repo = re.sub(r"^git\+|\.git$", "", pkg["repository"]["url"])
    metadata = (
        "Metadata-Version: 2.4\n"
        f"Name: {NAME}\n"
        f"Version: {version}\n"
        f"Summary: {pkg['description']}\n"
        f"License-Expression: {pkg['license']}\n"
        "License-File: LICENSE\n"
        f"Project-URL: Repository, {repo}\n"
        "Description-Content-Type: text/markdown\n"
        "\n" + (ROOT / "README.md").read_text()
    ).encode()
    license_text = (ROOT / "LICENSE").read_bytes()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in OUT_DIR.glob("*.whl"):
        stale.unlink()
    for target in TARGETS:
        wheel = build_wheel(target, version, metadata, license_text)
        print(f"{wheel.relative_to(ROOT)}  {wheel.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
