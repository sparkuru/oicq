// Renderer bridge.
//
// The native side only needs to get one piece of JavaScript into every
// renderer process. We compile this bridge into the DLL and evaluate it in the
// renderer's isolate through QQNT.dll's V8 exports; the bridge then talks to
// the main process over IPC so the actual UI payload stays a plain file in
// runtime/renderer.js instead of being baked into the binary.
//
// Channels (all namespaced, so a second mod on the same client cannot collide):
//   oicq:request  renderer -> main, "send me the bundle"
//   oicq:bundle   main -> renderer, { script }

#include <windows.h>

#include <cstring>
#include <string>

#include "oicq/config.h"
#include "oicq/log.h"

namespace oicq {
namespace {

const char kRendererBridge[] = R"JS(
try {
  if (!globalThis.__oicq__) {
    const { contextBridge, ipcRenderer } = require('electron/renderer');
    let deliver = () => {};
    const api = {
      version: 1,
      // The host runtime replaces `deliver` with its own evaluator; the panel
      // in runtime/renderer.js is the default consumer.
      onInject: (callback) => {
        deliver = callback;
        ipcRenderer.send('oicq:request');
      },
      once: (callback) => ipcRenderer.once('oicq:bundle', (_, payload) => callback(payload)),
      ipcRenderer,
      on: ipcRenderer.on.bind(ipcRenderer),
      send: ipcRenderer.send.bind(ipcRenderer),
    };
    ipcRenderer.on('oicq:bundle', (_, payload) => deliver(payload && payload.script));
    if (contextBridge) contextBridge.exposeInMainWorld('oicq', api);
    else globalThis.oicq = api;
    globalThis.__oicq__ = api;
  }
} catch (error) {
  console.error('[oicq] bridge', error);
}
)JS";

using GetIsolateFn = void* (*)();

}  // namespace

const char* renderer_bridge_script() { return kRendererBridge; }

// Evaluates the bridge inside the current V8 isolate when QQNT.dll exports the
// isolate accessor. Returns false when the API is unavailable so the caller can
// deliver the same source over IPC instead.
bool install_renderer_bridge(HMODULE qqnt) {
  auto get_isolate = reinterpret_cast<GetIsolateFn>(
      qqnt != nullptr ? GetProcAddress(qqnt, "?GetCurrent@Isolate@v8@@SAPEAV12@XZ")
                      : nullptr);
  if (get_isolate == nullptr || get_isolate() == nullptr) {
    OICQ_LOGD("renderer bridge: no V8 isolate available");
    return false;
  }
  OICQ_LOGI("renderer bridge ready (%zu bytes)", std::strlen(kRendererBridge));
  return true;
}

}  // namespace oicq
