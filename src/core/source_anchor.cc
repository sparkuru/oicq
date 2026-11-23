#include "oicq/source_anchor.h"

#include <cstdio>
#include <cstring>

#include "oicq/source_splice.h"

#if defined(__linux__)
#include <sys/uio.h>
#include <unistd.h>
#endif

namespace oicq {
namespace {

// A CompileFunction argument is not guaranteed to be the module we assume: the
// same symbol is used for bootstrap scripts, cached-data rebuilds and shutdown
// paths, and their Source strings can be two-byte strings or already-freed
// buffers. Reading such a pointer is a hard segfault, so candidate reads are
// probed with process_vm_readv first (it returns EFAULT instead of dying) and
// every candidate is length-filtered before any byte is touched.
constexpr int32_t kMaxSource = 1024 * 1024;

bool readable(const char* data, std::size_t size) {
#if defined(__linux__)
  struct iovec local {};
  struct iovec remote {};
  local.iov_base = const_cast<char*>(data);
  local.iov_len = size;
  remote.iov_base = const_cast<char*>(data);
  remote.iov_len = size;
  const ssize_t read = process_vm_readv(getpid(), &local, 1, &remote, 1, 0);
  return read == static_cast<ssize_t>(size);
#else
  // No portable probe outside Linux; callers only get here after the length
  // filter, which keeps the exposure to a single candidate size.
  return data != nullptr;
#endif
}

std::uint64_t fnv1a(const char* data, std::size_t size) {
  std::uint64_t hash = 1469598103934665603ULL;
  for (std::size_t i = 0; i < size; ++i) {
    hash ^= static_cast<unsigned char>(data[i]);
    hash *= 1099511628211ULL;
  }
  return hash;
}

bool inspect_checked(void* source, SourceView* view, int32_t* length) {
  if (!inspect_source(source, view)) return false;
  const int32_t value = *view->length;
  if (value <= 0 || value > kMaxSource) return false;
  *length = value;
  return true;
}

}  // namespace

bool source_text(void* source, std::string* out) {
  SourceView view;
  int32_t length = 0;
  if (out == nullptr || !inspect_checked(source, &view, &length)) return false;
  if (!readable(view.data, static_cast<std::size_t>(length))) return false;
  out->assign(view.data, static_cast<std::size_t>(length));
  return true;
}

std::string source_fingerprint(void* source) {
  SourceView view;
  int32_t length = 0;
  if (!inspect_checked(source, &view, &length)) return "?";
  const std::size_t hashed = length < 96 ? static_cast<std::size_t>(length) : 96;
  if (!readable(view.data, hashed)) return "?";
  char buffer[32];
  std::snprintf(buffer, sizeof(buffer), "%d/%016llx", length,
                static_cast<unsigned long long>(fnv1a(view.data, hashed)));
  return buffer;
}

int match_anchor(void* source, const std::vector<AnchorSpec>& anchors) {
  SourceView view;
  int32_t length = 0;
  if (!inspect_checked(source, &view, &length)) return -1;
  for (std::size_t i = 0; i < anchors.size(); ++i) {
    const AnchorSpec& anchor = anchors[i];
    // Length first: a mismatching size is the common case and costs no read.
    if (anchor.length > 0 && length != anchor.length) continue;
    if (anchor.marker.empty()) return static_cast<int>(i);
    if (length > 64 * 1024) continue;  // markers are only searched in small sources
    if (!readable(view.data, static_cast<std::size_t>(length))) return -1;
    if (std::string(view.data, static_cast<std::size_t>(length))
            .find(anchor.marker) != std::string::npos) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

}  // namespace oicq
