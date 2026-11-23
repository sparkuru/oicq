#!/usr/bin/env bash
# checksec.sh - audit the forged observation surface of the Linux build.
#
# Static side: interposer set, export surface, embedded shield markers.
# Runtime side: run a probe under LD_PRELOAD and compare what the target sees
# through libc against what the kernel actually reports through raw syscalls.
set -Eeuo pipefail

SCRIPT_NAME=$(basename "$0")
readonly SCRIPT_NAME
readonly DEFAULT_SO="build/oicq.so"

readonly STYLE_RESET=$'\033[0m'
readonly STYLE_TITLE=$'\033[1;36m'
readonly STYLE_SUCCESS=$'\033[0;32m'
readonly STYLE_WARNING=$'\033[1;33m'
readonly STYLE_ERROR=$'\033[1;31m'
readonly STYLE_EXAMPLE=$'\033[0;37m'

passed=0
failed=0
warned=0
no_runtime=false
so_path=""
tmp_dir=""
private_dir=""

color_text() {
    local style=$1
    local text=$2

    if [[ -n "${NO_COLOR:-}" || ! -t 1 ]]; then
        printf '%s' "$text"
        return 0
    fi

    printf '%s%s%s' "$style" "$text" "$STYLE_RESET"
}

section() {
    printf '\n%s\n' "$(color_text "$STYLE_TITLE" "== $* ==")"
}

note() {
    printf '%s %s\n' "$(color_text "$STYLE_EXAMPLE" '[--]')" "$*"
}

pass() {
    passed=$((passed + 1))
    printf '%s %s\n' "$(color_text "$STYLE_SUCCESS" '[ok]')" "$*"
}

warn() {
    warned=$((warned + 1))
    printf '%s %s\n' "$(color_text "$STYLE_WARNING" '[??]')" "$*" >&2
}

fail() {
    failed=$((failed + 1))
    printf '%s %s\n' "$(color_text "$STYLE_ERROR" '[!!]')" "$*" >&2
}

usage() {
    printf 'Usage: %s [--no-runtime] [SO_PATH]\n' "$SCRIPT_NAME" >&2
    printf '\n' >&2
    printf 'Checks the forged (forge) observation surface of a built oicq.so.\n' >&2
    printf '\n' >&2
    printf 'Options:\n' >&2
    printf '  --no-runtime   static checks only, do not preload the library\n' >&2
    printf '  -h, --help     show this help\n' >&2
    printf '\n' >&2
    printf 'Default SO_PATH: %s\n' "$DEFAULT_SO" >&2
}

die() {
    printf '%s %s\n' "$(color_text "$STYLE_ERROR" 'Error:')" "$*" >&2
    exit 2
}

