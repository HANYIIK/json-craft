import argparse
from pathlib import Path
import plistlib
import re
import subprocess
import sys

MACHO_MAGICS = {
    bytes.fromhex(value)
    for value in ("feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca")
}


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+(?:\.\d+){0,2}", value):
        raise ValueError(f"Invalid macOS version: {value!r}")
    parts = tuple(map(int, value.split(".")))
    return parts + (0,) * (3 - len(parts))


def run_tool(arguments):
    return subprocess.run(arguments, check=True, capture_output=True, text=True, timeout=60).stdout


def minimum_versions(output):
    architectures = set()
    versions = []
    architecture = "native"
    command = None
    for line in output.splitlines():
        match = re.search(r"\(architecture ([^)]+)\):$", line)
        if match:
            architecture = match.group(1)
            architectures.add(architecture)
            command = None
        fields = line.split()
        if len(fields) != 2:
            continue
        key, value = fields
        if key == "cmd":
            command = value
        elif (command == "LC_BUILD_VERSION" and key == "minos") or (command == "LC_VERSION_MIN_MACOSX" and key == "version"):
            version_tuple(value)
            versions.append((architecture, value))
    missing = (architectures or {"native"}) - {architecture for architecture, _ in versions}
    if missing:
        raise ValueError(f"Missing macOS deployment targets: {', '.join(sorted(missing))}")
    return versions


def check_app(app, expected_architecture):
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if info["CFBundleIdentifier"] != "dev.jsoncraft.desktop":
        raise ValueError("Unexpected app bundle identifier")
    minimum = info["LSMinimumSystemVersion"]
    declared = version_tuple(minimum)
    expected = "x86_64" if expected_architecture == "x64" else "arm64"
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True, timeout=120)
    count = 0
    seen = set()
    for candidate in sorted(app.rglob("*")):
        if not candidate.is_file():
            continue
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        with resolved.open("rb") as stream:
            if stream.read(4) not in MACHO_MAGICS:
                continue
        if "Mach-O" not in run_tool(["file", "-b", str(resolved)]):
            continue
        count += 1
        architectures = run_tool(["lipo", "-archs", str(resolved)]).split()
        if expected not in architectures:
            raise ValueError(f"{candidate.relative_to(app)} does not support {expected}")
        for architecture, required in minimum_versions(run_tool(["otool", "-l", str(resolved)])):
            if version_tuple(required) > declared:
                raise ValueError(f"{candidate.relative_to(app)} ({architecture}) requires macOS {required}, app declares {minimum}")
    if not count:
        raise ValueError("No Mach-O binaries found")
    print(f"Verified {count} Mach-O files, {expected} architecture, macOS {minimum} minimum, and code-signing seal.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("app", type=Path)
    parser.add_argument("architecture", choices=["x64", "arm64"])
    arguments = parser.parse_args()
    try:
        check_app(arguments.app.resolve(), arguments.architecture)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"macOS app validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
