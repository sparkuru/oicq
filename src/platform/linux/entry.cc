// Linux entry point and V8 CompileFunction hook.
//
// The trick itself is the same one every QQNT loader on this platform uses:
// resolve v8::ScriptCompiler::CompileFunction, patch its prologue, and prepend
// a loader expression to the source of the module we care about. oicq differs
// in *how* the module is recognised and in what gets prepended:
//
//   anchor   length tuple + optional literal marker (config.h / AnchorSpec)
//            instead of one hard-coded byte count
//   payload  <tmp>/oicq/boot.cjs, guarded IIFE (see build_inject_expression)
//   arming   sticky by default; OICQ_MAX_HITS=1 restores one-shot behaviour
//   splice   handle swap by default; in-place rewrite only on request

#include <dlfcn.h>
#include <time.h>
#include <unistd.h>

#include <atomic>
#include <cstdlib>
#include <cstring>
#include <fstream>
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
  std::string resolved_module;
  std::string anchor_name;
  std::string entry_path;
  std::atomic<int> hits{0};
  bool exhausted_logged = false;
  bool retired = false;
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

bool budget_left() {
  return state().options.max_hits <= 0 ||
         state().hits.load(std::memory_order_relaxed) < state().options.max_hits;
}

// Claims one injection slot. Concurrency matters: several threads can reach the
// detour with a matching source at the same time, and only one of them may
// splice (the runtime is process-global).
bool claim_hit() {
  const int limit = state().options.max_hits;
  if (limit <= 0) {
    state().hits.fetch_add(1, std::memory_order_relaxed);
    return true;
  }
  int current = state().hits.load(std::memory_order_relaxed);
  while (current < limit) {
    if (state().hits.compare_exchange_weak(current, current + 1)) return true;
  }
  return false;
}

// Calls the real v8::ScriptCompiler::CompileFunction.
//
// Preferred path: jump into the trampoline, which replays the original prologue
// and jumps back past our patch. That needs no byte surgery while other threads
// may be executing the same code, so it is safe under concurrent compiles.
// Fallback (trampoline inert or absent): restore the prologue, call, re-arm —
// the same dance the reference build does, only used when we must.
// Restores .text and drops the trampoline. Safe to call twice.
void retire_hook() {
  if (state().retired) return;
  state().retired = true;
  if (state().info.target == nullptr) return;
  default_hook_backend()->release(&state().info);
  OICQ_LOGI("hook retired: prologue restored, trampoline unmapped");
}

void* call_original(void* context, void* source, std::size_t argc, void* argv,
                    std::size_t ext_count, void* ext_values, int options, int reason) {
  auto forward = state().info.trampoline_usable
                     ? reinterpret_cast<CompileFunctionFn>(state().info.trampoline)
                     : nullptr;
  if (forward != nullptr) {
    return forward(context, source, argc, argv, ext_count, ext_values, options, reason);
  }
  HookBackend* backend = default_hook_backend();
  const bool was_enabled = state().info.enabled != 0;
  if (was_enabled) backend->disable(&state().info);
  auto original = reinterpret_cast<CompileFunctionFn>(state().original);
  void* result = nullptr;
  if (original != nullptr) {
    result = original(context, source, argc, argv, ext_count, ext_values, options, reason);
  }
  if (was_enabled && budget_left()) backend->enable(&state().info);
  return result;
}

void* compile_function_hook(void* context, void* source, std::size_t argc,
                            void* argv, std::size_t ext_count, void* ext_values,
                            int options, int reason) {
  // A compile triggered from inside our own splice (or a nested compile on the
  // same thread) must not go through the detour again.
  static thread_local bool reentrant = false;
  if (reentrant) {
    return call_original(context, source, argc, argv, ext_count, ext_values, options,
                         reason);
  }
  reentrant = true;
  struct Guard {
    bool* flag;
    ~Guard() { *flag = false; }
  } guard{&reentrant};

  const int anchor = source != nullptr && budget_left()
                         ? match_anchor(source, state().options.anchors)
                         : -1;
  SpliceResult splice;
  bool injected = false;
  if (anchor >= 0) {
    state().anchor_name = state().options.anchors[static_cast<std::size_t>(anchor)].name;
    OICQ_LOGI("anchor %s hit (%s); splicing", state().anchor_name.c_str(),
              source_fingerprint(source).c_str());
    if (!claim_hit()) {
      OICQ_LOGD("another thread already injected; forwarding unchanged");
    } else if (!splice_prefix(source, state().inject, &splice)) {
      OICQ_LOGW("splice failed; forwarding the source unchanged");
    } else {
      injected = true;
      OICQ_LOGI("injected (hit %d, safe=%d)", state().hits.load(), splice.safe ? 1 : 0);
    }
  }

  void* result = call_original(context, source, argc, argv, ext_count, ext_values,
                               options, reason);
  if (splice.active) splice_restore(&splice);

  // Retire the hook as soon as the budget is spent: restore the original
  // prologue and unmap the RWX trampoline. Leaving a patched entry point and an
  // executable anonymous mapping in the process is exactly what a memory
  // integrity check looks for — QQNT ships one (`BQQNT_checkMemory`), and the
  // observed "quit back to the login screen" is the host quitting itself, not a
  // crash. Injection is done by this point, so nothing of ours is lost.
  if (injected && !budget_left() && !state().exhausted_logged) {
    state().exhausted_logged = true;
    retire_hook();
  }
  return result;
}

