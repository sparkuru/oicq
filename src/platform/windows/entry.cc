// Windows loader and bootstrap.
//
// QQ.exe loads dbghelp.dll from its own directory, so shipping an oicq build
// under that name gives us process-local V8/Node access without touching the
// Electron startup path. From there the flow is:
//
//   DllMain -> worker thread
//     -> install_export_shim(self, L"QQNT.dll")
//     -> resolve v8::Script::Compile / Run from QQNT.dll
//     -> for each QQ.exe renderer: manual_map(self) + install_renderer_bridge
//
// The main process then serves runtime/renderer.js to every renderer over the
// oicq:* IPC channels (see renderer_bridge.cc).

#include <windows.h>

#include <string>
#include <vector>

#include "oicq/config.h"
#include "oicq/log.h"
#include "oicq/resource.h"

namespace oicq {

std::size_t install_export_shim(HMODULE self, const wchar_t* target_module);
bool install_renderer_bridge(HMODULE qqnt);
bool manual_map(DWORD pid, const wchar_t* dll_path, void** remote_base);
std::vector<DWORD> list_process_ids(const wchar_t* exe_name);

namespace {

HMODULE g_self = nullptr;

std::wstring module_path(HMODULE module) {
  wchar_t buffer[MAX_PATH * 2];
  const DWORD length = GetModuleFileNameW(module, buffer, MAX_PATH * 2);
  return std::wstring(buffer, length);
}

bool exe_is_qq() {
  const std::wstring path = module_path(nullptr);
  const std::wstring::size_type slash = path.find_last_of(L"\\/");
  const std::wstring name = slash == std::wstring::npos ? path : path.substr(slash + 1);
  return _wcsicmp(name.c_str(), L"QQ.exe") == 0;
}

bool has_arg(const wchar_t* needle) {
  const std::wstring command = GetCommandLineW();
  return command.find(needle) != std::wstring::npos;
}

DWORD WINAPI worker(LPVOID) {
  if (!exe_is_qq()) {
    OICQ_LOGD("skip: host is not QQ.exe");
    return 0;
  }
  // Main and renderer are told apart by Chromium's process switch: the main
  // process has no --type=.
  if (has_arg(L"--type=")) {
    OICQ_LOGD("renderer process: only the bridge is installed");
    install_renderer_bridge(GetModuleHandleW(L"QQNT.dll"));
    return 0;
  }

  const std::size_t patched = install_export_shim(g_self, L"QQNT.dll");
  OICQ_LOGI("export shim patched %zu entries", patched);

  const std::wstring self_path = module_path(g_self);
  for (DWORD pid : list_process_ids(L"QQ.exe")) {
    if (pid == GetCurrentProcessId()) continue;
    void* base = nullptr;
    if (manual_map(pid, self_path.c_str(), &base)) {
      OICQ_LOGI("injected into pid %lu at %p", pid, base);
    }
  }
  return 0;
}

}  // namespace

void start() {
  HANDLE thread = CreateThread(nullptr, 0, worker, nullptr, 0, nullptr);
  if (thread != nullptr) CloseHandle(thread);
}

}  // namespace oicq

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
  (void)reserved;
  switch (reason) {
    case DLL_PROCESS_ATTACH:
      oicq::g_self = instance;
      DisableThreadLibraryCalls(instance);
      oicq::start();
      break;
    case DLL_PROCESS_DETACH:
      break;
    default:
      break;
  }
  return TRUE;
}

extern "C" __declspec(dllexport) void oicq_init() { oicq::start(); }

extern "C" __declspec(dllexport) std::size_t oicq_export_shim(const wchar_t* module) {
  return oicq::install_export_shim(oicq::g_self, module);
}
