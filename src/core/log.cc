#include "oicq/log.h"

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace oicq {
namespace {
LogLevel g_level = LogLevel::kInfo;
bool g_initialized = false;
}  // namespace

void log_set_level(LogLevel level) { g_level = level; }

LogLevel log_level() {
  if (!g_initialized) {
    g_initialized = true;
    const char* env = std::getenv("OICQ_LOG");
    if (env != nullptr) {
      if (std::strcmp(env, "error") == 0) g_level = LogLevel::kError;
      else if (std::strcmp(env, "warn") == 0) g_level = LogLevel::kWarn;
      else if (std::strcmp(env, "debug") == 0) g_level = LogLevel::kDebug;
      else g_level = LogLevel::kInfo;
    }
  }
  return g_level;
}

void log_message(LogLevel level, const char* fmt, ...) {
  if (static_cast<int>(level) > static_cast<int>(log_level())) return;
  static const char* kTag[] = {"E", "W", "I", "D"};
  std::fprintf(stderr, "[oicq/%s] ", kTag[static_cast<int>(level)]);
  va_list args;
  va_start(args, fmt);
  std::vfprintf(stderr, fmt, args);
  va_end(args);
  std::fputc('\n', stderr);
}

}  // namespace oicq
