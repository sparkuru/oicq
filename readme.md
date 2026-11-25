```
LD_PRELOAD ./oicq.so            Linux
insert_dylib / dylib injection  macOS
dbghelp.dll proxy               Windows
        └─ hook v8::ScriptCompiler::CompileFunction
             └─ anchor match → prepend require('<tmp>/oicq/boot.cjs') to the source → call the original → restore the source
                  └─ runtime/main.js: config / plugin sandbox / command bus / IPC
                       └─ runtime/renderer.js: panel, floating ball, command palette, settings (Shadow DOM)
```

## Layout

| Path | Contents |
| --- | --- |
| `src/core/` | config, logging, anchor matching, source splicing, payload embedding/writing, x86-64 length decoding |
| `src/platform/linux` | inline hook (14-byte `FF 25` + RWX trampoline), entry point |
| `src/platform/macos` | Dobby backend, arm64 patching, entry point |
| `src/platform/windows` | export table redirection, remote mapping, renderer bridge, entry point |
| `runtime/` | JS runtime (host / preload / UI / minimal payload) |
| `plugins/oicq-hello` | example plugin: a command + a custom tab |
| `experiments/forge/` | observation-surface consistency layer experiments (groups A/B/C/D + real QQ sampling) |
| `scripts/checksec.sh` | anti-detection self-check: interception surface, export surface, runtime libc view vs. raw syscall view |

## Build

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
./scripts/checksec.sh            # or cmake --build build --target checksec
```

Artifact: `build/oicq.so` (`oicq-nt.dll` on Windows, deployed under the name `dbghelp.dll`).

## Usage

```bash
OICQ_DATA_DIR=$PWD/.data LD_PRELOAD=$PWD/build/oicq.so /path/to/qq
```

| Environment variable | Effect |
| --- | --- |
| `OICQ_DATA_DIR` | data root, defaults to `~/.oicq` |
| `OICQ_LOG` | `error` / `warn` / `info` / `debug` |
| `OICQ_RUNTIME` | `host` (default) / `minimal` |
| `OICQ_ANCHORS` | anchor table, e.g. `name=boot,length=62,marker=require(` |
| `OICQ_MAX_HITS` | `1` (default: inject once, then only forward) / `0` (inject on every hit, for debugging) |
| `OICQ_INPLACE_SPLICE` | `1` switches back to in-place rewriting |
| `OICQ_DRY_RUN` | `1` only write the payload, do not resolve symbols |
| `OICQ_AUTOINIT` | `0` disables start-on-load |
| `OICQ_UNSAFE_HOOK` | `1` allows "restore-then-repatch" on a non-relocatable prologue (refused by default) |
| `OICQ_NO_UI` | `1` skips the renderer preload (keeps only the main-process host, for troubleshooting) |
| `OICQ_KERNEL_HOOKS` | `1` installs the kernel-IPC bridge; builtin plugins that need it stay `unavailable` otherwise |

On Linux QQ's own launcher strips unknown `OICQ_*` variables; use
`config.json` -> `{"kernel":{"hooks":true}}` for the bridge and an isolated
`HOME` for the data root when testing the real client.
| `OICQ_VERBOSE_CONSOLE` | `1` also writes renderer info/verbose console output to runtime.log (warning/error only by default) |
| `OICQ_FORCE_PRELOAD_RELOAD` | `1` allows one reload when a window missed the preload (no reload by default, to avoid signing out) |
| `OICQ_SHIELD` | `0` disables the observation-surface consistency layer (enabled by default; verify with `scripts/checksec.sh`) |
| `OICQ_SHIELD_HIDE` | additional module names to hide from maps/smaps/dl_iterate_phdr, colon-separated |
| `OICQ_SHIELD_DEBUG` | `1` prints the consistency layer's own baseline to stderr |

UI: `Ctrl/Cmd+Shift+O` opens the panel, `Ctrl/Cmd+K` opens the command palette.

