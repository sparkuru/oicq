#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_NAME=${0##*/}
readonly BASE_IMAGE=ubuntu:22.04
readonly BUILD_IMAGE=oicq-release:ubuntu-22.04
readonly GLIBC_FLOOR=2.34
readonly TARGET_ARCH=x86_64
readonly TESTED_QQ='3.2.18-37012 and 3.2.35-54395'

release_version=
tag=
branch=
repo_root=
repo_url=
project_version=
released_version=
work_dir=
output_dir=
archive_name=
files_changed=false
files_staged=false
committed=false
output_created=false

usage() {
    cat <<EOF
Usage: $SCRIPT_NAME [--version VERSION] [--repo-url URL]

Without --version, print the latest released tag, the in-tree version, and an example release command.

With --version VERSION (three numeric components, such as 0.9.1), create a local oicq release:
  1. bump the version in CMakeLists.txt and runtime/main.js;
  2. run the host test suite (native harnesses plus the Node.js runtime tests);
  3. rebuild and retest inside $BASE_IMAGE so the shipped .so only needs glibc >= $GLIBC_FLOOR;
  4. write dist/VERSION with oicq/{oicq.so,install.sh,readme.txt}, a tarball, SHA-256 files and release notes,
     and point dist/current at it;
  5. commit the version change, create an annotated tag, and print the GitHub release page fields. It does not push.

--repo-url overrides the GitHub URL derived from the origin remote.
EOF
}

die() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

note() {
    printf '[--] %s\n' "$*"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

cleanup() {
    local status=$?

    if [[ $status -ne 0 && $committed == false ]]; then
        if [[ $files_staged == true ]]; then
            git -C "$repo_root" restore --staged -- release.sh install.sh CMakeLists.txt runtime/main.js 2>/dev/null || true
        fi
        if [[ $files_changed == true ]]; then
            cp -- "$work_dir/CMakeLists.txt" "$repo_root/CMakeLists.txt"
            cp -- "$work_dir/main.js" "$repo_root/runtime/main.js"
        fi
        if [[ $output_created == true && -d $output_dir ]]; then
            rm -r -- "$output_dir"
        fi
    fi
    if [[ -n $work_dir && -d $work_dir ]]; then
        rm -r -- "$work_dir"
    fi
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
        --version)
            [[ $# -ge 2 && -z $release_version ]] || die 'use --version once with a value'
            release_version=$2
            shift 2
            ;;
        --repo-url)
            [[ $# -ge 2 && -z $repo_url ]] || die 'use --repo-url once with a value'
            repo_url=${2%/}
            shift 2
            ;;
        --help | -h)
            usage
            exit 0
            ;;
        *)
            die "unknown argument: $1"
            ;;
        esac
    done

    if [[ -n $release_version ]]; then
        [[ $release_version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
            die 'version must look like 0.9.1 or 1.0.0'
        tag=$release_version
    fi
}

check_environment() {
    local machine

    machine=$(uname -m)
    [[ $machine == x86_64 ]] || die "release builds are x86_64 only (host is $machine)"
}

resolve_repo_root() {
    if [[ -z $repo_root ]]; then
        repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
    fi
    [[ $(git -C "$repo_root" rev-parse --show-toplevel) == "$repo_root" ]] ||
        die 'release.sh must be at the Git repository root'
}

detect_versions() {
    resolve_repo_root

    project_version=$(sed -nE \
        's/^project\(oicq VERSION ([0-9]+\.[0-9]+\.[0-9]+) LANGUAGES CXX\)$/\1/p' \
        "$repo_root/CMakeLists.txt" | head -n 1)
    [[ -n $project_version ]] || die 'cannot read the project version from CMakeLists.txt'

    released_version=$(git -C "$repo_root" tag --list |
        sed -nE 's/^v?([0-9]+\.[0-9]+\.[0-9]+)$/\1/p' |
        sort -V |
        tail -n 1)
}

print_version_overview() {
    printf 'oicq version overview\n\n'
    printf '  latest released tag: %s\n' "${released_version:-none}"
    printf '  in-tree version:     %s\n' "$project_version"
    printf '\nStart a release with:\n  ./release.sh --version 0.1.0\n'
}

check_repository() {
    local status_line origin

    resolve_repo_root
    branch=$(git -C "$repo_root" symbolic-ref --quiet --short HEAD) ||
        die 'release requires a checked-out branch'
    git -C "$repo_root" diff --cached --quiet || die 'staged changes must be committed first'

    while IFS= read -r status_line; do
        case "$status_line" in
        '?? release.sh' | ' M release.sh' | '?? install.sh' | ' M install.sh') ;;
        *) die "working tree must be clean except for release.sh and install.sh: $status_line" ;;
        esac
    done < <(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)

    if git -C "$repo_root" rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
        die "tag already exists: $tag"
    fi

    if [[ -z $repo_url ]]; then
        if origin=$(git -C "$repo_root" remote get-url origin 2>/dev/null); then
            case "$origin" in
            https://github.com/*) repo_url=${origin%.git} ;;
            git@github.com:*)
                repo_url="https://github.com/${origin#git@github.com:}"
                repo_url=${repo_url%.git}
                ;;
            ssh://git@github.com/*)
                repo_url="https://github.com/${origin#ssh://git@github.com/}"
                repo_url=${repo_url%.git}
                ;;
            *) note "origin is not a GitHub remote; release page URL omitted: $origin" ;;
            esac
        fi
    fi

    output_dir="$repo_root/dist/$tag"
    archive_name="oicq-$tag-linux-$TARGET_ARCH.tar.gz"
    [[ ! -e $output_dir ]] || die "output directory already exists: $output_dir"
}

