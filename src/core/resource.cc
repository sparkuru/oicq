#include "oicq/resource.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>

#ifdef _WIN32
#include <direct.h>
#include <windows.h>
#else
#include <sys/stat.h>
#include <sys/types.h>
#endif

#include "oicq/log.h"

namespace oicq {
namespace {

std::string temp_directory() {
  const char* candidates[] = {"TMPDIR", "TMP", "TEMP"};
  for (const char* name : candidates) {
    const char* value = std::getenv(name);
    if (value != nullptr && value[0] != '\0') return std::string(value);
  }
#ifdef _WIN32
  char buffer[MAX_PATH];
  DWORD n = GetTempPathA(MAX_PATH, buffer);
  if (n > 0 && n < MAX_PATH) {
    std::string out(buffer, n);
    while (!out.empty() && (out.back() == '\\' || out.back() == '/')) out.pop_back();
    return out;
  }
  return "C:\\Windows\\Temp";
#else
  return "/tmp";
#endif
}

std::string join_path(const std::string& dir, const std::string& name) {
  if (dir.empty()) return name;
  char last = dir.back();
  if (last == '/' || last == '\\') return dir + name;
#ifdef _WIN32
  return dir + "\\" + name;
#else
  return dir + "/" + name;
#endif
}

// Creates `dir` (one level). An existing directory counts as success.
bool ensure_directory(const std::string& dir) {
  if (dir.empty()) return true;
#ifdef _WIN32
  const int rc = _mkdir(dir.c_str());
#else
  const int rc = mkdir(dir.c_str(), 0700);
#endif
  if (rc == 0) return true;
  return errno == EEXIST;
}

bool write_file(const std::string& path, const EmbeddedFile& file) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out) {
    OICQ_LOGE("cannot open %s for writing", path.c_str());
    return false;
  }
  out.write(reinterpret_cast<const char*>(file.data),
            static_cast<std::streamsize>(file.size));
  out.close();
  if (!out) {
    OICQ_LOGE("short write to %s", path.c_str());
    return false;
  }
  OICQ_LOGD("wrote %s (%zu bytes)", path.c_str(), file.size);
  return true;
}

}  // namespace

const EmbeddedFile* entry_file(const Options& options) {
  const char* wanted = options.runtime == "minimal" ? "minimal.cjs" : "boot.cjs";
  const EmbeddedFile* files = embedded_files();
  const std::size_t count = embedded_file_count();
  for (std::size_t i = 0; i < count; ++i) {
    if (std::strcmp(files[i].name, wanted) == 0) return &files[i];
  }
  if (count == 0) {
    OICQ_LOGE("no embedded runtime files");
    return nullptr;
  }
  OICQ_LOGW("%s missing from the payload; falling back to %s", wanted, files[0].name);
  return &files[0];
}

std::string materialise_runtime(const Options& options) {
  const EmbeddedFile* entry = entry_file(options);
  if (entry == nullptr) return {};

  std::string dir = options.temp_dir;
  if (dir.empty()) dir = temp_directory();
  if (!options.temp_subdir.empty()) {
    const std::string sub = join_path(dir, options.temp_subdir);
    if (!ensure_directory(sub)) {
      OICQ_LOGE("cannot create %s", sub.c_str());
      return {};
    }
    dir = sub;
  }

  const EmbeddedFile* files = embedded_files();
  const std::size_t count = embedded_file_count();
  for (std::size_t i = 0; i < count; ++i) {
    const std::string path = join_path(dir, files[i].name);
    if (!write_file(path, files[i])) return {};
  }
  return join_path(dir, entry->name);
}

std::string build_inject_expression(const Options& options, const std::string& path) {
  std::string tmpl = options.inject_template;
  if (tmpl.empty()) {
#if defined(__APPLE__)
    tmpl = "void 0===globalThis.__oicq__&&(function(){try{"
           "eval(require('fs').readFileSync('{path}','utf8'))"
           "}catch(e){console.error('[oicq]',e)}})();";
#else
    tmpl = "void 0===globalThis.__oicq__&&(function(){try{"
           "return require('{path}')"
           "}catch(e){console.error('[oicq]',e)}})();";
#endif
  }
  std::string out;
  out.reserve(tmpl.size() + path.size());
  for (std::size_t i = 0; i < tmpl.size(); ++i) {
    if (tmpl.compare(i, 6, "{path}") == 0) {
      out += path;
      i += 5;
    } else {
      out += tmpl[i];
    }
  }
  return out;
}

}  // namespace oicq
