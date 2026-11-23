// Export-table shim.
//
// dbghelp.dll (5,396,480 bytes, image base 0x180000000, export directory named
// better-qqnt-x64.dll) exports 3,402 names: the complete dbghelp surface plus
// the Node/V8/v8_inspector/cppgc API. The routine at RVA 0x4f230 walks its own
// export directory, resolves every name in QQNT.dll and, when the addresses
// differ, makes the target page writable and overwrites the target prologue
// with a jump into this module (VirtualProtect at 0x4f2fd).
//
// That is what lets the injected addon link against this module while the real
// implementations live in QQNT.dll.

#include <windows.h>

#include <cstdint>
#include <cstring>
#include <string>

#include "oicq/log.h"

namespace oicq {
namespace {

struct ExportEntry {
  std::string name;
  void* address;
};

const IMAGE_EXPORT_DIRECTORY* export_directory(HMODULE module) {
  const auto* base = reinterpret_cast<const unsigned char*>(module);
  const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
  if (dos->e_magic != IMAGE_DOS_SIGNATURE) return nullptr;
  const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS*>(base + dos->e_lfanew);
  if (nt->Signature != IMAGE_NT_SIGNATURE) return nullptr;
  const auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
  if (dir.VirtualAddress == 0) return nullptr;
  return reinterpret_cast<const IMAGE_EXPORT_DIRECTORY*>(base + dir.VirtualAddress);
}

std::size_t collect_exports(HMODULE module, ExportEntry* out, std::size_t capacity) {
  const auto* base = reinterpret_cast<const unsigned char*>(module);
  const IMAGE_EXPORT_DIRECTORY* dir = export_directory(module);
  if (dir == nullptr || out == nullptr) return 0;
  const auto* names = reinterpret_cast<const DWORD*>(base + dir->AddressOfNames);
  const auto* ordinals = reinterpret_cast<const WORD*>(base + dir->AddressOfNameOrdinals);
  const auto* functions = reinterpret_cast<const DWORD*>(base + dir->AddressOfFunctions);
  std::size_t count = 0;
  for (DWORD i = 0; i < dir->NumberOfNames && count < capacity; ++i) {
    const char* name = reinterpret_cast<const char*>(base + names[i]);
    const DWORD rva = functions[ordinals[i]];
    if (rva == 0) continue;
    out[count].name = name;
    out[count].address = const_cast<unsigned char*>(base) + rva;
    ++count;
  }
  return count;
}

bool patch_jump(void* target, void* destination) {
  // mov rax, imm64 ; jmp rax  (12 bytes, padded to 16)
  unsigned char code[16];
  code[0] = 0x48;
  code[1] = 0xB8;
  const auto address = reinterpret_cast<std::uintptr_t>(destination);
  std::memcpy(code + 2, &address, sizeof(address));
  code[10] = 0xFF;
  code[11] = 0xE0;
  std::memset(code + 12, 0x90, 4);

  DWORD old_protect = 0;
  if (!VirtualProtect(target, sizeof(code), PAGE_EXECUTE_READWRITE, &old_protect)) {
    return false;
  }
  std::memcpy(target, code, sizeof(code));
  FlushInstructionCache(GetCurrentProcess(), target, sizeof(code));
  DWORD ignored = 0;
  VirtualProtect(target, sizeof(code), old_protect, &ignored);
  return true;
}

}  // namespace

// Mirrors the ref loop: every export of this module that also exists in
// `target_module` is redirected to this module's implementation.
std::size_t install_export_shim(HMODULE self, const wchar_t* target_module) {
  HMODULE target = GetModuleHandleW(target_module);
  if (target == nullptr) {
    OICQ_LOGE("target module missing");
    return 0;
  }
  static ExportEntry entries[4096];
  const std::size_t count = collect_exports(self, entries, 4096);
  std::size_t patched = 0;
  for (std::size_t i = 0; i < count; ++i) {
    void* remote = reinterpret_cast<void*>(
        GetProcAddress(target, entries[i].name.c_str()));
    if (remote == nullptr || remote == entries[i].address) continue;
    if (patch_jump(remote, entries[i].address)) ++patched;
  }
  OICQ_LOGI("export shim: %zu/%zu entries redirected", patched, count);
  return patched;
}

}  // namespace oicq
