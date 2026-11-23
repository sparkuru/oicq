#include "oicq/config.h"

#include <cstdlib>
#include <cstring>

namespace oicq {

// Both names are the same v8::ScriptCompiler::CompileFunction symbol; the
// leading underscore is the Mach-O export convention.
const char kMangledCompileFunctionLinux[] =
    "_ZN2v814ScriptCompiler15CompileFunctionENS_5LocalINS_7ContextEEEPNS0_6"
    "SourceEmPNS1_INS_6StringEEEmPNS1_INS_6ObjectEEENS0_14CompileOptionsENS0_"
    "13NoCacheReasonE";
const char kMangledCompileFunctionMac[] =
    "__ZN2v814ScriptCompiler15CompileFunctionENS_5LocalINS_7ContextEEEPNS0_6"
    "SourceEmPNS1_INS_6StringEEEmPNS1_INS_6ObjectEEENS0_14CompileOptionsENS0_"
    "13NoCacheReasonE";

// Windows uses the decorated MSVC names observed in the PE export table of
// QQNT.dll (0x1801f183b / 0x1801f18b7).
const char kMangledScriptCompileWindows[] =
    "?Compile@Script@v8@@SA?AV?$MaybeLocal@VScript@v8@@@2@V?$Local@VContext@v8@@@2@"
    "V?$Local@VString@v8@@@2@PEAVScriptOrigin@2@@Z";
const char kMangledScriptRunWindows[] =
    "?Run@Script@v8@@QEAA?AV?$MaybeLocal@VValue@v8@@@2@V?$Local@VContext@v8@@@2@"
    "V?$Local@VData@v8@@@2@@Z";

// Exported by the fixed target (QQ 3.2.18-37012); verified in .dynsym.
const char kMangledIsolateGetCurrent[] = "_ZN2v87Isolate10GetCurrentEv";
const char kMangledStringNewFromUtf8[] =
    "_ZN2v86String11NewFromUtf8EPNS_7IsolateEPKcNS_13NewStringTypeEi";
const char kMangledStringConcat[] =
    "_ZN2v86String6ConcatEPNS_7IsolateENS_5LocalIS0_EES4_";

std::vector<AnchorSpec> default_anchors() {
  AnchorSpec boot;
  boot.name = "qqnt-boot";
  boot.length = kBootstrapLength;
  return {boot};
}

namespace {

std::string trim(const std::string& in) {
  const char* whitespace = " \t\r\n";
  const std::size_t first = in.find_first_not_of(whitespace);
  if (first == std::string::npos) return {};
  const std::size_t last = in.find_last_not_of(whitespace);
  return in.substr(first, last - first + 1);
}

// 自己解析：glibc 2.38 起 std::strtol 会走 __isoc23_strtol，把最低 glibc 要求
// 抬到 2.38；分发包要兼容 2.34，所以这里只保留 "十进制 / 0x 十六进制 / 0 八进制"。
bool parse_int(const std::string& text, int* out) {
  const char* p = text.c_str();
  int base = 10;
  if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) {
    base = 16;
    p += 2;
  } else if (p[0] == '0' && p[1] != '\0') {
    base = 8;
    p += 1;
  }
  long value = 0;
  bool any = false;
  for (;; ++p) {
    int digit = -1;
    if (*p >= '0' && *p <= '9') digit = *p - '0';
    else if (*p >= 'a' && *p <= 'f') digit = *p - 'a' + 10;
    else if (*p >= 'A' && *p <= 'F') digit = *p - 'A' + 10;
    if (digit < 0 || digit >= base) break;
    value = value * base + digit;
    any = true;
  }
  if (!any || *p != '\0' || value <= 0 || value > 64 * 1024 * 1024) return false;
  *out = static_cast<int>(value);
  return true;
}

}  // namespace

// Accepted grammar:
//   "62"                                  single length, generated name
//   "62,71"                               several lengths
//   "name=boot,length=62"                 named anchor
//   "name=boot,length=62,marker=require(" named anchor with a literal marker
// Entries are separated by ';' or ',' only when they are bare lengths.
std::vector<AnchorSpec> parse_anchor_spec(const std::string& spec) {
  std::vector<AnchorSpec> anchors;
  std::size_t start = 0;
  while (start <= spec.size()) {
    std::size_t end = spec.find(';', start);
    if (end == std::string::npos) end = spec.size();
    const std::string entry = trim(spec.substr(start, end - start));
    start = end + 1;
    if (entry.empty()) continue;

    AnchorSpec anchor;
    if (entry.find('=') == std::string::npos) {
      // Bare lengths, possibly comma separated.
      std::size_t item_start = 0;
      while (item_start <= entry.size()) {
        std::size_t item_end = entry.find(',', item_start);
        if (item_end == std::string::npos) item_end = entry.size();
        const std::string item = trim(entry.substr(item_start, item_end - item_start));
        item_start = item_end + 1;
        if (item.empty()) continue;
        AnchorSpec bare;
        if (!parse_int(item, &bare.length)) return {};
        bare.name = "len-" + std::to_string(bare.length);
        anchors.push_back(bare);
      }
      continue;
    }

    std::size_t field_start = 0;
    while (field_start <= entry.size()) {
      std::size_t field_end = entry.find(',', field_start);
      if (field_end == std::string::npos) field_end = entry.size();
      const std::string field = entry.substr(field_start, field_end - field_start);
      field_start = field_end + 1;
      const std::size_t eq = field.find('=');
      if (eq == std::string::npos) return {};
      const std::string key = trim(field.substr(0, eq));
      const std::string value = trim(field.substr(eq + 1));
      if (key == "name") {
        anchor.name = value;
      } else if (key == "length" || key == "len") {
        if (!parse_int(value, &anchor.length)) return {};
      } else if (key == "marker") {
        anchor.marker = value;
      } else {
        return {};
      }
    }
    if (anchor.length <= 0) return {};
    if (anchor.name.empty()) anchor.name = "len-" + std::to_string(anchor.length);
    anchors.push_back(anchor);
  }
  return anchors;
}

Options options_from_env() {
  Options options;
  if (const char* runtime = std::getenv("OICQ_RUNTIME")) {
    if (runtime[0] != '\0') options.runtime = runtime;
  }
  if (const char* temp_dir = std::getenv("OICQ_TEMP_DIR")) {
    if (temp_dir[0] != '\0') options.temp_dir = temp_dir;
  }
  if (const char* anchors = std::getenv("OICQ_ANCHORS")) {
    const std::vector<AnchorSpec> parsed = parse_anchor_spec(anchors);
    if (!parsed.empty()) options.anchors = parsed;
  }
  if (const char* max_hits = std::getenv("OICQ_MAX_HITS")) {
    int value = 0;
    if (parse_int(max_hits, &value)) options.max_hits = value;
  }
  if (const char* safe = std::getenv("OICQ_INPLACE_SPLICE")) {
    if (std::strcmp(safe, "1") == 0) options.safe_splice = false;
  }
  return options;
}

}  // namespace oicq