update_versions() {
    cp -- "$repo_root/CMakeLists.txt" "$work_dir/CMakeLists.txt"
    cp -- "$repo_root/runtime/main.js" "$work_dir/main.js"
    files_changed=true

    (
        cd -- "$repo_root" && python3 - "$release_version" <<'PY'
from pathlib import Path
import re
import sys

new_version = sys.argv[1]
cmake = Path("CMakeLists.txt")
manifest = cmake.read_text()
match = re.search(
    r"(?m)^project\(oicq VERSION ([0-9]+\.[0-9]+\.[0-9]+) LANGUAGES CXX\)$",
    manifest,
)
if match is None:
    raise SystemExit("CMakeLists.txt has no project(oicq VERSION ...) line")
old_version = match.group(1)
runtime = Path("runtime/main.js")
source = runtime.read_text()
old_needle = f"const VERSION = '{old_version}';"
if source.count(old_needle) != 1:
    raise SystemExit("runtime/main.js does not carry exactly one matching VERSION")
if old_version == new_version:
    print(f"{new_version} (already in tree)")
else:
    manifest = manifest.replace(match.group(0), match.group(0).replace(
        old_version, new_version, 1
    ), 1)
    cmake.write_text(manifest)
    runtime.write_text(source.replace(old_needle, f"const VERSION = '{new_version}';"))
    print(f"{old_version} -> {new_version}")
PY
    ) >"$work_dir/version.txt"
    printf 'Version: %s\n' "$(cat -- "$work_dir/version.txt")"
}

run_host_tests() {
    printf 'Running host tests (native harnesses and Node.js runtime)\n'
    cmake -S "$repo_root" -B "$work_dir/host-build" -DCMAKE_BUILD_TYPE=Release \
        >"$work_dir/host-configure.log"
    cmake --build "$work_dir/host-build" -j"$(nproc)" >"$work_dir/host-build.log"
    ctest --test-dir "$work_dir/host-build" --output-on-failure
}

