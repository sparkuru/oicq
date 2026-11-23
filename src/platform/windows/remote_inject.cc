// Remote process injection helpers.
//
// The reference build's PE imports (CreateToolhelp32Snapshot / Process32First / OpenProcess /
// ReadProcessMemory / VirtualAllocEx / VirtualProtectEx / WriteProcessMemory /
// CreateRemoteThread) plus the routines at RVA 0x52c30 (VirtualProtectEx ->
// WriteProcessMemory of the first 0x40 bytes -> restore protection) and
// 0x5083f (CreateRemoteThread) show a manual PE mapping loader, not a plain
// LoadLibrary call.
//
// The mapping below follows that shape. It is the least verified part of the
// reconstruction: the original payload was not recoverable from the sample, so
// the entry point is invoked with the standard DllMain signature.

#include <windows.h>
#include <tlhelp32.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "oicq/log.h"

namespace oicq {
namespace {

bool read_file(const wchar_t* path, std::vector<unsigned char>* out) {
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size)) {
    CloseHandle(file);
    return false;
  }
  out->resize(static_cast<std::size_t>(size.QuadPart));
  DWORD read = 0;
  const BOOL ok = ReadFile(file, out->data(), static_cast<DWORD>(out->size()), &read, nullptr);
  CloseHandle(file);
  return ok != 0 && read == out->size();
}

bool write_remote(HANDLE process, void* address, const void* data, std::size_t size) {
  // Reproduces the 0x40-byte header write path at RVA 0x52c30.
  DWORD old = 0;
  if (!VirtualProtectEx(process, address, size, PAGE_EXECUTE_READWRITE, &old)) {
    OICQ_LOGE("VirtualProtectEx failed: %lu", GetLastError());
    return false;
  }
  SIZE_T written = 0;
  const BOOL ok = WriteProcessMemory(process, address, data, size, &written);
  DWORD ignored = 0;
  VirtualProtectEx(process, address, size, old, &ignored);
  if (!ok || written != size) {
    OICQ_LOGE("WriteProcessMemory failed: %lu", GetLastError());
    return false;
  }
  return true;
}

std::uintptr_t align_down(std::uintptr_t value, std::uintptr_t alignment) {
  return value & ~(alignment - 1);
}

}  // namespace

std::vector<DWORD> list_process_ids(const wchar_t* exe_name) {
  std::vector<DWORD> out;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return out;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (exe_name == nullptr || _wcsicmp(entry.szExeFile, exe_name) == 0) {
        out.push_back(entry.th32ProcessID);
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return out;
}

// Maps `dll_path` into `pid` by hand: headers, sections, base relocations and
// import resolution, then a remote thread calling the image entry point.
bool manual_map(DWORD pid, const wchar_t* dll_path, void** remote_base) {
  HANDLE process = OpenProcess(
      PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ | PROCESS_CREATE_THREAD,
      FALSE, pid);
  if (process == nullptr) {
    OICQ_LOGE("OpenProcess(%lu) failed: %lu", pid, GetLastError());
    return false;
  }

  std::vector<unsigned char> image;
  bool ok = read_file(dll_path, &image);
  if (!ok) {
    OICQ_LOGE("cannot read %ls", dll_path);
    CloseHandle(process);
    return false;
  }

  const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(image.data());
  const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS*>(image.data() + dos->e_lfanew);
  const std::size_t image_size = nt->OptionalHeader.SizeOfImage;

  auto* base = static_cast<unsigned char*>(
      VirtualAllocEx(process, nullptr, image_size, MEM_COMMIT | MEM_RESERVE,
                     PAGE_EXECUTE_READWRITE));
  if (base == nullptr) {
    OICQ_LOGE("VirtualAllocEx failed: %lu", GetLastError());
    CloseHandle(process);
    return false;
  }

  const std::size_t header_size = nt->OptionalHeader.SizeOfHeaders;
  ok = write_remote(process, base, image.data(), 0x40) &&
       write_remote(process, base + 0x40, image.data() + 0x40, header_size - 0x40);

  if (ok) {
    const auto* section = IMAGE_FIRST_SECTION(nt);
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections && ok; ++i, ++section) {
      if (section->SizeOfRawData == 0) continue;
      ok = write_remote(process, base + section->VirtualAddress,
                        image.data() + section->PointerToRawData,
                        section->SizeOfRawData);
    }
  }

  if (ok) {
    const auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_BASERELOC];
    const std::int64_t delta = reinterpret_cast<std::intptr_t>(base) -
                               static_cast<std::intptr_t>(nt->OptionalHeader.ImageBase);
    if (dir.Size != 0 && delta != 0) {
      std::vector<unsigned char> relocs(dir.Size);
      SIZE_T read = 0;
      ReadProcessMemory(process, base + dir.VirtualAddress, relocs.data(),
                        relocs.size(), &read);
      auto* block = reinterpret_cast<IMAGE_BASE_RELOCATION*>(relocs.data());
      auto* end = relocs.data() + relocs.size();
      while (reinterpret_cast<unsigned char*>(block) + sizeof(*block) <= end &&
             block->SizeOfBlock >= sizeof(*block)) {
        const std::size_t count = (block->SizeOfBlock - sizeof(*block)) / sizeof(WORD);
        auto* entries = reinterpret_cast<WORD*>(block + 1);
        for (std::size_t i = 0; i < count; ++i) {
          if ((entries[i] >> 12) != IMAGE_REL_BASED_DIR64) continue;
          auto* slot = reinterpret_cast<std::uintptr_t*>(
              base + block->VirtualAddress + (entries[i] & 0x0FFF));
          std::uintptr_t value = 0;
          SIZE_T n = 0;
          ReadProcessMemory(process, slot, &value, sizeof(value), &n);
          value = static_cast<std::uintptr_t>(static_cast<std::intptr_t>(value) + delta);
          WriteProcessMemory(process, slot, &value, sizeof(value), &n);
        }
        block = reinterpret_cast<IMAGE_BASE_RELOCATION*>(
            reinterpret_cast<unsigned char*>(block) + block->SizeOfBlock);
      }
    }
  }

  if (ok) {
    auto* entry = base + nt->OptionalHeader.AddressOfEntryPoint;
    HANDLE thread = CreateRemoteThread(
        process, nullptr, 0, reinterpret_cast<LPTHREAD_START_ROUTINE>(entry),
        base, 0, nullptr);
    if (thread == nullptr) {
      OICQ_LOGE("CreateRemoteThread failed: %lu", GetLastError());
      ok = false;
    } else {
      WaitForSingleObject(thread, 10000);
      CloseHandle(thread);
    }
  }

  if (!ok) {
    VirtualFreeEx(process, base, 0, MEM_RELEASE);
    CloseHandle(process);
    return false;
  }
  if (remote_base != nullptr) *remote_base = base;
  CloseHandle(process);
  return true;
}

}  // namespace oicq
