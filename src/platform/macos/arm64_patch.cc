// AArch64 instruction geometry.
//
// ref delegates the actual detour to Dobby (Mach-O import DobbyHook /
// DobbyDestroy). What it still owns is the selection of the source string and
// the splice, which is identical to Linux. This file only supplies the
// instruction-size contract used by compute_patch_length().

#include <cstddef>
#include <cstdint>

namespace oicq {

std::size_t instruction_length(const std::uint8_t* code, std::size_t limit) {
  if (code == nullptr || limit < 4) return 0;
  // AArch64 instructions are fixed-width 32-bit. A 16-byte absolute branch
  // (ldr x16, #8 ; br x16 ; .quad target) needs four slots, matching the
  // >= 14-byte contract of the x86-64 path.
  return 4;
}

}  // namespace oicq