build_release_image() {
    printf 'Preparing %s from %s\n' "$BUILD_IMAGE" "$BASE_IMAGE"
    docker build --quiet --platform linux/amd64 --tag "$BUILD_IMAGE" - \
        >"$work_dir/build-image.txt" <<DOCKERFILE
FROM $BASE_IMAGE
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \\
    && apt-get install --no-install-recommends --yes \\
        binutils build-essential ca-certificates cmake file python3 \\
    && rm -rf /var/lib/apt/lists/*
DOCKERFILE
}

build_release() {
    printf 'Building and testing %s for glibc >= %s in %s\n' \
        "$release_version" "$GLIBC_FLOOR" "$BUILD_IMAGE"
    mkdir -p -- "$work_dir/obj"

    docker run --rm --platform linux/amd64 \
        --user "$(id -u):$(id -g)" \
        -v "$repo_root:/app:ro" -v "$work_dir/obj:/obj" -w /app "$BUILD_IMAGE" \
        sh -ec '
            cmake -S /app -B /obj -DCMAKE_BUILD_TYPE=Release
            cmake --build /obj -j"$(nproc)"
            ctest --test-dir /obj --output-on-failure
            strip --strip-unneeded /obj/oicq.so
            /app/scripts/checksec.sh /obj/oicq.so
            OICQ_DRY_RUN=1 OICQ_LOG=error LD_PRELOAD=/obj/oicq.so /bin/true
        '

    [[ -f $work_dir/obj/oicq.so ]] || die 'build did not create oicq.so'
    install -m 0755 -- "$work_dir/obj/oicq.so" "$work_dir/oicq.so"
}

verify_release() {
    local so=$work_dir/oicq.so
    local needed max_glibc highest
    local -a unexpected=()

    printf '\nVerifying %s\n' "$so"
    note "size    $(stat -c %s -- "$so") bytes"
    note "sha256  $(sha256sum -- "$so" | cut -d ' ' -f 1)"

    if readelf -lW -- "$so" | grep -q 'INTERP'; then
        die 'the artifact has a PT_INTERP segment and is not a loadable shared object'
    fi
    # The .so cannot be packed into a self-extracting file: only executables
    # carry a PT_INTERP. Portability is provided by the fixed old-glibc build
    # baseline instead, which the dependency and symbol checks below enforce.

    while IFS= read -r needed; do
        case "$needed" in
        libc.so.6 | ld-linux-x86-64.so.2) ;;
        *) unexpected+=("$needed") ;;
        esac
    done < <(readelf -dW -- "$so" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p')

    ((${#unexpected[@]} == 0)) ||
        die "unexpected dynamic dependencies: ${unexpected[*]}"
    note 'dynamic dependencies: libc.so.6, ld-linux-x86-64.so.2'

    max_glibc=$(readelf --dyn-syms --wide -- "$so" |
        grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' |
        sed 's/^GLIBC_//' |
        sort -Vu |
        tail -n 1)
    [[ -n $max_glibc ]] || die 'could not determine the glibc symbol floor'
    highest=$(printf '%s\n%s\n' "$max_glibc" "$GLIBC_FLOOR" | sort -V | tail -n 1)
    [[ $highest == "$GLIBC_FLOOR" ]] ||
        die "artifact needs glibc $max_glibc, above the $GLIBC_FLOOR baseline"
    note "highest glibc symbol version: $max_glibc (baseline <= $GLIBC_FLOOR)"
}

write_package_files() {
    local pkg=$output_dir/oicq

    mkdir -p -- "$pkg"
    install -m 0755 -- "$work_dir/oicq.so" "$pkg/oicq.so"

    [[ -f $repo_root/install.sh ]] || die 'install.sh is missing from the repository root'
    install -m 0755 -- "$repo_root/install.sh" "$pkg/install.sh"

    cat >"$pkg/readme.txt" <<README_EOF
oicq $release_version - QQNT injection extension framework (Linux $TARGET_ARCH)

Contents
  oicq.so       LD_PRELOAD library; the JS runtime, renderer UI and the observation-surface consistency layer are embedded.
  install.sh    writes qq.desktop for a given oicq.so and Linux QQ directory.
  readme.txt    this file.

qq.desktop is generated by install.sh, not shipped, because it must contain the absolute paths of your library and QQ installation.

What this is
  It attaches to the QQ main process at startup, finds V8's v8::ScriptCompiler::CompileFunction and prepends a loader to the host boot script source. Everything after that (config, plugins, UI) is plain JavaScript. /proc, directory and module traces QQ reads about itself stay clean for in-process readers.

Requirements
  - Linux x86_64, glibc >= $GLIBC_FLOOR (Ubuntu 22.04+ / Debian 12+)
  - QQNT Linux: verified on $TESTED_QQ. Other versions are untested (anchors may change); verify them yourself before relying on them.
  - No extra files: the library is self-contained apart from the C library

Install
  Keep this directory somewhere stable: qq.desktop embeds the absolute path of oicq.so, so moving or deleting it later breaks the launcher.

    ./install.sh ./oicq.so /path/to/linux-qq-dir
    cp \$PWD/qq.desktop \$HOME/.local/share/applications

  install.sh expects a <linux-qq-dir>/qq executable and writes qq.desktop in the current directory.

Verify
  Launch QQ, then check the log:
    ~/.oicq/logs/runtime.log
  It should contain "hook active", "anchor ... hit", "injected" and "retired". For a live trace:
    OICQ_LOG=debug LD_PRELOAD=/path/to/oicq.so /path/to/qq

After a QQ update
  The default anchor is a 62-byte boot script. A new QQ build changes the length and the match fails: "hook active" appears without "anchor hit". Read the "anchor ... (length/fingerprint)" lines with OICQ_LOG=debug, then override with:
    OICQ_ANCHORS='name=boot,length=62,marker=require('

Switches
  OICQ_SHIELD=0              disable the observation-surface layer
  OICQ_SHIELD_HIDE=a.so:b.so extra module names to hide
  OICQ_DATA_DIR=DIR          data root (default ~/.oicq)
  OICQ_LOG=error|warn|info|debug
  OICQ_NO_UI=1               main process only, no renderer preload
  OICQ_AUTOINIT=0            do not start on load

Uninstall
  Remove \$HOME/.local/share/applications/qq.desktop. You can then delete this directory if you no longer need the library.

Known boundaries
  - Raw-syscall reads of /proc and another process reading this process's /proc/<pid>/maps are not intercepted.
  - In-process spoofing covers libc entry points only; kernel audit (auditd/eBPF) does not see return values.
  - x86_64 only; the macOS and Windows backends are in the source tree but are not part of this package.
README_EOF
    chmod 0644 -- "$pkg/readme.txt"
}

package_release() {
    local checksum so_checksum

    output_created=true
    write_package_files

    (cd -- "$output_dir/oicq" && sha256sum oicq.so >"$output_dir/oicq.so.sha256")
    (cd -- "$output_dir/oicq" && sha256sum --check "$output_dir/oicq.so.sha256")
    so_checksum=$(cut -d ' ' -f 1 "$output_dir/oicq.so.sha256")

    tar -C "$output_dir" -czf "$output_dir/$archive_name" oicq
    while IFS= read -r member; do
        case "$member" in
        oicq/ | oicq/oicq.so | oicq/install.sh | oicq/readme.txt) ;;
        *) die "unexpected archive member: $member" ;;
        esac
    done < <(tar -tzf "$output_dir/$archive_name")
    [[ $(tar -tzf "$output_dir/$archive_name" | wc -l) -eq 4 ]] ||
        die 'archive does not contain exactly the expected members'

    (cd -- "$output_dir" && sha256sum "$archive_name" >"$archive_name.sha256")
    (cd -- "$output_dir" && sha256sum --check "$archive_name.sha256")
    checksum=$(cut -d ' ' -f 1 "$output_dir/$archive_name.sha256")

    cat >"$output_dir/release-notes.md" <<EOF
## oicq $release_version

Linux x86_64 LD_PRELOAD extension for QQNT. Built against glibc $GLIBC_FLOOR (Ubuntu 22.04 baseline). Verified on QQNT $TESTED_QQ; other versions are self-test only.

### Package contents

- \`oicq/oicq.so\` - the preload library. Config, plugin sandbox, command bus, renderer UI and the observation-surface consistency layer are all embedded.
- \`oicq/install.sh\` - writes \`qq.desktop\` for the library and a Linux QQ directory.
- \`oicq/readme.txt\` - requirements, installation, verification, switches and boundaries.

### Install

\`\`\`
tar xf $archive_name
cd oicq
./install.sh ./oicq.so /path/to/linux-qq-dir
cp \$PWD/qq.desktop \$HOME/.local/share/applications
\`\`\`

Keep the extracted directory where it is: \`qq.desktop\` embeds the absolute path of \`oicq.so\`.

### Verify

\`\`\`
sha256sum -c $archive_name.sha256
tar xf $archive_name
cd oicq && sha256sum -c ../oicq.so.sha256
\`\`\`

### Checksums

\`\`\`
SHA-256 ($archive_name): $checksum
SHA-256 (oicq.so): $so_checksum
\`\`\`

The library is self-contained apart from the C library. Portability comes from the fixed glibc $GLIBC_FLOOR build baseline: the only dynamic dependencies are \`libc.so.6\` and the ELF interpreter, so Ubuntu 22.04+ and Debian 12+ can load it.
EOF
}

# dist/current is a relative symlink to the newest release directory, so the
# pointer keeps working when the tree is moved or copied.
link_current() {
    local link=$repo_root/dist/current
    local current=

    if [[ -L $link ]]; then
        current=$(readlink -- "$link")
        current=${current##*/}
    elif [[ -e $link ]]; then
        die "dist/current exists and is not a symlink: $link"
    fi

    # A re-release of an older version must not move the pointer backwards.
    if [[ -n $current &&
        $(printf '%s\n%s\n' "$current" "$release_version" | sort -V | tail -n 1) != "$release_version" ]]; then
        note "dist/current stays at $current (newer than $release_version)"
        return 0
    fi

    ln -sfn -- "$release_version" "$link"
    note "dist/current -> $release_version"
}