cleanup() {
    local dir

    for dir in "${tmp_dir:-}" "${private_dir:-}"; do
        if [[ -n "$dir" && -d "$dir" && "$dir" == /tmp/* ]]; then
            rm -rf -- "$dir"
        fi
    done
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

symbol_defined() {
    printf '%s\n' "${symbols[@]}" | grep -qxF -- "$1"
}

check_artifact() {
    local machine
    local size
    local digest

    section "artifact"
    size=$(stat -c %s -- "$so_path")
    digest=$(sha256sum -- "$so_path")
    digest=${digest%% *}
    machine=$(LC_ALL=C readelf -h "$so_path" | awk -F: '/Machine:/ {gsub(/^ +/, "", $2); print $2}')

    note "path    $so_path"
    note "size    $size"
    note "sha256  $digest"
    note "machine $machine"

    if [[ "$machine" == *X86-64* ]]; then
        pass "x86-64 ELF"
    else
        fail "unexpected machine: ${machine:-unknown}"
    fi
}

check_interposers() {
    local -a required=(
        open open64 openat openat64 openat2 fopen freopen
        stat lstat fstatat statx access faccessat
        opendir readdir readdir64 scandir scandir64
        readlink readlinkat dl_iterate_phdr dlopen getenv secure_getenv
    )
    local -a forbidden=(dlsym unsetenv clearenv)
    local name
    local count=0
    local missing=0

    section "interposition"

    for name in "${required[@]}"; do
        if symbol_defined "$name"; then
            count=$((count + 1))
        else
            missing=$((missing + 1))
            fail "missing interposer: $name"
        fi
    done

    if ((missing == 0)); then
        pass "shield interposers present: $count/${#required[@]}"
    else
        note "partial interposer set: $count/${#required[@]}"
    fi

    for name in "${forbidden[@]}"; do
        if symbol_defined "$name"; then
            fail "forbidden interposer present: $name"
        else
            pass "not interposing $name"
        fi
    done

    local -a exposed=()
    for name in init performHook OicqCompileFunctionHook _Z4initv _Z11performHookv; do
        if symbol_defined "$name"; then
            exposed+=("$name")
        fi
    done
    if ((${#exposed[@]} > 0)); then
        warn "loader probe surface exposed: ${exposed[*]} (build with -DOICQ_STEALTH_EXPORTS=ON to hide)"
    else
        pass "stealth exports: entry points hidden"
    fi
}

check_markers() {
    local -a markers=(OICQ_SHIELD OICQ_SHIELD_HIDE procview /proc/self/fd/ thread-self smaps_rollup numa_maps /tmp/oicq qq.desktop)
    local found=0
    local marker
    local blob

    section "embedded shield markers"
    blob=$(strings -a -- "$so_path")

    for marker in "${markers[@]}"; do
        if grep -qF -- "$marker" <<<"$blob"; then
            found=$((found + 1))
        else
            fail "marker missing: $marker"
        fi
    done

    if ((found == ${#markers[@]})); then
        pass "forge markers present: $found/${#markers[@]}"
    else
        note "partial marker set: $found/${#markers[@]}"
    fi
}

write_probe() {
    cat >"$tmp_dir/probe.c" <<'PROBE_EOF'
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <link.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static char *read_stream(FILE *f, size_t *out_len) {
    size_t cap = 65536;
    size_t len = 0;
    char *buf = malloc(cap + 1);
    if (buf == NULL) return NULL;
    for (;;) {
        if (len == cap) {
            cap *= 2;
            char *grown = realloc(buf, cap + 1);
            if (grown == NULL) { free(buf); return NULL; }
            buf = grown;
        }
        size_t n = fread(buf + len, 1, cap - len, f);
        len += n;
        if (n == 0) break;
    }
    buf[len] = '\0';
    *out_len = len;
    return buf;
}

static char *read_libc(const char *path, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (f == NULL) return NULL;
    char *buf = read_stream(f, out_len);
    fclose(f);
    return buf;
}

static char *read_raw(const char *path, size_t *out_len) {
    int fd = (int)syscall(SYS_openat, AT_FDCWD, path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return NULL;
    size_t cap = 65536;
    size_t len = 0;
    char *buf = malloc(cap + 1);
    if (buf == NULL) { syscall(SYS_close, fd); return NULL; }
    for (;;) {
        if (len == cap) {
            cap *= 2;
            char *grown = realloc(buf, cap + 1);
            if (grown == NULL) { free(buf); syscall(SYS_close, fd); return NULL; }
            buf = grown;
        }
        ssize_t n = syscall(SYS_read, fd, buf + len, cap - len);
        if (n <= 0) break;
        len += (size_t)n;
    }
    syscall(SYS_close, fd);
    buf[len] = '\0';
    *out_len = len;
    return buf;
}

static int count_token(const char *buf, size_t len, const char *token) {
    int hits = 0;
    size_t token_len = strlen(token);
    if (buf == NULL || token_len == 0 || len < token_len) return 0;
    for (size_t i = 0; i + token_len <= len; ++i) {
        if (memcmp(buf + i, token, token_len) == 0) hits++;
    }
    return hits;
}

struct phdr_scan {
    const char *token;
    int hits;
};

static int scan_phdr(struct dl_phdr_info *info, size_t size, void *data) {
    struct phdr_scan *scan = data;
    (void)size;
    if (info->dlpi_name != NULL && strstr(info->dlpi_name, scan->token) != NULL) scan->hits++;
    return 0;
}

static int stat_raw(const char *path) {
    struct stat st;
    int rc = (int)syscall(SYS_newfstatat, AT_FDCWD, path, &st, 0);
    return rc == 0 ? 0 : errno;
}

int main(int argc, char **argv) {
    const char *private_path;
    const char *token;
    size_t len = 0;
    char *buf;
    const char *preload;
    struct phdr_scan scan;
    struct stat st;
    int rc;

    if (argc < 3) {
        fprintf(stderr, "usage: probe <private-path> <module-token>\n");
        return 2;
    }
    private_path = argv[1];
    token = argv[2];

    buf = read_libc("/proc/self/maps", &len);
    printf("libc.maps.hits=%d\n", count_token(buf, len, token));
    free(buf);

    buf = read_raw("/proc/self/maps", &len);
    printf("raw.maps.hits=%d\n", count_token(buf, len, token));
    free(buf);

    buf = read_libc("/proc/self/environ", &len);
    printf("libc.environ.preload=%s\n", count_token(buf, len, "LD_PRELOAD") > 0 ? "present" : "hidden");
    free(buf);

    buf = read_raw("/proc/self/environ", &len);
    printf("raw.environ.preload=%s\n", count_token(buf, len, "LD_PRELOAD") > 0 ? "present" : "hidden");
    free(buf);

    preload = getenv("LD_PRELOAD");
    printf("libc.getenv.preload=%s\n", (preload != NULL && preload[0] != '\0') ? "present" : "hidden");

    scan.token = token;
    scan.hits = 0;
    dl_iterate_phdr(scan_phdr, &scan);
    printf("libc.phdr.hits=%d\n", scan.hits);

    rc = stat(private_path, &st);
    printf("libc.stat.private=%d\n", rc == 0 ? 0 : errno);
    printf("raw.stat.private=%d\n", stat_raw(private_path));

    int visible = 0;
    DIR *dir = opendir("/tmp");
    if (dir != NULL) {
        struct dirent *entry;
        while ((entry = readdir(dir)) != NULL) {
            if (strcmp(entry->d_name, "oicq") == 0 ||
                strncmp(entry->d_name, "oicq-probe", 10) == 0) visible++;
        }
        closedir(dir);
    }
    printf("libc.readdir.oicq=%d\n", visible);
    return 0;
}
PROBE_EOF

    cc -O0 -fno-builtin -Wall -Wextra -o "$tmp_dir/probe" "$tmp_dir/probe.c"
}

probe_value() {
    awk -F= -v key="$1" '$1 == key { print $2; exit }' <<<"$probe_out"
}

expect_eq() {
    local key=$1
    local want=$2
    local got

    got=$(probe_value "$key")
    if [[ "$got" == "$want" ]]; then
        pass "$key=$got"
    else
        fail "$key=$got (want $want)"
    fi
}

expect_not_eq() {
    local key=$1
    local unwanted=$2
    local got

    got=$(probe_value "$key")
    if [[ -n "$got" && "$got" != "$unwanted" ]]; then
        pass "$key=$got"
    else
        fail "$key=${got:-missing} (want != $unwanted)"
    fi
}

expect_min() {
    local key=$1
    local min=$2
    local got

    got=$(probe_value "$key")
    if [[ "$got" =~ ^[0-9]+$ ]] && ((got >= min)); then
        pass "$key=$got"
    else
        fail "$key=${got:-missing} (want >= $min)"
    fi
}

check_runtime() {
    local needle

    section "runtime: libc view vs raw syscall view"

    if ! command -v cc >/dev/null 2>&1; then
        warn "cc not found; runtime checks skipped"
        return 0
    fi

    private_dir=$(mktemp -d /tmp/oicq-probe.XXXXXXXX) || {
        fail "cannot create /tmp/oicq-probe.XXXX"
        return 0
    }
    write_probe || {
        fail "probe compilation failed"
        return 0
    }

    needle=$(basename -- "$so_path")
    probe_out=$(env -u OICQ_SHIELD -u OICQ_SHIELD_HIDE OICQ_AUTOINIT=0 OICQ_LOG=error \
        LD_PRELOAD="$so_path" "$tmp_dir/probe" "$private_dir" "$needle" 2>&1) || {
        fail "probe run failed: $probe_out"
        return 0
    }

    expect_eq libc.getenv.preload hidden
    expect_eq libc.environ.preload hidden
    expect_eq raw.environ.preload present
    expect_eq libc.maps.hits 0
    expect_min raw.maps.hits 1
    expect_eq libc.phdr.hits 0
    expect_not_eq libc.stat.private 0
    expect_eq raw.stat.private 0
    expect_eq libc.readdir.oicq 0
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
        --no-runtime)
            no_runtime=true
            shift
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        --)
            shift
            break
            ;;
        -*)
            usage
            die "unknown option: $1"
            ;;
        *)
            if [[ -n "$so_path" ]]; then
                usage
                die "only one SO_PATH may be given"
            fi
            so_path=$1
            shift
            ;;
        esac
    done

    if [[ $# -gt 0 ]]; then
        so_path=${1}
    fi
    if [[ -z "$so_path" ]]; then
        so_path=$DEFAULT_SO
    fi
}

main() {
    parse_args "$@"

    require_command nm
    require_command readelf
    require_command strings
    require_command sha256sum

    [[ -f "$so_path" ]] || die "no such shared object: $so_path (build with: cmake --build build -j)"
    so_path=$(readlink -f -- "$so_path")
    tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/oicq-checksec.XXXXXXXX") || die "cannot create temporary workspace"

    mapfile -t symbols < <(nm -D --defined-only --format=posix -- "$so_path" 2>/dev/null | awk '{print $1}')

    check_artifact
    check_interposers
    check_markers

    if [[ "$no_runtime" == true ]]; then
        warn "runtime checks skipped (--no-runtime); forge verdict is static only"
    else
        check_runtime
    fi

    section "verdict"
    if ((failed == 0)); then
        printf '%s forge build: PASS (passed=%d, warnings=%d)\n' \
            "$(color_text "$STYLE_SUCCESS" '[ok]')" "$passed" "$warned"
        return 0
    fi

    printf '%s forge build: FAIL (passed=%d, failed=%d, warnings=%d)\n' \
        "$(color_text "$STYLE_ERROR" '[!!]')" "$passed" "$failed" "$warned"
    return 1
}

trap cleanup EXIT

main "$@"
