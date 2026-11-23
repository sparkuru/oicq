#include "oicq/hook_backend.h"

#include <cstring>

namespace oicq {

#if defined(__x86_64__) || defined(_M_X64)
void encode_abs_jump(std::uintptr_t destination, unsigned char out[kAbsJumpSize]) {
  out[0] = 0xFF;
  out[1] = 0x25;
  std::memset(out + 2, 0, 4);
  std::memcpy(out + 6, &destination, sizeof(destination));
}
#endif

std::size_t compute_patch_length(const unsigned char* code, std::size_t minimum,
                                 std::size_t limit) {
  std::size_t total = 0;
  while (total < minimum) {
    const std::size_t length = instruction_length(code + total, limit - total);
    if (length == 0) return 0;
    total += length;
    if (total > kSavedCapacity) return 0;
  }
  return total;
}

}  // namespace oicq