// True for every Chromium child (renderer, gpu, zygote, utility). Children must
// never start a worker thread: an extra thread alive when the browser process
// forks the zygote trips `FATAL:zygote_host_impl_linux.cc ... 无效的参数`.
bool process_is_child() {
  std::ifstream file("/proc/self/cmdline", std::ios::binary);
  if (!file) return false;
  std::string data((std::istreambuf_iterator<char>(file)),
                   std::istreambuf_iterator<char>());
  if (data.size() < 7) return false;
  return data.find("--type=") != std::string::npos;
}

void sleep_ms(int milliseconds) {
  timespec ts{};
  ts.tv_sec = milliseconds / 1000;
  ts.tv_nsec = static_cast<long>(milliseconds % 1000) * 1000000L;
  while (nanosleep(&ts, &ts) == -1) {
  }
}

void* dlopen_qq() {
  void* handle = dlopen("qq", RTLD_LAZY);
  if (handle != nullptr) {
    Dl_info info{};
    if (dladdr(dlsym(handle, kMangledCompileFunctionLinux), &info) && info.dli_fname) {
      state().resolved_module = info.dli_fname;
    }
    return handle;
  }
  const char* candidates[] = {"QQNT", "/opt/QQ/qq", "./qq", nullptr};
  for (int i = 0; candidates[i] != nullptr; ++i) {
    handle = dlopen(candidates[i], RTLD_LAZY);
    if (handle != nullptr) {
      state().resolved_module = candidates[i];
      return handle;
    }
  }
  return nullptr;
}

void* resolve_compile_function() {
  void* handle = dlopen_qq();
  void* symbol = handle != nullptr ? dlsym(handle, kMangledCompileFunctionLinux) : nullptr;
  if (symbol == nullptr) {
    symbol = dlsym(RTLD_DEFAULT, kMangledCompileFunctionLinux);
  }
  while (symbol == nullptr) {
    sleep_ms(state().options.retry_ms);
    handle = dlopen_qq();
    symbol = handle != nullptr ? dlsym(handle, kMangledCompileFunctionLinux) : nullptr;
    if (symbol == nullptr) symbol = dlsym(RTLD_DEFAULT, kMangledCompileFunctionLinux);
  }
  // A RTLD_DEFAULT hit leaves the module name empty; resolve it for the log.
  if (state().resolved_module.empty()) {
    Dl_info info{};
    if (dladdr(symbol, &info) && info.dli_fname != nullptr) {
      state().resolved_module = info.dli_fname;
    }
  }
  return symbol;
}

bool prepare(std::string* error) {
  if (process_is_child()) {
    *error = "process has --type= (not the QQNT browser process)";
    return false;
  }
  const std::string path = materialise_runtime(state().options);
  if (path.empty()) {
    *error = "cannot materialise the runtime payload";
    return false;
  }
  state().entry_path = path;
  state().inject = build_inject_expression(state().options, path);
  OICQ_LOGD("inject expression: %s", state().inject.c_str());
  return true;
}

template <typename T>
T resolve_v8_symbol(const char* name) {
  return reinterpret_cast<T>(dlsym(RTLD_DEFAULT, name));
}

// Binds the optional handle-swap path. When the three symbols resolve, the
// source handle is replaced by a freshly allocated string instead of the
// original buffer being rewritten past its allocation.
void bind_splice_api() {
  V8SpliceApi api;
  api.get_current_isolate =
      resolve_v8_symbol<decltype(api.get_current_isolate)>(kMangledIsolateGetCurrent);
  api.new_from_utf8 =
      resolve_v8_symbol<decltype(api.new_from_utf8)>(kMangledStringNewFromUtf8);
  api.concat = resolve_v8_symbol<decltype(api.concat)>(kMangledStringConcat);
  if (api.ready()) {
    splice_set_api(api);
    OICQ_LOGI("v8 splice api bound (handle-swap path)");
  } else {
    OICQ_LOGW("v8 splice api unavailable; using in-place splice");
  }
}

