#ifndef OICQ_SOURCE_SPLICE_H
#define OICQ_SOURCE_SPLICE_H

#include <cstdint>
#include <string>

namespace oicq {

// Reproduced V8 object layout (pointer-compressed builds, which is what
// QQNT 3.2.x ships). A `v8::Local<String>` stored inside
// `v8::ScriptCompiler::Source` is a handle slot; the tagged pointer stored in
// that slot is  object+1, and the string object is laid out as
//
//   +0  uint32 map
//   +4  uint32 raw_hash
//   +8  int32  length           -> tagged + 7
//   +12 char/uint16 data        -> tagged + 11
//
// The reference build reads exactly those two offsets (ELF 0x2461/0x248a,
// Mach-O 0x2478/0x24d0) and only ever handles one-byte strings; oicq keeps the
// same layout assumptions and adds a length cap before touching anything.
constexpr int kTaggedLengthOffset = 7;
constexpr int kTaggedDataOffset = 11;

struct SourceView {
  void** handle_slot = nullptr;  // Source's Local<String> field
  void* tagged = nullptr;       // *(void**)*handle_slot (object+1)
  int32_t* length = nullptr;    // (int32_t*)(tagged + 7)
  char* data = nullptr;         // (char*)(tagged + 11)
};

// The chain is Source* -> Local<String>.val_ (handle slot address) -> tagged
// string, i.e. the tagged pointer is **(void***)source. Both loads are the same
// ones the reference build performs at ELF 0x245b/0x245e.
bool inspect_source(void* source, SourceView* view);

struct SpliceResult {
  bool active = false;
  bool safe = false;        // handle replaced instead of in-place rewrite
  SourceView view{};
  int32_t original_length = 0;
  std::string original_text;
  void* original_handle = nullptr;
};

// Prepends `prefix` to the source text. Returns false without touching the
// source when it cannot be done (null source, allocation failure, ...).
bool splice_prefix(void* source, const std::string& prefix, SpliceResult* out);

// Restores the source to the state captured in `result`.
void splice_restore(SpliceResult* result);

// Optional V8 helpers. When bound, splice_prefix uses them to allocate a new
// string and swap the handle instead of rewriting the original buffer.
struct V8SpliceApi {
  void* (*get_current_isolate)() = nullptr;
  void* (*new_from_utf8)(void* isolate, const char* data, int type, int len) = nullptr;
  void* (*concat)(void* isolate, void* left, void* right) = nullptr;
  bool ready() const {
    return get_current_isolate && new_from_utf8 && concat;
  }
};

void splice_set_api(const V8SpliceApi& api);
const V8SpliceApi& splice_api();

// When true (default) and a V8 API is bound, splice_prefix allocates a new
// string and swaps the handle instead of rewriting the original buffer.
void splice_set_prefer_safe(bool prefer_safe);
bool splice_prefer_safe();

}  // namespace oicq

#endif  // OICQ_SOURCE_SPLICE_H
