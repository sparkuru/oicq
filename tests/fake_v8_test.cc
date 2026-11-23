// Harness for the Linux path: a fake v8::ScriptCompiler::CompileFunction with
// the real ABI shape and a fake Source whose string layout matches the offsets
// the runtime reads (length at tagged+7, data at tagged+11).
//
// The fake compiler takes its bookkeeping through the `context` argument instead
// of global variables. That is deliberate: a global counter is compiled as a
// RIP-relative access, which makes the prologue non-relocatable and forces the
// hook down the restore-and-call path. Real targets (QQNT's CompileFunction)
// start with a relocatable prologue, so the fixture must too.

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "oicq/config.h"
#include "oicq/hook_backend.h"
#include "oicq/source_anchor.h"
#include "oicq/source_splice.h"

namespace oicq {
bool install_on(void* target, const std::string& inject, const Options& options);
void uninstall_hook();
}  // namespace oicq

namespace {

// The test binary links entry.cc, whose preload auto-start is on by default.
// Disable it before that constructor runs.
__attribute__((constructor(101))) void disable_autostart() {
  setenv("OICQ_AUTOINIT", "0", 1);
}

int g_failures = 0;

void check(bool condition, const char* what) {
  if (condition) {
    std::printf("ok   %s\n", what);
  } else {
    std::printf("FAIL %s\n", what);
    ++g_failures;
  }
}

constexpr int kSourceLength = 62;

// Per-call bookkeeping handed to the compiler through `context`.
struct Sink {
  std::atomic<int> calls{0};
  std::atomic<int> forwarded{0};
  std::string last;       // only written when record_text is set
  bool record_text = true;
};

// Per-call Source fixture (a shared one would let a thread observe another
// thread's in-flight splice, which no real CompileFunction call can do).
struct ThreadSource {
  alignas(16) unsigned char buffer[1024];
  void* slot = nullptr;   // holds the tagged pointer (object + 1)
  void* local = nullptr;  // holds &slot: the Source's Local<String> field

  explicit ThreadSource(const std::string& text) { reset(text); }

