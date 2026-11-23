// Windows x86-64 inline detour with the same 14-byte absolute jump ref uses
// on Linux (FF 25 00 00 00 00 <addr64>). Windows also gets the export shim;
// this backend exists so the CompileFunction detour can be reused verbatim.

#include <windows.h>

#include <cstring>

#include "oicq/hook_backend.h"
#include "oicq/log.h"

namespace oicq {
namespace {

bool protect(void* address, std::size_t length, DWORD prot, DWORD* old) {
  return VirtualProtect(address, length, prot, old) != 0;
}

class WindowsInlineHook final : public HookBackend {
 public:
  const char* name() const override { return "windows-inline-x86_64"; }

  bool install(HookInfo* info) override {
    if (info == nullptr || info->target == nullptr || info->detour == nullptr) return false;
    if (info->enabled) return true;
    const auto* code = static_cast<const unsigned char*>(info->target);
    const std::size_t length = compute_patch_length(code, kPatchMin, 64);
    if (length == 0 || length > kSavedCapacity) return false;
    std::memcpy(info->saved, code, length);
    info->length = static_cast<int>(length);

    void* trampoline = VirtualAlloc(nullptr, length + kAbsJumpSize,
                                    MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (trampoline != nullptr) {
      std::memcpy(trampoline, info->saved, length);
      unsigned char jump[kAbsJumpSize];
      encode_abs_jump(reinterpret_cast<std::uintptr_t>(info->target) + length, jump);
      std::memcpy(static_cast<unsigned char*>(trampoline) + length, jump, sizeof(jump));
      info->trampoline_usable = 1;
    info->trampoline = trampoline;
    }
    DWORD old = 0;
    if (!protect(info->target, length, PAGE_EXECUTE_READWRITE, &old)) return false;
    unsigned char jump[kAbsJumpSize];
    encode_abs_jump(reinterpret_cast<std::uintptr_t>(info->detour), jump);
    std::memcpy(info->target, jump, sizeof(jump));
    FlushInstructionCache(GetCurrentProcess(), info->target, sizeof(jump));
    protect(info->target, length, old, &old);
    info->enabled = 1;
    return true;
  }

  bool disable(HookInfo* info) override {
    if (info == nullptr || !info->enabled) return false;
    DWORD old = 0;
    if (!protect(info->target, static_cast<std::size_t>(info->length),
                 PAGE_EXECUTE_READWRITE, &old)) {
      return false;
    }
    std::memcpy(info->target, info->saved, static_cast<std::size_t>(info->length));
    FlushInstructionCache(GetCurrentProcess(), info->target,
                          static_cast<std::size_t>(info->length));
    protect(info->target, static_cast<std::size_t>(info->length), old, &old);
    info->enabled = 0;
    return true;
  }

  bool enable(HookInfo* info) override {
    if (info == nullptr || info->enabled) return false;
    DWORD old = 0;
    const std::size_t length = static_cast<std::size_t>(info->length);
    if (!protect(info->target, length, PAGE_EXECUTE_READWRITE, &old)) return false;
    unsigned char jump[kAbsJumpSize];
    encode_abs_jump(reinterpret_cast<std::uintptr_t>(info->detour), jump);
    std::memcpy(info->target, jump, sizeof(jump));
    FlushInstructionCache(GetCurrentProcess(), info->target, sizeof(jump));
    protect(info->target, length, old, &old);
    info->enabled = 1;
    return true;
  }

  void release(HookInfo* info) override {
    if (info == nullptr) return;
    if (info->enabled) disable(info);
    if (info->trampoline != nullptr) VirtualFree(info->trampoline, 0, MEM_RELEASE);
    *info = HookInfo{};
  }
};

}  // namespace

HookBackend* default_hook_backend() {
  static WindowsInlineHook backend;
  return &backend;
}

}  // namespace oicq
