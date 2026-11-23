#if defined(__x86_64__) || defined(_M_X64)

// Minimal, fail-closed x86-64 instruction length decoder.
//
// ref ships its own table-driven decoder inline in the hook worker (ELF
// 0x35c5..0x3c0e, two jump tables at .rodata 0x5010 and 0x5118). It walks
// prefixes, ModRM/SIB/displacement and immediates and stops once it has
// covered at least 14 bytes. This file re-implements the same contract on top
// of explicit opcode knowledge: return whole-instruction lengths, and return 0
// for anything that is not understood so the caller can fail closed instead of
// patching a half-decoded instruction.

#include <cstddef>
#include <cstdint>

namespace oicq {
namespace {

struct Cursor {
  const std::uint8_t* p;
  std::size_t left;
  std::size_t used = 0;
  bool ok = true;

  bool has(std::size_t n) const { return left >= n; }
  std::uint8_t byte() {
    if (!has(1)) { ok = false; return 0; }
    ++used; --left; return *p++;
  }
  std::uint8_t peek(std::size_t n = 0) const {
    return (has(n + 1)) ? p[n] : 0;
  }
  void skip(std::size_t n) {
    if (!has(n)) { ok = false; left = 0; used += n; return; }
    p += n; left -= n; used += n;
  }
};

bool is_legacy_prefix(std::uint8_t b) {
  switch (b) {
    case 0xF0: case 0xF2: case 0xF3:
    case 0x2E: case 0x36: case 0x3E: case 0x26:
    case 0x64: case 0x65: case 0x66: case 0x67:
      return true;
    default:
      return false;
  }
}

struct Prefix {
  bool opsize16 = false;
  bool addrsize32 = false;
  bool rex_w = false;
  std::uint8_t rex = 0;
};

// Set by instruction_info() so a RIP-relative operand can be reported without
// threading an out-parameter through every decode helper. thread_local because
// several threads may be decoding at once.
thread_local bool* t_rip_relative = nullptr;

bool parse_modrm(Cursor* c, bool* rip_relative) {
  if (!c->has(1)) return false;
  const std::uint8_t modrm = c->byte();
  const int mod = modrm >> 6;
  const int rm = modrm & 7;
  if (mod == 3) return true;
  if (rm == 4) {
    if (!c->has(1)) return false;
    const std::uint8_t sib = c->byte();
    const int base = sib & 7;
    if (mod == 0 && base == 5) c->skip(4);
  } else if (mod == 0 && rm == 5) {
    if (rip_relative) *rip_relative = true;
    if (t_rip_relative) *t_rip_relative = true;
    c->skip(4);
  }
  if (mod == 1) c->skip(1);
  else if (mod == 2) c->skip(4);
  return c->ok;
}

// Continues ModRM decoding when the ModRM byte was already consumed.
bool parse_modrm_after(Cursor* c, std::uint8_t modrm) {
  const int mod = modrm >> 6;
  const int rm = modrm & 7;
  if (mod == 3) return true;
  if (rm == 4) {
    if (!c->has(1)) return false;
    const std::uint8_t sib = c->byte();
    if (mod == 0 && (sib & 7) == 5) c->skip(4);
  } else if (mod == 0 && rm == 5) {
    c->skip(4);
  }
  if (mod == 1) c->skip(1);
  else if (mod == 2) c->skip(4);
  return c->ok;
}

bool decode(std::uint8_t opcode, Cursor* c, const Prefix& prefix) {
  const bool w = prefix.rex_w;
  auto imm = [&](std::size_t n) { c->skip(n); };
  switch (opcode) {
    // ALU group: add/or/adc/sbb/and/sub/xor/cmp
    case 0x00: case 0x01: case 0x02: case 0x03:
    case 0x08: case 0x09: case 0x0A: case 0x0B:
    case 0x10: case 0x11: case 0x12: case 0x13:
    case 0x18: case 0x19: case 0x1A: case 0x1B:
    case 0x20: case 0x21: case 0x22: case 0x23:
    case 0x28: case 0x29: case 0x2A: case 0x2B:
    case 0x30: case 0x31: case 0x32: case 0x33:
    case 0x38: case 0x39: case 0x3A: case 0x3B:
    case 0x84: case 0x85: case 0x86: case 0x87:
    case 0x88: case 0x89: case 0x8A: case 0x8B:
    case 0x8C: case 0x8D: case 0x8E: case 0x8F:
    case 0x62: case 0x63:
    case 0xC0: case 0xC1:
    case 0xD0: case 0xD1: case 0xD2: case 0xD3:
    case 0xD8: case 0xD9: case 0xDA: case 0xDB:
    case 0xDC: case 0xDD: case 0xDE: case 0xDF:
    case 0xFE: case 0xFF:
      if (!parse_modrm(c, nullptr)) return false;
      if (opcode == 0xC0 || opcode == 0xC1) imm(1);
      return c->ok;

    case 0x04: case 0x0C: case 0x14: case 0x1C:
    case 0x24: case 0x2C: case 0x34: case 0x3C:
    case 0x6A: case 0xA8: case 0xB0: case 0xB1: case 0xB2:
    case 0xB3: case 0xB4: case 0xB5: case 0xB6: case 0xB7:
    case 0xC6: case 0xCD: case 0xE4: case 0xE5: case 0xE6: case 0xE7:
    case 0xEB:
      imm(1);
      return c->ok;

    case 0x05: case 0x0D: case 0x15: case 0x1D:
    case 0x25: case 0x2D: case 0x35: case 0x3D:
    case 0x68: case 0x69: case 0x81: case 0xA9: case 0xC7:
      if (opcode == 0x69 || opcode == 0x81 || opcode == 0xC7) {
        if (!parse_modrm(c, nullptr)) return false;
      }
      imm(prefix.opsize16 ? 2 : 4);
      return c->ok;

    case 0x6B: case 0x80: case 0x82: case 0x83:
    case 0xC2: case 0xCA:
      if (opcode == 0x6B || opcode == 0x80 || opcode == 0x82 || opcode == 0x83) {
        if (!parse_modrm(c, nullptr)) return false;
        imm(1);
      } else {
        imm(2);
      }
      return c->ok;

    case 0x06: case 0x07: case 0x0E: case 0x16: case 0x17:
    case 0x1E: case 0x1F: case 0x27: case 0x2F: case 0x37: case 0x3F:
    case 0x60: case 0x61: case 0x9A: case 0xCE:
      return false;  // invalid in long mode

    case 0x50: case 0x51: case 0x52: case 0x53:
    case 0x54: case 0x55: case 0x56: case 0x57:
    case 0x58: case 0x59: case 0x5A: case 0x5B:
    case 0x5C: case 0x5D: case 0x5E: case 0x5F:
    case 0x90: case 0x91: case 0x92: case 0x93:
    case 0x94: case 0x95: case 0x96: case 0x97:
    case 0x98: case 0x99: case 0x9B: case 0x9C: case 0x9D:
    case 0x9E: case 0x9F:
    case 0xA4: case 0xA5: case 0xA6: case 0xA7:
    case 0xAA: case 0xAB: case 0xAC: case 0xAD:
    case 0xAE: case 0xAF:
    case 0xC3: case 0xC9: case 0xCB: case 0xCC:
    case 0xCF: case 0xD6: case 0xD7:
    case 0xF1: case 0xF4: case 0xF5:
    case 0xF8: case 0xF9: case 0xFA: case 0xFB:
    case 0xFC: case 0xFD:
      return true;

    case 0x6C: case 0x6D: case 0x6E: case 0x6F:
      return true;

    case 0x70: case 0x71: case 0x72: case 0x73:
    case 0x74: case 0x75: case 0x76: case 0x77:
    case 0x78: case 0x79: case 0x7A: case 0x7B:
    case 0x7C: case 0x7D: case 0x7E: case 0x7F:
    case 0xE0: case 0xE1: case 0xE2: case 0xE3:
      imm(1);
      return c->ok;

    case 0xA0: case 0xA1: case 0xA2: case 0xA3:
      imm(prefix.addrsize32 ? 4 : 8);
      return c->ok;

    case 0xB8: case 0xB9: case 0xBA: case 0xBB:
    case 0xBC: case 0xBD: case 0xBE: case 0xBF:
      imm(w ? 8 : (prefix.opsize16 ? 2 : 4));
      return c->ok;

    case 0xC8:
      imm(3);
      return c->ok;

    case 0xE8: case 0xE9:
      imm(4);
      return c->ok;

    case 0xF6: case 0xF7: {
      if (!c->has(1)) return false;
      const std::uint8_t modrm = c->byte();
      if (!parse_modrm_after(c, modrm)) return false;
      const int reg = (modrm >> 3) & 7;
      if (reg <= 1) imm(opcode == 0xF6 ? 1 : (prefix.opsize16 ? 2 : 4));
      return c->ok;
    }

    case 0xC4: case 0xC5:
      return false;  // VEX-encoded; not decoded by ref either

    default:
      return false;
  }
}

bool decode_two_byte(std::uint8_t opcode, Cursor* c) {
  switch (opcode) {
    case 0x05: case 0x06: case 0x07: case 0x08: case 0x09:
    case 0x0B: case 0x0E:
    case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
    case 0x77: case 0xA2: case 0xAA:
      return true;

    case 0x0D:  // prefetchw: modrm
    case 0x18: case 0x19: case 0x1A: case 0x1B:
    case 0x1C: case 0x1D: case 0x1E: case 0x1F:
      return parse_modrm(c, nullptr);

    case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
    case 0x16: case 0x17:
    case 0x28: case 0x29: case 0x2A: case 0x2B: case 0x2C: case 0x2D:
    case 0x2E: case 0x2F:
    case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55:
    case 0x56: case 0x57:
    case 0x60: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65:
    case 0x66: case 0x67:
    case 0x6E: case 0x6F: case 0x70: case 0x71: case 0x72: case 0x73:
    case 0x74: case 0x75: case 0x76:
    case 0x7C: case 0x7D: case 0x7E: case 0x7F:
    case 0xA3: case 0xAB: case 0xAF: case 0xB2: case 0xB3:
    case 0xB4: case 0xB5: case 0xB6: case 0xB7:
    case 0xBA: case 0xBB: case 0xBC: case 0xBD:
    case 0xBE: case 0xBF:
    case 0xC0: case 0xC1: case 0xC7:
      if (!parse_modrm(c, nullptr)) return false;
      if (opcode == 0xBA) c->skip(1);
      return c->ok;

    case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45:
    case 0x46: case 0x47: case 0x48: case 0x49: case 0x4A: case 0x4B:
    case 0x4C: case 0x4D: case 0x4E: case 0x4F:
      return parse_modrm(c, nullptr);

    case 0x80: case 0x81: case 0x82: case 0x83:
    case 0x84: case 0x85: case 0x86: case 0x87:
    case 0x88: case 0x89: case 0x8A: case 0x8B:
    case 0x8C: case 0x8D: case 0x8E: case 0x8F:
      c->skip(4);
      return c->ok;

    case 0x90: case 0x91: case 0x92: case 0x93:
    case 0x94: case 0x95: case 0x96: case 0x97:
    case 0x98: case 0x99: case 0x9A: case 0x9B:
    case 0x9C: case 0x9D: case 0x9E: case 0x9F:
      return parse_modrm(c, nullptr);

    case 0xA4: case 0xAC:
      if (!parse_modrm(c, nullptr)) return false;
      c->skip(1);
      return c->ok;

    case 0xA5: case 0xAD:
      return parse_modrm(c, nullptr);

    case 0xB0: case 0xB1:
      if (!parse_modrm(c, nullptr)) return false;
      c->skip(1);
      return c->ok;

    case 0xC2: case 0xC4: case 0xC5: case 0xC6:
      return parse_modrm(c, nullptr);

    case 0xC8: case 0xC9: case 0xCA: case 0xCB:
    case 0xCC: case 0xCD: case 0xCE: case 0xCF:
      return true;

    default:
      return false;
  }
}

}  // namespace

std::size_t instruction_length(const std::uint8_t* code, std::size_t limit);

std::size_t instruction_info(const std::uint8_t* code, std::size_t limit,
                             bool* rip_relative) {
  bool* saved = t_rip_relative;
  bool flag = false;
  t_rip_relative = &flag;
  const std::size_t length = instruction_length(code, limit);
  t_rip_relative = saved;
  if (rip_relative != nullptr) *rip_relative = flag;
  return length;
}

std::size_t instruction_length(const std::uint8_t* code, std::size_t limit) {
  if (code == nullptr || limit == 0) return 0;
  Cursor c{code, limit};
  Prefix prefix;
  while (c.has(1)) {
    const std::uint8_t b = c.peek();
    if (is_legacy_prefix(b)) {
      if (b == 0x66) prefix.opsize16 = true;
      if (b == 0x67) prefix.addrsize32 = true;
      c.byte();
      continue;
    }
    if (b >= 0x40 && b <= 0x4F) {
      prefix.rex = b;
      prefix.rex_w = (b & 8) != 0;
      c.byte();
      continue;
    }
    break;
  }
  if (!c.has(1)) return 0;
  const std::uint8_t opcode = c.byte();
  bool ok = false;
  if (opcode == 0x0F) {
    if (!c.has(1)) return 0;
    const std::uint8_t op2 = c.byte();
    if (op2 == 0x38 || op2 == 0x3A) {
      // Three-byte map: every opcode takes ModRM; 0x3A adds imm8.
      if (!c.has(1)) return 0;
      c.byte();
      if (!parse_modrm(&c, nullptr)) return 0;
      if (op2 == 0x3A) c.skip(1);
      ok = c.ok;
    } else {
      ok = decode_two_byte(op2, &c);
    }
  } else {
    ok = decode(opcode, &c, prefix);
  }
  return ok && c.ok ? c.used : 0;
}

}  // namespace oicq

#endif  // x86-64