  // Rebuilds the fixture in place. Copy-assignment would leave `local` pointing
  // at the source object's slot, which is exactly the dangling pointer that
  // makes a test lie about the real ABI chain.
  void reset(const std::string& text) {
    std::memset(buffer, 0, sizeof(buffer));
    std::memcpy(buffer + 12, text.data(), text.size());
    *reinterpret_cast<int*>(buffer + 8) = static_cast<int>(text.size());
    slot = buffer + 1;
    local = &slot;
  }
  // Source* -> Local<String>.val_ (&local) -> handle slot (&slot) -> tagged.
  void* source() { return &local; }
  void* field() { return &local; }   // address of the Source's Local<String> field
  std::string text();                // JS text of the string currently in Source
};

std::string tagged_text(void* tagged) {
  const int length = *reinterpret_cast<int*>(static_cast<char*>(tagged) + 7);
  return std::string(static_cast<char*>(tagged) + 11,
                     static_cast<std::size_t>(length));
}

// Source field -> Local (slot address) -> tagged string -> {length, bytes}.
std::string ThreadSource::text() {
  return tagged_text(*static_cast<void**>(local));
}

using CompileFn = void* (*)(void* context, void* source, std::size_t argc,
                            void* argv, std::size_t ext_count, void* ext_values,
                            int options, int reason);

extern "C" void oicq_test_target(void);

// Branch-free 14-byte prologue with a tail jump: the same shape QQNT's
// CompileFunction has (no RIP-relative operands, no relative branch inside the
// copied window), which is what makes the trampoline path usable in production.
// A plain C++ fixture cannot provide this — the compiler emits a conditional
// branch or a RIP-relative global access in the first few bytes.
asm(R"(
  .text
  .globl oicq_test_target
  .type oicq_test_target,@function
oicq_test_target:
  .rept 14
  nop
  .endr
  jmp oicq_test_body
  .size oicq_test_target, .-oicq_test_target
)");

Sink g_sink;
ThreadSource g_single(std::string(kSourceLength, 'a'));

void call_through_hook(Sink* sink = &g_sink, void* source = nullptr) {
  void* target = source != nullptr ? source : g_single.source();
  volatile CompileFn fn = reinterpret_cast<CompileFn>(&oicq_test_target);
  fn(sink, target, 0, nullptr, 0, nullptr, 0, 0);
}

void use_single_source(const std::string& text) { g_single.reset(text); }

void test_decoder() {
  const unsigned char prologue[] = {0x55, 0x48, 0x89, 0xe5, 0x41, 0x57,
                                    0x41, 0x56, 0x41, 0x55, 0x41, 0x54,
                                    0x53, 0x48, 0x81, 0xec, 0xa8, 0x00,
                                    0x00, 0x00};
  const std::size_t length =
      oicq::compute_patch_length(prologue, oicq::kPatchMin, sizeof(prologue));
  check(length == 20, "prologue decode covers 20 bytes (>= 14)");

  const unsigned char endbr[] = {0xf3, 0x0f, 0x1e, 0xfa, 0x55};
  check(oicq::instruction_length(endbr, sizeof(endbr)) == 4, "endbr64 decodes to 4 bytes");

  unsigned char jump[oicq::kAbsJumpSize];
  oicq::encode_abs_jump(0x1122334455667788ULL, jump);
  check(jump[0] == 0xff && jump[1] == 0x25 && jump[6] == 0x88 && jump[13] == 0x11,
        "absolute jump encoding matches the reference JUMP_CODE");

  // RIP-relative operands must be reported, otherwise they cannot be relocated.
  const unsigned char rip[] = {0x83, 0x05, 0xf4, 0xea, 0x01, 0x00, 0x01};
  bool rip_relative = false;
  check(oicq::instruction_info(rip, sizeof(rip), &rip_relative) == sizeof(rip) &&
            rip_relative,
        "decoder flags RIP-relative operands");
  bool plain_relative = true;
  check(oicq::instruction_info(endbr, sizeof(endbr), &plain_relative) == 4 &&
            !plain_relative,
        "decoder does not flag plain register operands");
}

void test_anchor_matching() {
  const std::vector<oicq::AnchorSpec> anchors = oicq::default_anchors();
  check(oicq::match_anchor(g_single.source(), anchors) == 0,
        "default anchor matches a 62-byte source");

  std::vector<oicq::AnchorSpec> by_marker = {{"marker", 0, std::string(kSourceLength, 'a')}};
  check(oicq::match_anchor(g_single.source(), by_marker) == 0,
        "marker anchor matches without a length");
  by_marker[0].marker = "not-present";
  check(oicq::match_anchor(g_single.source(), by_marker) == -1,
        "marker mismatch rejects the source");

  std::vector<oicq::AnchorSpec> wrong_length = {{"other", kSourceLength + 1, ""}};
  check(oicq::match_anchor(g_single.source(), wrong_length) == -1,
        "length mismatch rejects the source");
  check(!oicq::source_fingerprint(g_single.source()).empty(), "fingerprint is available");
}

void test_anchor_spec() {
  std::vector<oicq::AnchorSpec> parsed = oicq::parse_anchor_spec("62,71");
  check(parsed.size() == 2 && parsed[0].length == 0x3e && parsed[1].length == 71,
        "bare length list parses");
  parsed = oicq::parse_anchor_spec("name=boot,length=62,marker=require(");
  check(parsed.size() == 1 && parsed[0].name == "boot" && parsed[0].length == 62 &&
            parsed[0].marker == "require(",
        "named anchor with marker parses");
  check(oicq::parse_anchor_spec("nonsense=").empty(), "invalid spec is rejected");
}

void test_inplace_splice() {
  use_single_source(std::string(kSourceLength, 'a'));
  oicq::splice_set_prefer_safe(false);
  const std::string original(kSourceLength, 'a');
  oicq::SpliceResult result;
  check(oicq::splice_prefix(g_single.source(), "require('/tmp/x.js');", &result),
        "in-place splice succeeds");
  check(!result.safe, "in-place path reported as unsafe");
  check(tagged_text(g_single.slot) == "require('/tmp/x.js');" + original,
        "prefix prepended in place");
  oicq::splice_restore(&result);
  check(tagged_text(g_single.slot) == original, "source restored byte for byte");
  oicq::splice_set_prefer_safe(true);
}

// -- fake V8 string API: exercises the handle-swap path -------------------
// splice_prefix() hands these helpers V8 string references: new_from_utf8 makes
// one and concat consumes two. Modelling them as tagged pointers keeps the
// fixture consistent with what the Source handle slot actually stores.
// Returns a v8::Local<String> as the API carries it: the address of a slot that
// holds the tagged string pointer.
void* fake_string(const std::string& text) {
  auto* buffer = new unsigned char[text.size() + 64];
  std::memset(buffer, 0, text.size() + 64);
  *reinterpret_cast<int*>(buffer + 8) = static_cast<int>(text.size());
  std::memcpy(buffer + 12, text.data(), text.size());
  return new void*(buffer + 1);
}

std::string local_text(void* local) { return tagged_text(*static_cast<void**>(local)); }

void* fake_isolate() { return reinterpret_cast<void*>(0x1); }
void* fake_new_from_utf8(void*, const char* data, int, int length) {
  return fake_string(std::string(data, static_cast<std::size_t>(length)));
}
void* fake_concat(void*, void* left, void* right) {
  return fake_string(local_text(left) + local_text(right));
}

void test_safe_splice() {
  use_single_source(std::string(kSourceLength, 'd'));
  void* original_handle = g_single.local;
  oicq::V8SpliceApi api;
  api.get_current_isolate = &fake_isolate;
  api.new_from_utf8 = &fake_new_from_utf8;
  api.concat = &fake_concat;
  oicq::splice_set_api(api);
  oicq::splice_set_prefer_safe(true);

  oicq::SpliceResult result;
  check(oicq::splice_prefix(g_single.source(), "PRELUDE", &result), "safe splice succeeds");
  check(result.safe, "safe splice used the handle-swap path");
  check(g_single.local != original_handle, "Source handle points at a new string");
  check(g_single.text() == "PRELUDE" + std::string(kSourceLength, 'd'),
        "new string holds prefix + original");
  oicq::splice_restore(&result);
  check(g_single.local == original_handle, "original handle restored");
  oicq::splice_set_api(oicq::V8SpliceApi{});
}

// -- hook behaviour ------------------------------------------------------
void reset_counters() {
  g_sink.calls = 0;
  g_sink.forwarded = 0;
  g_sink.last.clear();
  g_sink.record_text = true;
}

// A relocatable prologue is a precondition for the trampoline, and the
// trampoline is a precondition for hooking at all (fail-closed otherwise).
void test_install_requires_trampoline() {
  reset_counters();
  oicq::Options options;
  check(oicq::install_on(reinterpret_cast<void*>(&oicq_test_target), "PRELUDE", options),
        "hook installs on a relocatable prologue");
  oicq::uninstall_hook();
}

void test_hook_hit() {
  use_single_source(std::string(kSourceLength, 'b'));
  const std::string original = tagged_text(g_single.slot);
  reset_counters();
  oicq::Options options;  // default budget: one injection
  check(oicq::install_on(reinterpret_cast<void*>(&oicq_test_target),
                         "require('/tmp/oicq/boot.cjs');", options),
        "hook installs for the hit test");
  call_through_hook();
  check(g_sink.calls == 1, "hook forwarded the call");
  check(g_sink.last == "require('/tmp/oicq/boot.cjs');" + original,
        "original compiler observed injected source");
  check(tagged_text(g_single.slot) == original, "source restored after the call");
  call_through_hook();
  check(g_sink.calls == 2, "second call forwarded");
  check(g_sink.last == original, "second call saw the untouched source (one-shot)");
  oicq::uninstall_hook();
}

void test_sticky_hits() {
  use_single_source(std::string(kSourceLength, 'f'));
  const std::string original = tagged_text(g_single.slot);
  reset_counters();
  oicq::Options options;
  options.max_hits = 0;  // OICQ_MAX_HITS=0: inject on every match
  check(oicq::install_on(reinterpret_cast<void*>(&oicq_test_target), "PRELUDE", options),
        "hook installs with an unlimited budget");
  call_through_hook();
  check(g_sink.last == "PRELUDE" + original, "first call injected");
  call_through_hook();
  check(g_sink.last == "PRELUDE" + original, "second call injected as well (sticky)");
  oicq::uninstall_hook();
}

void test_non_match_rearms() {
  use_single_source(std::string(10, 'c'));
  reset_counters();
  oicq::Options options;
  check(oicq::install_on(reinterpret_cast<void*>(&oicq_test_target), "PRELUDE", options),
        "hook installs for the non-match test");
  call_through_hook();
  check(g_sink.calls == 1 && g_sink.last == std::string(10, 'c'),
        "non-matching source forwarded unchanged");
  call_through_hook();
  check(g_sink.calls == 2, "detour still forwards after a non-match");
  oicq::uninstall_hook();
}

// QQNT compiles several modules at once. With the trampoline in place the
// detour never rewrites the entry point, so concurrent calls are safe and only
// one of them may inject.
void test_concurrent_calls() {
  use_single_source(std::string(kSourceLength, 'g'));
  reset_counters();
  g_sink.record_text = false;
  oicq::Options options;
  check(oicq::install_on(reinterpret_cast<void*>(&oicq_test_target), "PRELUDE", options),
        "hook installs for the concurrency test");

  constexpr int kThreads = 8;
  constexpr int kCallsPerThread = 4000;
  std::vector<std::thread> threads;
  threads.reserve(kThreads);
  for (int i = 0; i < kThreads; ++i) {
    threads.emplace_back([] {
      ThreadSource source(std::string(kSourceLength, 'g'));
      for (int j = 0; j < kCallsPerThread; ++j) call_through_hook(&g_sink, source.source());
    });
  }
  for (std::thread& thread : threads) thread.join();

  check(g_sink.calls == kThreads * kCallsPerThread,
        "every concurrent call reached the original function");
  check(g_sink.forwarded == 1, "exactly one concurrent call saw the injected source");
  check(tagged_text(g_single.slot) == std::string(kSourceLength, 'g'),
        "shared fixture untouched after concurrent traffic");
  oicq::uninstall_hook();
}

}  // namespace

