#include "oicq/source_splice.h"

#include <cstring>
#include <string>

#include "oicq/log.h"

namespace oicq {
namespace {
V8SpliceApi g_api{};
bool g_prefer_safe = true;
}  // namespace

void splice_set_api(const V8SpliceApi& api) { g_api = api; }
const V8SpliceApi& splice_api() { return g_api; }
void splice_set_prefer_safe(bool prefer_safe) { g_prefer_safe = prefer_safe; }
bool splice_prefer_safe() { return g_prefer_safe; }

bool inspect_source(void* source, SourceView* view) {
  if (source == nullptr || view == nullptr) return false;
  // ABI chain observed in the fixed target:
  //   Source* -> Local<String>.val_ (handle slot address) -> tagged string.
  // The reference build performs the same two loads at ELF 0x245b/0x245e.
  auto* slot = static_cast<void**>(source);
  void* handle = *slot;
  if (handle == nullptr) return false;
  void* tagged = *static_cast<void**>(handle);
  if (tagged == nullptr) return false;
  view->handle_slot = slot;
  view->tagged = tagged;
  view->length = reinterpret_cast<int32_t*>(static_cast<char*>(tagged) +
                                            kTaggedLengthOffset);
  view->data = static_cast<char*>(tagged) + kTaggedDataOffset;
  return true;
}

bool splice_prefix(void* source, const std::string& prefix, SpliceResult* out) {
  SourceView view;
  if (out == nullptr || !inspect_source(source, &view)) return false;
  const int32_t original_length = *view.length;
  if (original_length <= 0 || original_length > 64 * 1024 * 1024) return false;

  const std::string original(view.data, static_cast<std::size_t>(original_length));
  const std::string combined = prefix + original;

  // Safe path: allocate a fresh string and swap the handle. This is what the
  // tupp reimplementation verified in-process; ref itself does not do it.
  if (g_prefer_safe && g_api.ready()) {
    void* isolate = g_api.get_current_isolate();
    if (isolate != nullptr) {
      // Only the prefix is created here; concat() appends the original handle.
      void* created = g_api.new_from_utf8(isolate, prefix.data(), 0,
                                          static_cast<int>(prefix.size()));
      if (created != nullptr) {
        void* merged = g_api.concat(isolate, created, *view.handle_slot);
        if (merged != nullptr) {
          out->active = true;
          out->safe = true;
          out->view = view;
          out->original_length = original_length;
          out->original_text = original;
          out->original_handle = *view.handle_slot;
          *view.handle_slot = merged;
          return true;
        }
      }
    }
    OICQ_LOGW("v8 splice api failed, falling back to in-place rewrite");
  }

  // Faithful path: rewrite the one-byte string in place, exactly like
  // CompileFunctionHook at ELF 0x24d9..0x2703. ref does not check the
  // allocation size here; callers that care should enable the safe path.
  std::memcpy(view.data, combined.data(), combined.size());
  *view.length = static_cast<int32_t>(combined.size());

  out->active = true;
  out->safe = false;
  out->view = view;
  out->original_length = original_length;
  out->original_text = original;
  out->original_handle = view.tagged;
  return true;
}

void splice_restore(SpliceResult* result) {
  if (result == nullptr || !result->active) return;
  if (result->safe) {
    if (result->view.handle_slot != nullptr) {
      *result->view.handle_slot = result->original_handle;
    }
  } else {
    if (!result->original_text.empty()) {
      std::memcpy(result->view.data, result->original_text.data(),
                  result->original_text.size());
    }
    if (result->view.length != nullptr) {
      *result->view.length = result->original_length;
    }
  }
  result->active = false;
}

}  // namespace oicq
