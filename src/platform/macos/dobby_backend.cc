// Dobby-backed detour, following the same macOS hook lifecycle as the reference build:
//   DobbyHook(target, CompileFunctionHook, &pTrampolineCompileFunc)
//   ... CompileFunctionHook calls the trampoline ...
//   DobbyDestroy(target) after the first matching source.
//
// ref links @rpath/libdobby.dylib; the reimplementation resolves the two
// entry points lazily so the library also builds without Dobby present.

#include <dlfcn.h>

#include "oicq/hook_backend.h"
#include "oicq/log.h"

namespace oicq {
namespace {

using DobbyHookFn = int (*)(void* address, void* replace, void** origin);
using DobbyDestroyFn = int (*)(void* address);

struct DobbyApi {
  DobbyHookFn hook = nullptr;
  DobbyDestroyFn destroy = nullptr;
  bool ready() const { return hook != nullptr && destroy != nullptr; }
};

void* g_dobby_handle = nullptr;

void* resolve_symbol(const char* name) {
  void* symbol = dlsym(RTLD_DEFAULT, name);
  if (symbol != nullptr) return symbol;
  if (g_dobby_handle == nullptr) {
    g_dobby_handle = dlopen("libdobby.dylib", RTLD_LAZY);
    if (g_dobby_handle == nullptr) g_dobby_handle = dlopen("@rpath/libdobby.dylib", RTLD_LAZY);
  }
  return g_dobby_handle != nullptr ? dlsym(g_dobby_handle, name) : nullptr;
}

DobbyApi& api() {
  static DobbyApi instance = [] {
    DobbyApi out;
    out.hook = reinterpret_cast<DobbyHookFn>(resolve_symbol("DobbyHook"));
    out.destroy = reinterpret_cast<DobbyDestroyFn>(resolve_symbol("DobbyDestroy"));
    return out;
  }();
  return instance;
}

class DobbyBackend final : public HookBackend {
 public:
  const char* name() const override { return "macos-dobby-arm64"; }

  bool install(HookInfo* info) override {
    if (info == nullptr || info->target == nullptr || info->detour == nullptr) return false;
    if (!api().ready()) {
      OICQ_LOGE("DobbyHook/DobbyDestroy not resolvable");
      return false;
    }
    void* trampoline = nullptr;
    if (api().hook(info->target, info->detour, &trampoline) != 0) {
      OICQ_LOGE("DobbyHook failed for %p", info->target);
      return false;
    }
    info->trampoline_usable = 1;
    info->trampoline = trampoline;
    info->length = 16;
    info->enabled = 1;
    return true;
  }

  bool disable(HookInfo* info) override {
    if (info == nullptr || !info->enabled) return false;
    if (!api().ready()) return false;
    api().destroy(info->target);
    info->enabled = 0;
    return true;
  }

  bool enable(HookInfo* info) override {
    if (info == nullptr) return false;
    HookInfo copy = *info;
    copy.enabled = 0;
    copy.trampoline = nullptr;
    if (!install(&copy)) return false;
    *info = copy;
    return true;
  }

  void release(HookInfo* info) override {
    if (info == nullptr) return;
    if (info->enabled) disable(info);
    info->trampoline = nullptr;
  }
};

}  // namespace

HookBackend* default_hook_backend() {
  static DobbyBackend backend;
  return &backend;
}

}  // namespace oicq
