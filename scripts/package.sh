#!/usr/bin/env bash
# Build a distributable directory and tarball: dist/oicq-<ver>-linux-x86_64/
#
# A distribution package needs only three things: the compiled oicq.so, an install
# script, and a readme. The JS runtime is already embedded in the .so
# (resources_gen.cc), so runtime/ and plugins/ do not need to ship.

set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$PWD"
VER="$(grep -m1 'project(oicq VERSION' CMakeLists.txt | sed -E 's/.*VERSION ([0-9.]+).*/\1/')"
ARCH="$(uname -m)"
NAME="oicq-${VER}-linux-${ARCH}"
OUT="$ROOT/dist/$NAME"

[ -f build/oicq.so ] || { echo "build first: cmake --build build -j" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"
install -m 0755 build/oicq.so "$OUT/oicq.so"
# Keep only .dynsym (needed for dlopen/interception); drop debug and internal symbol tables
strip --strip-unneeded "$OUT/oicq.so"

cat > "$OUT/README.txt" <<EOF
oicq ${VER} — QQNT injection extension framework (Linux ${ARCH})

## What this is
An LD_PRELOAD library: it attaches to the QQ main process at startup, locates V8's
v8::ScriptCompiler::CompileFunction, and prepends a loader to the host boot script
source. Everything after that (config, plugins, UI) is plain JavaScript.
It also carries an "observation-surface consistency" layer: the /proc and
directory traces QQ reads about itself stay clean.

## Requirements
- Linux x86_64, glibc >= 2.34 (Ubuntu 22.04+ / Debian 12+)
- QQNT Linux 3.2.18-37012 (other versions require re-verifying anchors and symbols, see below)
- A single file: oicq.so (the JS runtime is embedded)

## Install
    ./install.sh                 # locate QQ, smoke test, write the desktop entry
    ./install.sh --qq /path/qq   # specify the QQ executable

## Verify
    grep -c oicq.so /proc/\$(pgrep -x qq | head -1)/maps
      -> from the outside this should be >0 (external reads cannot be blocked, this is expected)
    For the in-process view use:
    OICQ_LOG=debug LD_PRELOAD=\$PWD/oicq.so /path/to/qq
    The log should contain "hook active" / "anchor ... hit" / "injected" / "retired"

## What if it breaks after a QQ update
The default anchor is "boot script length 62 bytes". A version bump changes the
length and the match fails: you see "hook active" but no "anchor hit". Check the
"anchor ... (length/fingerprint)" lines with OICQ_LOG=debug, then override:

    OICQ_ANCHORS='name=boot,length=62,marker=require('

## Switches
    OICQ_SHIELD=0              disable the observation-surface consistency layer
    OICQ_SHIELD_HIDE=a.so:b.so extra module names to hide
    OICQ_DATA_DIR=<dir>        data root (default ~/.oicq)
    OICQ_LOG=error|warn|info|debug

## Known boundaries
- Inline syscall reads of /proc, and another process reading /proc/<pid>/maps: not intercepted.
- In-process spoofing covers libc exit points only; kernel audit (auditd/eBPF) does not see return values.
- x86_64 only; the macOS/Windows backends are in the source tree but not shipped in this package.
EOF

cat > "$OUT/install.sh" <<'EOF'
#!/usr/bin/env bash
# oicq installer: locate QQ, smoke test, write the desktop entry (the original file is backed up)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SO="$HERE/oicq.so"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP="$DESKTOP_DIR/qq.desktop"
QQ_BIN="${QQ_BIN:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --qq) QQ_BIN="${2:-}"; shift 2 ;;
    --help|-h) sed -n '2,6p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -f "$SO" ] || die "oicq.so missing (it must sit next to install.sh)"

# 1) Locate QQ
if [ -z "$QQ_BIN" ]; then
  QQ_BIN="$(command -v qq 2>/dev/null || true)"
