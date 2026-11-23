#ifndef OICQ_LOG_H
#define OICQ_LOG_H

namespace oicq {

enum class LogLevel { kError = 0, kWarn = 1, kInfo = 2, kDebug = 3 };

void log_set_level(LogLevel level);
LogLevel log_level();
void log_message(LogLevel level, const char* fmt, ...);

}  // namespace oicq

#define OICQ_LOGE(...) ::oicq::log_message(::oicq::LogLevel::kError, __VA_ARGS__)
#define OICQ_LOGW(...) ::oicq::log_message(::oicq::LogLevel::kWarn, __VA_ARGS__)
#define OICQ_LOGI(...) ::oicq::log_message(::oicq::LogLevel::kInfo, __VA_ARGS__)
#define OICQ_LOGD(...) ::oicq::log_message(::oicq::LogLevel::kDebug, __VA_ARGS__)

#endif  // OICQ_LOG_H
