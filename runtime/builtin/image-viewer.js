'use strict';
// builtin: image-viewer — open media in the system viewer instead of the
// built-in lightbox.
//
// `openMediaViewer` carries the media list and index. The original path is used
// when present, otherwise the first thumbnail; `appimg://` is stripped, then the
// file is handed to the OS. If the file is not on disk yet the call falls
// through to the client, which downloads it and opens it as usual.

module.exports = function activate(api, host) {
  if (!api.kernel.available) {
    return { status: 'unavailable', reason: 'kernel hooks are off (OICQ_KERNEL_HOOKS=1)' };
  }
  const fs = host.require('node:fs');

  const off = api.kernel.receive({ method: 'openMediaViewer' }, (ctx) => {
    const params = ctx.args[0];
    const list = params && params.mediaList;
    if (!Array.isArray(list) || !list.length) return;
    const index = Number.isInteger(params.index) ? params.index : 0;
    const media = list[index] || list[0];
    if (!media) return;
    const thumb = Array.isArray(media.thumbs) ? media.thumbs[0] : null;
    let file = media.originPath || (thumb && thumb.path) || media.path;
    if (!file) return;
    file = String(file).replace(/^appimg:\/\//, '');
    let exists = false;
    try {
      exists = fs.existsSync(file);
    } catch {
      exists = false;
    }
    if (!exists) return;
    ctx.cancel = true;
    host.openPath(file);
  });

  return { dispose: off };
};
