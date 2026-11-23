// macOS entry point and hook.
//
// Same split as the Linux side: native work is limited to finding
// CompileFunction, detouring it and prepending a loader expression to the
// anchored module. Everything the user actually sees lives in runtime/*.js.

#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>

#include "oicq/config.h"
#include "oicq/hook_backend.h"
#include "oicq/log.h"
#include "oicq/resource.h"
#include "oicq/source_anchor.h"
#include "oicq/source_splice.h"

namespace oicq {
namespace {

struct RuntimeState {
  Options options;
  HookInfo info;
  std::string inject;
  int hits = 0;
  void* original = nullptr;
  bool started = false;
};

// Function-local: `__attribute__((constructor))` runs before this translation
// unit's `_GLOBAL__sub_I_*` (visible in .init_array order), so a namespace-scope
// RuntimeState would still be raw .bss when the loader constructor fires.
RuntimeState& state() {
  static RuntimeState* instance = new RuntimeState();
  return *instance;
}

using CompileFunctionFn = void* (*)(void* context, void* source, std::size_t argc,
                                    void* argv, std::size_t ext_count,
                                    void* ext_values, int options, int reason);

bool ends_with(const char* text, const char* suffix) {
  if (text == nullptr || suffix == nullptr) return false;
  const std::size_t text_length = std::strlen(text);
  const std::size_t suffix_length = std::strlen(suffix);
  if (suffix_length > text_length) return false;
  return std::strcmp(text + text_length - suffix_length, suffix) == 0;
}

bool process_is_target() {
  char*** argv = _NSGetArgv();
  if (argv == nullptr || *argv == nullptr) return false;
  const char* path = (*argv)[0];
  return ends_with(path, "QQNT") || ends_with(path, "QQ");
}

void* compile_function_hook(void* context, void* source, std::size_t argc,
                            void* argv, std::size_t ext_count, void* ext_values,
                            int options, int reason) {
  const bool budget_left =
      state().options.max_hits <= 0 || state().hits < state().options.max_hits;
  const int anchor = source != nullptr && budget_left
                         ? match_anchor(source, state().options.anchors)
                         : -1;
  SpliceResult splice;
  if (anchor >= 0) {
    OICQ_LOGI("anchor %s hit (%s)",
              state().options.anchors[static_cast<std::size_t>(anchor)].name.c_str(),
              source_fingerprint(source).c_str());
    if (splice_prefix(source, state().inject, &splice)) {
      ++state().hits;
      OICQ_LOGI("injected (hit %d, safe=%d)", state().hits, splice.safe ? 1 : 0);
    }
  }

  auto trampoline = reinterpret_cast<CompileFunctionFn>(state().info.trampoline);
  void* result = trampoline != nullptr
                     ? trampoline(context, source, argc, argv, ext_count, ext_values,
                                  options, reason)
                     : nullptr;

  if (splice.active) splice_restore(&splice);
  // One-shot only when the budget says so; Dobby's detour stays installed
  // otherwise so a second bootstrap compile is still handled.
  const bool exhausted = state().options.max_hits > 0 &&
                         state().hits >= state().options.max_hits;
  if (exhausted) {
    // Same contract as Linux: restore the prologue and drop the detour once the
    // injection is done, so nothing patched stays behind for an integrity check.
    default_hook_backend()->release(&state().info);
    OICQ_LOGI("hook retired: original prologue restored");
  }
  return result;
}

void* open_target() {
  void* handle = dlopen("qq", RTLD_LAZY);
  if (handle != nullptr) return handle;
  return dlopen("/Applications/QQ.app/Contents/Frameworks/QQNT.framework/QQNT",
                RTLD_LAZY);
}

void* resolve_compile_function() {
  void* handle = open_target();
  void* symbol = handle != nullptr ? dlsym(handle, kMangledCompileFunctionMac) : nullptr;
  if (symbol == nullptr) symbol = dlsym(RTLD_DEFAULT, kMangledCompileFunctionMac);
  while (symbol == nullptr) {
    usleep(static_cast<useconds_t>(state().options.retry_ms) * 1000);
    handle = open_target();
    symbol = handle != nullptr ? dlsym(handle, kMangledCompileFunctionMac) : nullptr;
    if (symbol == nullptr) symbol = dlsym(RTLD_DEFAULT, kMangledCompileFunctionMac);
  }
  return symbol;
}

void worker() {
  if (!process_is_target()) {
    OICQ_LOGD("skip: argv[0] is not QQNT/QQ");
    return;
  }
  const std::string path = materialise_runtime(state().options);
  if (path.empty()) return;
  state().inject = build_inject_expression(state().options, path);

  void* target = resolve_compile_function();
  state().original = target;
  state().info.target = target;
  state().info.detour = reinterpret_cast<void*>(&compile_function_hook);
  if (!default_hook_backend()->install(&state().info)) {
    OICQ_LOGE("DobbyHook failed at %p", target);
    return;
  }
  OICQ_LOGI("oicq macOS hook active at %p", target);
}

}  // namespace

extern "C" void oicq_init() {
  if (state().started) return;
  state().started = true;
  state().options = options_from_env();
  splice_set_prefer_safe(state().options.safe_splice);
  std::thread(worker).detach();
}

void* dispatch_compile_hook(void* context, void* source, std::size_t argc,
                            void* argv, std::size_t ext_count, void* ext_values,
                            int options, int reason) {
  return compile_function_hook(context, source, argc, argv, ext_count, ext_values,
                               options, reason);
}

}  // namespace oicq

extern "C" __attribute__((visibility("default"))) void init() { oicq::oicq_init(); }
extern "C" __attribute__((visibility("default"))) void performHook() {
  oicq::oicq_init();
}
extern "C" __attribute__((visibility("default"))) void* OicqCompileFunctionHook(
    void* context, void* source, std::size_t argc, void* argv, std::size_t ext_count,
    void* ext_values, int options, int reason) {
  return oicq::dispatch_compile_hook(context, source, argc, argv, ext_count,
                                     ext_values, options, reason);
}
