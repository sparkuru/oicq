#include <sys/mman.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>

#include "oicq/hook_backend.h"
#include "oicq/log.h"

namespace oicq {
namespace {

long page_size() {
  static long value = sysconf(_SC_PAGESIZE);
  return value > 0 ? value : 4096;
}

bool protect_range(void* address, std::size_t length, int prot) {
  const std::uintptr_t start = reinterpret_cast<std::uintptr_t>(address);
  const std::uintptr_t page = static_cast<std::uintptr_t>(page_size());
  const std::uintptr_t base = start & ~(page - 1);
  const std::uintptr_t end = (start + length + page - 1) & ~(page - 1);
  return mprotect(reinterpret_cast<void*>(base), end - base, prot) == 0;
}

bool is_position_dependent(const unsigned char* code, std::size_t length) {
  // Walk instruction boundaries and reject relative control flow. ref copies
  // bytes into an RWX trampoline without relocation; the reimplementation keeps
  // the trampoline but refuses to emit a jump-back when the copy would break.
  std::size_t offset = 0;
  while (offset < length) {
    const std::size_t size = instruction_length(code + offset, length - offset);
    if (size == 0) return true;
    const unsigned char* insn = code + offset;
    std::size_t i = 0;
    while (i < size) {
      const unsigned char b = insn[i];
      const bool prefix = b == 0xF0 || b == 0xF2 || b == 0xF3 || b == 0x2E ||
                          b == 0x36 || b == 0x3E || b == 0x26 || b == 0x64 ||
                          b == 0x65 || b == 0x66 || b == 0x67 ||
                          (b >= 0x40 && b <= 0x4F);
      if (!prefix) break;
      ++i;
    }
    if (i < size) {
      const unsigned char op = insn[i];
      if (op == 0xE8 || op == 0xE9 || op == 0xEB || (op >= 0x70 && op <= 0x7F)) {
        return true;
      }
      if (op == 0x0F && i + 1 < size && insn[i + 1] >= 0x80 && insn[i + 1] <= 0x8F) {
        return true;
      }
    }
    // RIP-relative operands resolve against the instruction's own address, so a
    // copy in the trampoline would read the wrong memory. The decoder reports
    // this precisely; a byte-pattern scan produced false positives (0x05/0x0D…
    // are also opcodes and immediates) and silently disabled the trampoline for
    // perfectly copyable prologues.
    bool rip_relative = false;
    if (instruction_info(insn, size, &rip_relative) == 0) return true;
    if (rip_relative) return true;
    offset += size;
  }
  return false;
}

class InlineHook final : public HookBackend {
 public:
  const char* name() const override { return "linux-inline-x86_64"; }

  bool install(HookInfo* info) override {
    if (info == nullptr || info->target == nullptr || info->detour == nullptr) return false;
    if (info->enabled) return true;

    const auto* code = static_cast<const unsigned char*>(info->target);
    std::size_t length = compute_patch_length(code, kPatchMin, 64);
    if (length == 0) {
      OICQ_LOGE("cannot decode %d bytes at %p", static_cast<int>(kPatchMin), info->target);
      return false;
    }
    if (length > kSavedCapacity) {
      OICQ_LOGE("patch length %zu exceeds saved capacity", length);
      return false;
    }
    std::memcpy(info->saved, code, length);
    info->length = static_cast<int>(length);

    if (!build_trampoline(info)) {
      OICQ_LOGW("trampoline unavailable; hook will use restore-and-call");
      info->trampoline = nullptr;
      info->trampoline_usable = 0;
    }
    // Fail closed: forwarding without a trampoline means restoring and
    // re-patching the entry point around every call, which corrupts code under
    // concurrent compiles (QQNT compiles several modules at once). Only an
    // explicit opt-in allows that mode.
    if (!info->trampoline_usable && std::getenv("OICQ_UNSAFE_HOOK") == nullptr) {
      OICQ_LOGE("target prologue is not relocatable (RIP-relative or undecodable); "
                "hook skipped. Set OICQ_UNSAFE_HOOK=1 to force restore-and-call.");
      if (info->trampoline != nullptr) {
        munmap(info->trampoline, static_cast<std::size_t>(info->length) + kAbsJumpSize);
        info->trampoline = nullptr;
      }
      return false;
    }
    if (!patch(info)) return false;
    info->enabled = 1;
    OICQ_LOGI("hook installed target=%p length=%zu trampoline=%p usable=%d",
               info->target, length, info->trampoline, info->trampoline_usable);
    return true;
  }

  bool disable(HookInfo* info) override {
    if (info == nullptr || !info->enabled) return false;
    if (!protect_range(info->target, static_cast<std::size_t>(info->length),
                       PROT_READ | PROT_WRITE | PROT_EXEC)) {
      OICQ_LOGE("mprotect RWX failed for %p", info->target);
      return false;
    }
    std::memcpy(info->target, info->saved, static_cast<std::size_t>(info->length));
    protect_range(info->target, static_cast<std::size_t>(info->length),
                  PROT_READ | PROT_EXEC);
    info->enabled = 0;
    return true;
  }

  bool enable(HookInfo* info) override {
    if (info == nullptr) return false;
    if (info->enabled) return true;
    if (!patch(info)) return false;
    info->enabled = 1;
    return true;
  }

  void release(HookInfo* info) override {
    if (info == nullptr) return;
    if (info->enabled) disable(info);
    if (info->trampoline != nullptr) {
      const std::size_t length = static_cast<std::size_t>(info->length) + kAbsJumpSize;
      munmap(info->trampoline, length);
      info->trampoline = nullptr;
    }
    *info = HookInfo{};
  }

 private:
  bool build_trampoline(HookInfo* info) {
    const std::size_t length = static_cast<std::size_t>(info->length);
    const std::size_t total = length + kAbsJumpSize;
    void* memory = mmap(nullptr, total, PROT_READ | PROT_WRITE | PROT_EXEC,
                        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (memory == MAP_FAILED) return false;
    std::memcpy(memory, info->saved, length);
    info->trampoline_usable = 0;
    if (!is_position_dependent(info->saved, length)) {
      unsigned char jump[kAbsJumpSize];
      encode_abs_jump(reinterpret_cast<std::uintptr_t>(info->target) + length, jump);
      std::memcpy(static_cast<unsigned char*>(memory) + length, jump, sizeof(jump));
      info->trampoline_usable = 1;
    } else {
      OICQ_LOGW("copied instructions are position dependent; trampoline left inert");
      std::memset(static_cast<unsigned char*>(memory) + length, 0xCC, kAbsJumpSize);
    }
    info->trampoline = memory;
    return true;
  }

  bool patch(HookInfo* info) {
    if (!protect_range(info->target, static_cast<std::size_t>(info->length),
                       PROT_READ | PROT_WRITE | PROT_EXEC)) {
      OICQ_LOGE("mprotect RWX failed for %p", info->target);
      return false;
    }
    unsigned char jump[kAbsJumpSize];
    encode_abs_jump(reinterpret_cast<std::uintptr_t>(info->detour), jump);
    std::memcpy(info->target, jump, sizeof(jump));
    protect_range(info->target, static_cast<std::size_t>(info->length),
                  PROT_READ | PROT_EXEC);
    return true;
  }
};

}  // namespace

HookBackend* default_hook_backend() {
  static InlineHook backend;
  return &backend;
}

}  // namespace oicq