commit_and_tag() {
    git -C "$repo_root" add -- release.sh install.sh CMakeLists.txt runtime/main.js
    files_staged=true
    if git -C "$repo_root" diff --cached --quiet; then
        note "no file changes for $tag; tagging the current commit"
    else
        git -C "$repo_root" commit -m "chore: release $tag"
    fi
    committed=true
    git -C "$repo_root" tag -a "$tag" -m "oicq $release_version"
}

print_release_info() {
    printf '\nRelease created locally at commit %s\n' "$(git -C "$repo_root" rev-parse --short HEAD)"
    printf 'dist/current -> %s\n' "$release_version"
    if [[ -n $repo_url ]]; then
        printf 'Push first:\n  git push origin %s\n  git push origin %s\n' "$branch" "$tag"
        printf '\nNew release page: %s/releases/new?tag=%s&target=%s&title=oicq%%20%s\n' \
            "$repo_url" "$tag" "$branch" "$release_version"
    else
        printf 'No GitHub origin is configured. Push the branch and tag, then create the release page manually with the fields below.\n'
    fi

    printf '\nRelease page\n'
    printf '  Tag:         %s\n' "$tag"
    printf '  Target:      %s\n' "$branch"
    printf '  Title:       oicq %s\n' "$release_version"
    printf '  Pre-release: no\n'
    printf '  Upload:\n'
    printf '    %s\n' "$output_dir/$archive_name"
    printf '    %s\n' "$output_dir/$archive_name.sha256"
    printf '    %s\n' "$output_dir/oicq.so.sha256"
    printf '\nVerify after downloading\n'
    printf '  sha256sum -c %s.sha256\n' "$archive_name"
    printf '  tar xf %s && cd oicq && sha256sum -c ../oicq.so.sha256\n' "$archive_name"
    printf '\nPackage contents\n'
    printf '  oicq/oicq.so      preload library (runtime embedded, stripped)\n'
    printf '  oicq/install.sh   writes qq.desktop for a library and a QQ directory\n'
    printf '  oicq/readme.txt   requirements, installation, verification, boundaries\n'
    printf '\nDescription (copy from %s):\n\n' "$output_dir/release-notes.md"
    cat -- "$output_dir/release-notes.md"
}

main() {
    local dependency

    parse_args "$@"

    if [[ -z $release_version ]]; then
        for dependency in git sed sort head tail; do
            require_command "$dependency"
        done
        detect_versions
        print_version_overview
        return 0
    fi

    for dependency in git docker python3 cmake ctest sha256sum readelf grep sed \
        sort awk tar cut stat head nproc id mktemp; do
        require_command "$dependency"
    done
    detect_versions
    check_environment
    check_repository
    printf 'Latest released version: %s; in-tree version: %s\n' \
        "${released_version:-none}" "$project_version"

    work_dir=$(mktemp -d "${TMPDIR:-/tmp}/oicq-release.XXXXXXXXXX")
    trap cleanup EXIT

    update_versions
    run_host_tests
    build_release_image
    build_release
    verify_release
    package_release
    commit_and_tag
    link_current
    print_release_info
}

main "$@"
