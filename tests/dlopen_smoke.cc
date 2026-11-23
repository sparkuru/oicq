// Smoke test for the shipped shared object: dlopen without any V8 present,
// resolve the oicq entry points, and exercise the payload path in dry-run mode
// (no target process, no symbol resolution loop).

#include <dlfcn.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>

namespace {
int g_failures = 0;
void check(bool condition, const char* what) {
  std::printf("%s %s\n", condition ? "ok  " : "FAIL", what);
  if (!condition) ++g_failures;
}

bool exists(const std::string& path, long* size = nullptr) {
  struct stat info {};
  if (stat(path.c_str(), &info) != 0) return false;
  if (size != nullptr) *size = static_cast<long>(info.st_size);
  return true;
}

std::string read(const std::string& path) {
  std::ifstream file(path);
  return std::string((std::istreambuf_iterator<char>(file)),
                     std::istreambuf_iterator<char>());
}
}  // namespace

int main() {
  // The library auto-starts on load; this handler drives the payload path
  // manually, so opt out before dlopen.
  setenv("OICQ_AUTOINIT", "0", 1);
  void* handle = dlopen(OICQ_SO_PATH, RTLD_NOW | RTLD_LOCAL);
  if (handle == nullptr) {
    std::printf("FAIL dlopen: %s\n", dlerror());
    return 1;
  }
  check(dlsym(handle, "init") != nullptr, "init exported");
  check(dlsym(handle, "performHook") != nullptr, "performHook exported");
  check(dlsym(handle, "OicqCompileFunctionHook") != nullptr,
        "OicqCompileFunctionHook exported");
  check(dlsym(handle, "oicq_init") != nullptr, "oicq_init exported");

  char dir_template[] = "/tmp/oicq-smoke-XXXXXX";
  char* dir = mkdtemp(dir_template);
  if (dir == nullptr) {
    std::printf("FAIL mkdtemp\n");
    return 1;
  }
  setenv("OICQ_TEMP_DIR", dir, 1);
  setenv("OICQ_DRY_RUN", "1", 1);
  unsetenv("OICQ_RUNTIME");

  using Boot = void (*)();
  using EntryPath = const char* (*)();
  auto boot = reinterpret_cast<Boot>(dlsym(handle, "oicq_boot"));
  auto entry = reinterpret_cast<EntryPath>(dlsym(handle, "oicq_entry_path"));
  check(boot != nullptr && entry != nullptr, "boot + entry-path symbols resolvable");
  if (boot != nullptr) boot();

  const std::string payload_dir = std::string(dir) + "/oicq";
  long boot_size = 0;
  check(exists(payload_dir + "/boot.cjs", &boot_size) && boot_size > 1024,
        "host runtime written to <tmp>/oicq/boot.cjs");
  check(exists(payload_dir + "/renderer.js"), "renderer payload written");
  check(exists(payload_dir + "/protocol.js") && exists(payload_dir + "/minimal.cjs"),
        "protocol and minimal payloads written");
  const std::string entry_path = entry != nullptr ? entry() : "";
  check(entry_path == payload_dir + "/boot.cjs", "entry point is boot.cjs");
  check(read(payload_dir + "/boot.cjs").find("oicq host runtime") != std::string::npos,
        "boot.cjs carries the oicq runtime banner");
  check(read(payload_dir + "/renderer.js").find("oicq renderer UI") != std::string::npos,
        "renderer.js carries our own UI module");

  // OICQ_RUNTIME=minimal swaps the entry point to the loader stub.
  dlclose(handle);
  setenv("OICQ_RUNTIME", "minimal", 1);
  handle = dlopen(OICQ_SO_PATH, RTLD_NOW | RTLD_LOCAL);
  auto boot2 = reinterpret_cast<Boot>(dlsym(handle, "oicq_boot"));
  auto entry2 = reinterpret_cast<EntryPath>(dlsym(handle, "oicq_entry_path"));
  if (boot2 != nullptr) boot2();
  check(entry2 != nullptr && std::string(entry2()) == payload_dir + "/minimal.cjs",
        "OICQ_RUNTIME=minimal selects minimal.cjs");

  // Anchor spec overrides are accepted and logged without crashing the loader.
  dlclose(handle);
  unsetenv("OICQ_RUNTIME");
  setenv("OICQ_ANCHORS", "name=boot,length=62,marker=require(", 1);
  handle = dlopen(OICQ_SO_PATH, RTLD_NOW | RTLD_LOCAL);
  auto boot3 = reinterpret_cast<Boot>(dlsym(handle, "oicq_boot"));
  if (boot3 != nullptr) boot3();
  check(handle != nullptr, "custom anchor spec does not break boot");

  dlclose(handle);
  unsetenv("OICQ_ANCHORS");
  for (const char* name : {"boot.cjs", "renderer.js", "protocol.js", "minimal.cjs"}) {
    unlink((payload_dir + "/" + name).c_str());
  }
  rmdir(payload_dir.c_str());
  rmdir(dir);
  if (g_failures != 0) {
    std::printf("%d check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all smoke checks passed\n");
  return 0;
}
