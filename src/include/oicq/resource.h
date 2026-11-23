#ifndef OICQ_RESOURCE_H
#define OICQ_RESOURCE_H

#include <cstddef>
#include <string>

#include "oicq/config.h"

namespace oicq {

// One file of the embedded runtime payload. The generated table is built from
// runtime/*.js by scripts/embed_runtime.py.
struct EmbeddedFile {
  const char* name;
  const unsigned char* data;
  std::size_t size;
};

const EmbeddedFile* embedded_files();
std::size_t embedded_file_count();

// Payload entry point for this configuration: "boot.cjs" (host runtime) or
// "minimal.cjs" (loader stub only). Never null; falls back to the first file.
const EmbeddedFile* entry_file(const Options& options);

// Writes every payload file into <temp_dir>/<temp_subdir>/ and returns the
// absolute path of the entry point, or an empty string on failure.
std::string materialise_runtime(const Options& options);

// Builds the injected source expression, e.g.
//   void 0===globalThis.__oicq__&&(function(){try{return require('<path>')}catch(e){}})();
std::string build_inject_expression(const Options& options, const std::string& path);

}  // namespace oicq

#endif  // OICQ_RESOURCE_H