fi
if [ -z "$QQ_BIN" ] && [ -f "$DESKTOP" ]; then
  QQ_BIN="$(sed -n 's/^Exec=.*[[:space:]]\(\/[^[:space:]]*qq\)[[:space:]]*%U.*/\1/p' "$DESKTOP" | head -1)"
fi
if [ -z "$QQ_BIN" ]; then
  for candidate in \
    "$HOME/cargo/bin/tencent/linuxqq/qq" \
    "$HOME/Applications/QQ/qq" \
    /opt/QQ/qq /opt/qq/qq /usr/bin/qq /usr/local/bin/qq; do
    [ -x "$candidate" ] && QQ_BIN="$candidate" && break
  done
fi
[ -n "$QQ_BIN" ] && [ -x "$QQ_BIN" ] || die "QQ not found, specify it with --qq /path/to/qq"
say "QQ: $QQ_BIN"

# 2) Smoke test: can the loader accept this .so
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! LD_PRELOAD="$SO" OICQ_DRY_RUN=1 OICQ_AUTOINIT=1 OICQ_DATA_DIR="$TMP" /bin/true 2>"$TMP/err"; then
  say "load failed:"
  sed 's/^/  /' "$TMP/err"
  say "  ldd output:"
  ldd "$SO" 2>&1 | sed 's/^/  /'
  die "this .so is incompatible with the current system (needs glibc >= 2.34, x86_64)"
fi
say "smoke test passed"

# 3) Desktop entry
mkdir -p "$DESKTOP_DIR"
if [ -f "$DESKTOP" ]; then
  BAK="$DESKTOP.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$DESKTOP" "$BAK"
  say "backed up: $BAK"
fi
cat > "$DESKTOP" <<DESKTOP_EOF
[Desktop Entry]
Type=Application
Name=QQ
Name[zh_CN]=linuxqq
GenericName=QQ
Comment=QQ (oicq injected)
Comment[zh_CN]=linuxqq
TryExec=$QQ_BIN
Exec=env LD_PRELOAD=$SO OICQ_SHIELD=1 $QQ_BIN %U
Icon=$QQ_BIN
Terminal=false
Categories=Network;InstantMessaging;
StartupWMClass=QQ
StartupNotify=true
DESKTOP_EOF
chmod 0644 "$DESKTOP"
say "written: $DESKTOP"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true

say ""
say "done. Launch QQ from the menu, or directly:"
say "  env LD_PRELOAD=$SO OICQ_SHIELD=1 $QQ_BIN"
say "logs: ~/.oicq/logs/runtime.log; troubleshooting: OICQ_LOG=debug"
EOF
chmod 0755 "$OUT/install.sh"

cat > "$OUT/uninstall.sh" <<'EOF'
#!/usr/bin/env bash
# restore the most recent backup of the desktop entry
set -euo pipefail
DESKTOP="$HOME/.local/share/applications/qq.desktop"
BAK="$(ls -1t "$DESKTOP".bak.* 2>/dev/null | head -1 || true)"
if [ -n "$BAK" ]; then cp "$BAK" "$DESKTOP"; echo "restored: $BAK"
else echo "no backup found, leaving things as they are"; fi
EOF
chmod 0755 "$OUT/uninstall.sh"

{
  echo "name: oicq"
  echo "version: $VER"
  echo "arch: $ARCH"
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "glibc_floor: 2.34"
  echo "target_qq: 3.2.18-37012"
  echo "sha256: $(sha256sum "$OUT/oicq.so" | cut -d' ' -f1)"
  echo "size: $(stat -c%s "$OUT/oicq.so")"
} > "$OUT/manifest.txt"

tar -C "$ROOT/dist" -czf "$ROOT/dist/$NAME.tar.gz" "$NAME"
( cd "$ROOT/dist" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )

echo "== $OUT =="
ls -la "$OUT"
echo
echo "== tarball =="
ls -la "$ROOT/dist/$NAME.tar.gz" "$ROOT/dist/$NAME.tar.gz.sha256"