void worker() {
  if (std::getenv("OICQ_TRACE")) std::fprintf(stderr, "[oicq] worker start\n");
  std::string error;
  if (!prepare(&error)) {
    OICQ_LOGD("skip: %s", error.c_str());
    return;
  }
  if (const char* dry = std::getenv("OICQ_DRY_RUN"); dry != nullptr && dry[0] == '1') {
    OICQ_LOGI("dry run: runtime written, symbol resolution skipped");
    return;
  }
  void* target = resolve_compile_function();
  state().original = target;
  state().info.target = target;
  state().info.detour = reinterpret_cast<void*>(&compile_function_hook);
  bind_splice_api();

  HookBackend* backend = default_hook_backend();
  if (!backend->install(&state().info)) {
    OICQ_LOGE("hook installation failed at %p", target);
    return;
  }
  OICQ_LOGI("oicq hook active (module=%s, max_hits=%d)", state().resolved_module.c_str(),
            state().options.max_hits);
}

}  // namespace

void* dispatch_compile_hook(void* context, void* source, std::size_t argc,
                            void* argv, std::size_t ext_count, void* ext_values,
                            int options, int reason) {
  return compile_function_hook(context, source, argc, argv, ext_count, ext_values,
                               options, reason);
}

bool install_on(void* target, const std::string& inject, const Options& options) {
  state().options = options;
  splice_set_prefer_safe(options.safe_splice);
  state().inject = inject;
  state().original = target;
  state().info.target = target;
  state().info.detour = reinterpret_cast<void*>(&compile_function_hook);
  state().started = true;
  return default_hook_backend()->install(&state().info);
}

void uninstall_hook() {
  if (state().info.target != nullptr) default_hook_backend()->release(&state().info);
  state().original = nullptr;
  state().hits = 0;
  state().retired = false;
}

const Options& runtime_options() { return state().options; }
void runtime_set_options(const Options& options) {
  state().options = options;
  splice_set_prefer_safe(options.safe_splice);
}
bool runtime_started() { return state().started; }
int runtime_hits() { return state().hits.load(); }

// Entry point used by the loader (constructor or explicit call).
//
// Children bail out *before* anything is created: no thread, no file, no
// dlopen. This is the only reason the reference build never tripped Chromium's
// zygote check, and the reason oicq has to check here rather than in worker().
extern "C" __attribute__((visibility("default"))) void oicq_init() {
  const char* trace = std::getenv("OICQ_TRACE");
  if (trace) std::fprintf(stderr, "[oicq] init enter\n");
  if (state().started) return;
  if (process_is_child()) return;
  state().started = true;
  state().options = options_from_env();
  if (trace) std::fprintf(stderr, "[oicq] options ready anchors=%zu max_hits=%d\n",
                          state().options.anchors.size(), state().options.max_hits);
  splice_set_prefer_safe(state().options.safe_splice);
  std::thread(worker).detach();
  if (trace) std::fprintf(stderr, "[oicq] worker spawned\n");
}

// Last materialised entry point; used by the harnesses and by `oicq doctor`.
extern "C" __attribute__((visibility("default"))) const char* oicq_entry_path() { return state().entry_path.c_str(); }

extern "C" __attribute__((visibility("default"))) void oicq_boot() {
  if (state().started) return;
  if (process_is_child()) return;
  state().started = true;
  state().options = options_from_env();
  splice_set_prefer_safe(state().options.safe_splice);
  worker();
}

}  // namespace oicq

// Loader-facing entry points. `init` is what our own preload stub calls;
// `performHook` is kept because third-party loaders probe for that name.
extern "C" __attribute__((visibility("default"))) void init() { oicq::oicq_init(); }
extern "C" __attribute__((visibility("default"))) void performHook() {
  oicq::oicq_init();
}

extern "C" __attribute__((visibility("default"))) void oicq_mangled_init()
    __asm__("_Z4initv");
extern "C" __attribute__((visibility("default"))) void oicq_mangled_init() {
  oicq::oicq_init();
}
extern "C" __attribute__((visibility("default"))) void oicq_mangled_perform()
    __asm__("_Z11performHookv");
extern "C" __attribute__((visibility("default"))) void oicq_mangled_perform() {
  oicq::oicq_init();
}

extern "C" __attribute__((visibility("default"))) void* OicqCompileFunctionHook(
    void* context, void* source, std::size_t argc, void* argv, std::size_t ext_count,
    void* ext_values, int options, int reason) {
  return oicq::dispatch_compile_hook(context, source, argc, argv, ext_count,
                                     ext_values, options, reason);
}

// A bare LD_PRELOAD is enough: the constructor arms the loader in the browser
// process and returns immediately everywhere else. OICQ_AUTOINIT=0 opts out
// (harnesses, and loaders that call oicq_init() themselves).
__attribute__((constructor)) static void oicq_autostart() {
  const char* value = std::getenv("OICQ_AUTOINIT");
  if (value != nullptr && std::strcmp(value, "0") == 0) return;
  oicq::oicq_init();
}