extern "C" void* oicq_test_body(void* context, void* source, std::size_t argc, void* argv,
                     std::size_t ext_count, void* ext_values, int options,
                     int reason) {
  (void)argc;
  (void)argv;
  (void)ext_count;
  (void)ext_values;
  (void)options;
  (void)reason;
  auto* sink = static_cast<Sink*>(context);
  if (source != nullptr && sink != nullptr) {
    void* handle = *static_cast<void**>(source);
    void* tagged = *static_cast<void**>(handle);
    const int length = *reinterpret_cast<int*>(static_cast<char*>(tagged) + 7);
    const char* data = static_cast<char*>(tagged) + 11;
    sink->calls.fetch_add(1, std::memory_order_relaxed);
    if (length > 0) {
      if (length > kSourceLength) sink->forwarded.fetch_add(1, std::memory_order_relaxed);
      if (sink->record_text) sink->last.assign(data, static_cast<std::size_t>(length));
    }
  }
  return nullptr;
}


int main() {
  test_decoder();
  test_anchor_matching();
  test_anchor_spec();
  test_inplace_splice();
  test_safe_splice();
  test_install_requires_trampoline();
  test_hook_hit();
  test_sticky_hits();
  test_non_match_rearms();
  test_concurrent_calls();
  if (g_failures != 0) {
    std::printf("%d check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all checks passed\n");
  return 0;
}
