#ifndef OICQ_SOURCE_ANCHOR_H
#define OICQ_SOURCE_ANCHOR_H

#include <cstdint>
#include <string>
#include <vector>

#include "oicq/config.h"

namespace oicq {

// Reads the JS text out of a v8::ScriptCompiler::Source without touching V8.
// Returns false when the layout does not look like a one-byte string.
bool source_text(void* source, std::string* out);

// Short, stable fingerprint of a source (length + FNV-1a over the first 96
// bytes). Logged with every hit so an operator can rebuild the anchor table
// from a single log line after a QQNT update.
std::string source_fingerprint(void* source);

// Returns the index of the matching anchor in `anchors`, or -1.
int match_anchor(void* source, const std::vector<AnchorSpec>& anchors);

}  // namespace oicq

#endif  // OICQ_SOURCE_ANCHOR_H
