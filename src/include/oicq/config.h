#ifndef OICQ_CONFIG_H
#define OICQ_CONFIG_H

#include <cstddef>
#include <string>
#include <vector>

namespace oicq {

// Fixed V8 surface used by every platform. The mangled names come from the
// PE export table and the ELF .rodata of the QQNT build we target; both point
// at the same v8::ScriptCompiler entry points.
extern const char kMangledCompileFunctionLinux[];
extern const char kMangledCompileFunctionMac[];
extern const char kMangledScriptCompileWindows[];
extern const char kMangledScriptRunWindows[];

// V8 string helpers used by the optional safe splice path. The safe path
// allocates a new string and swaps the Source handle instead of rewriting the
// original one-byte string in place.
extern const char kMangledIsolateGetCurrent[];
extern const char kMangledStringNewFromUtf8[];
extern const char kMangledStringConcat[];

// A source anchor says "this is the module we want to prepend our loader to".
//
// The reference build keys on a single hard-coded byte length, which breaks on
// every QQNT release that touches the boot script. oicq matches on a tuple
// instead: byte length plus an optional literal marker that must appear in the
// source text. Several anchors can be active at once, and the spec is
// overridable at run time (OICQ_ANCHORS).
struct AnchorSpec {
  std::string name;    // stable id, used in logs and in the hit report
  int length = 0;      // byte length of the one-byte source string
  std::string marker;  // optional substring; empty means length-only
};

// Bootstrap length of the QQNT main-process entry script (0x3e == 62).
constexpr int kBootstrapLength = 0x3e;

std::vector<AnchorSpec> default_anchors();

// Parses "62" | "62,71" | "name=qqnt-boot,length=62,marker=require(".
// Returns an empty vector when the spec cannot be understood.
std::vector<AnchorSpec> parse_anchor_spec(const std::string& spec);

struct Options {
  // "auto" picks the embedded host runtime. "host" forces it, "minimal" keeps
  // only the loader stub (useful to validate the native half alone).
  std::string runtime = "auto";
  // Injection expression template. {path} is replaced with the written file.
  // Defaults to a guarded IIFE, not a bare require().
  std::string inject_template;
  // Directory for the written runtime; empty => system temp directory.
  std::string temp_dir;
  // Sub-directory created under temp_dir so the payload never sits in the
  // shared temp root. Empty disables the sub-directory.
  std::string temp_subdir = "oicq";
  // Retry interval while the V8 symbol is not resolvable yet.
  int retry_ms = 100;
  // Active source anchors (see AnchorSpec).
  std::vector<AnchorSpec> anchors = default_anchors();
  // How many matching sources to inject. 1 (default) removes the hook after the
  // first hit: the runtime marks the process on execution, so a second pass adds
  // nothing while every extra patched call is a chance to race other threads.
  // 0 keeps the hook armed (OICQ_MAX_HITS=0) for debugging.
  int max_hits = 1;
  // Replace the source handle with a freshly allocated V8 string instead of
  // rewriting the original one in place (the in-place path overflows the
  // string allocation by the prefix length; see docs/05-v8-source-abi.md).
  bool safe_splice = true;
};

// Reads the OICQ_* environment into a fresh Options value.
Options options_from_env();

}  // namespace oicq

#endif  // OICQ_CONFIG_H
