#ifndef OICQ_HOOK_BACKEND_H
#define OICQ_HOOK_BACKEND_H

#include <cstddef>
#include <cstdint>

namespace oicq {

// Mirrors the reference _HookInformation (ELF symbol CompileFunctionHookInfo, 64
// bytes): int enabled; int length; uint8 saved[32]; void* target;
// void* detour; void* trampoline.
struct HookInfo {
  int enabled = 0;
  int length = 0;
  unsigned char saved[32] = {};
  void* target = nullptr;
  void* detour = nullptr;
  void* trampoline = nullptr;
  // 1 when `trampoline` can be called as the original function. A trampoline
  // that copies position-dependent instructions is allocated but left inert
  // (int3 padding); calling it would fault, so backends must clear this flag.
  int trampoline_usable = 0;
};

constexpr std::size_t kPatchMin = 14;   // 14-byte absolute indirect jump
constexpr std::size_t kSavedCapacity = sizeof(HookInfo::saved);

class HookBackend {
 public:
  virtual ~HookBackend() = default;
  virtual const char* name() const = 0;
  // Claims `length` bytes at target (>= kPatchMin) and installs the detour.
  virtual bool install(HookInfo* info) = 0;
  // Restores the saved bytes and clears `enabled`.
  virtual bool disable(HookInfo* info) = 0;
  // Re-installs the detour using the bytes in `info->saved`.
  virtual bool enable(HookInfo* info) = 0;
  virtual void release(HookInfo* info) = 0;
};

// x86-64 encoding used by ref: FF 25 00 00 00 00 <abs64>.
constexpr std::size_t kAbsJumpSize = 14;

// Fills `out` with the absolute indirect jump to `destination`.
void encode_abs_jump(std::uintptr_t destination, unsigned char out[kAbsJumpSize]);

// Platform default backend (inline x86-64 on Linux/Windows, Dobby on macOS).
HookBackend* default_hook_backend();

// Number of bytes that must be copied to cover at least `minimum` bytes,
// decoding whole instructions. Returns 0 when decoding fails.
std::size_t compute_patch_length(const unsigned char* code, std::size_t minimum,
                                 std::size_t limit);

// Single-instruction length in bytes, 0 on unknown/unsupported encoding.
std::size_t instruction_length(const unsigned char* code, std::size_t limit);

// Same decode, additionally reporting whether the instruction addresses memory
// relative to RIP. Such an instruction cannot be copied into a trampoline
// without relocation.
std::size_t instruction_info(const unsigned char* code, std::size_t limit,
                             bool* rip_relative);

}  // namespace oicq

#endif  // OICQ_HOOK_BACKEND_H
