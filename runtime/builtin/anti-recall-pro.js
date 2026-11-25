'use strict';
// builtin: anti-recall-pro — the JS equivalent of ref's AntiRecallPluginNative.
//
// ref registers five native functions into the V8 global object on Windows
// (`BQQNT_AntiRecall_Native`, `..._Recalled_List`, `..._UnH`, plus `get_rkey`
// and `checkMemory` in the same registration block at 0x1800084ae) and the
// renderer polls the recalled list every 200 ms. This plugin gets the same
// outcome without native code and without polling:
//
//   * it observes every kernel → renderer message source, not just `onRecvMsg`;
//   * a revoke frame is restored synchronously, in place;
//   * the cache is bounded, persisted in batches (not one write per message),
//     and flushed on dispose.
//
// Capability difference vs. native: a message that the client received while
// this plugin was disabled or before the bridge installed cannot be recovered.
// Neither can ref's native version — it only records what passed through the
// process while it was loaded.

module.exports = function activate(api, host) {
  if (!api.kernel.available) {
    return {
      status: 'unavailable',
      reason: 'kernel hooks are off (OICQ_KERNEL_HOOKS=1)',
    };
  }
  const fs = host.require('node:fs');
  const path = host.require('node:path');

  const root = host.paths.root;
  const storeFile = path.join(root, 'anti-recall-pro.json');
  const LIMIT = 2000;
  const FLUSH_MS = 2000;
  // Keep media outside ~/.oicq and /tmp/oicq: the observation-surface layer
  // answers stat/access with ENOENT there, and the client itself needs to stat
  // the file to render it.
  const mediaDir = path.join(host.require('node:os').homedir(), '.cache', 'oicq', 'recalled-media');
  try {
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  } catch {
    /* read-only root: images fall back to QQ's own cache */
  }

  // QQ cleans its emoji/image cache on restart, so a recalled image would lose
  // its bytes. Copy the file next to the cache and point the snapshot at it.
  const preserveMedia = (snapshot) => {
    for (const element of snapshot.elements || []) {
      const pic = element && element.picElement;
      const source = pic && pic.sourcePath;
      if (typeof source !== 'string' || !source) continue;
      try {
        const ext = path.extname(source) || '.img';
        const dest = path.join(mediaDir, `${snapshot.msgId}${ext}`);
        if (!fs.existsSync(dest)) {
          // open/read is allowed even for hidden paths; copyFileSync stats and
          // would fail there.
          const fd = fs.openSync(source, 'r');
          let data;
          try {
            data = fs.readFileSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          fs.writeFileSync(dest, data);
        }
        // Keep the original path for the live frame: QQ resolves images from
        // its own cache, so restore writes our bytes back there instead of
        // pointing at a path its image component does not know.
        pic.oqOriginalPath = source;
        pic.oqSavedPath = dest;
      } catch (error) {
        api.debug('media preserve failed', snapshot.msgId, error.message);
      }
    }
  };

  const snapshot = (message) => {
    const hasPic = Array.isArray(message.elements)
      && message.elements.some((element) => element && element.picElement);
    if (!hasPic) return { ...message };
    const copy = JSON.parse(JSON.stringify(message));
    preserveMedia(copy);
    return copy;
  };

  const cache = new Map(); // msgId -> {msgId, chatType, peerUid, msgSeq, elements}
  const bySeq = new Map(); // msgSeq -> msgId (revoke tips carry no original id)
  const stats = { seen: 0, restored: 0, dropped: 0, writes: 0 };
  let dirty = false;
  let flushTimer = null;

  const load = () => {
    try {
      const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      if (Array.isArray(saved)) {
        for (const item of saved) {
          if (!item || !item.msgId || !Array.isArray(item.elements)) continue;
          // Backfill media for entries cached before the copy existed.
          const hasPic = item.elements.some((element) => element && element.picElement);
          if (hasPic) preserveMedia(item);
          cache.set(item.msgId, item);
          if (item.msgSeq != null) bySeq.set(item.msgSeq, item.msgId);
        }
      }
    } catch {
      /* first run */
    }
  };

  const flush = () => {
    if (!dirty) return false;
    dirty = false;
    const temp = `${storeFile}.${process.pid}.tmp`;
    try {
      const list = [...cache.values()];
      fs.writeFileSync(temp, JSON.stringify(list));
      fs.renameSync(temp, storeFile);
      stats.writes += 1;
      return true;
    } catch (error) {
      api.log('persist failed:', error.message);
      try {
        fs.unlinkSync(temp);
      } catch {
        /* nothing to clean */
      }
      return false;
    }
  };

  load();
  flushTimer = setInterval(flush, FLUSH_MS);

  const isRevoke = (message) => Boolean(
    message
    && Array.isArray(message.elements)
    && message.elements.some(
      (element) => element && element.grayTipElement && element.grayTipElement.revokeElement,
    ),
  );

  const remember = (message) => {
    if (!message || !message.msgId || !Array.isArray(message.elements)) return;
    if (cache.has(message.msgId)) {
      // Keep the newest element list: edits and re-sends carry the same id.
      // Keep the whole message: the renderer keys off msgType/subType and
      // other fields, so restoring only elements still draws a gray tip.
      cache.set(message.msgId, snapshot(message));
      if (message.msgSeq != null) bySeq.set(message.msgSeq, message.msgId);
      dirty = true;
      return;
    }
    cache.set(message.msgId, snapshot(message));
    if (message.msgSeq != null) bySeq.set(message.msgSeq, message.msgId);
    stats.seen += 1;
    if (stats.seen <= 5) api.log('cached', message.msgId);
    if (cache.size > LIMIT) {
      // Map preserves insertion order: drop the oldest.
      const oldestId = cache.keys().next().value;
      const dropped = cache.get(oldestId);
      cache.delete(oldestId);
      try {
        const pic = dropped && (dropped.elements || [])
          .map((e) => e && e.picElement)
          .find((p) => p && typeof p.sourcePath === 'string' && p.sourcePath.startsWith(mediaDir));
        if (pic) fs.unlinkSync(pic.sourcePath);
      } catch {
        /* file already gone */
      }
      stats.dropped += 1;
    }
    dirty = true;
  };

  const IDENTITY = new Set(['msgId', 'chatType', 'peerUid', 'msgSeq', 'clientSeq', 'cntSeq']);

  const restore = (message) => {
    const saved = cache.get(message.msgId)
      || (message.msgSeq != null ? cache.get(bySeq.get(message.msgSeq)) : null);
    if (!saved || !Array.isArray(saved.elements)) return false;
    // Copy every non-identity field, not just elements: the renderer also keys
    // off msgType / subType, so replacing elements alone still draws a tip.
    for (const [key, value] of Object.entries(saved)) {
      if (IDENTITY.has(key)) continue;
      message[key] = value;
    }
    message.elements = saved.elements;

    // Put the picture back where QQ's image component expects it. Copy, not
    // move: the cache stays valid for the next restart.
    for (const element of message.elements) {
      const pic = element && element.picElement;
      if (!pic) continue;
      const target = pic.oqOriginalPath || pic.sourcePath;
      const savedFile = pic.oqSavedPath;
      if (!target || !savedFile) continue;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const fd = fs.openSync(savedFile, 'r');
        let data;
        try {
          data = fs.readFileSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.writeFileSync(target, data);
        pic.sourcePath = target;
      } catch (error) {
        api.debug('media restore failed', message.msgId, error.message);
      }
    }
    const pic = message.elements
      .map((element) => element && element.picElement)
      .find(Boolean);
    if (pic) {
      api.debug('restored pic', message.msgId,
          `source=${String(pic.sourcePath || '').slice(-50)}`,
          `exists=${Boolean(pic.sourcePath && fs.existsSync(pic.sourcePath))}`,
          `dir=${path.dirname(String(pic.sourcePath || ''))}`);
    }
    stats.restored += 1;
    return true;
  };

  // Every stream that can carry a message list. ref's native version only has
  // to plumb the recalled list; the JS side has to see the message first, so it
  // subscribes to the sources that actually deliver one.
  // Every message, list or single, goes through one gate: revoke frames must
  // restore (never overwrite the cache with the gray tip), everything else is
  // remembered. Send responses carry a single message, which is how a recalled
  // message you sent yourself becomes recoverable.
  const seenTips = new Set();
  const missed = new Set();
  const restoredIds = new Set();

  const ingest = (message) => {
    if (!message || !message.msgId) return;
    const tip = message.elements
      && message.elements[0]
      && message.elements[0].grayTipElement;
    if (isRevoke(message)) {
      if (seenTips.has('revoke-keys') === false) {
        seenTips.add('revoke-keys');
        const rv = tip.revokeElement || {};
        api.debug('revoke keys', Object.keys(rv).join(','));
        api.debug('revoke ids', `msgId=${message.msgId}`,
            `msgSeq=${message.msgSeq}`, `clientSeq=${message.clientSeq}`,
            `cntSeq=${message.cntSeq}`);
      }
      if (restore(message)) {
        if (!restoredIds.has(message.msgId)) {
          restoredIds.add(message.msgId);
          api.log('restored', message.msgId);
          // Renderer marks the bubble: lighter text plus a corner label.
          const pic = (message.elements || [])
            .map((element) => element && element.picElement)
            .find(Boolean);
          api.ui.push({
            type: 'recalled',
            msgId: message.msgId,
            mediaPath: pic && typeof pic.sourcePath === 'string' ? pic.sourcePath : '',
            mediaUrl: pic && typeof pic.originImageUrl === 'string' ? pic.originImageUrl : '',
          });
        }
      } else if (!missed.has(message.msgId)) {
        // Historical tips replay on every history load; log each id once at
        // debug. A live miss still shows up, a startup replay does not spam.
        missed.add(message.msgId);
        api.debug('revoke miss', message.msgId, `cached=${cache.size}`);
      }
      return;
    }
    remember(message);
  };

  const rememberShape = (payload) => {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.msgId && Array.isArray(payload.elements)) {
      ingest(payload);
      return true;
    }
    if (payload.result && payload.result.msgId) {
      ingest(payload.result);
      return true;
    }
    if (payload.msg && payload.msg.msgId) {
      ingest(payload.msg);
      return true;
    }
    return false;
  };

  const unwrap = (payload) => {
    const out = [];
    const push = (value) => {
      if (value && typeof value === 'object' && !out.includes(value)) out.push(value);
    };
    push(payload);
    if (payload && typeof payload === 'object') {
      push(payload.result);
      push(payload.value);
      push(payload.payload);
      push(payload.data);
      push(payload.result && payload.result.value);
      push(payload.value && payload.value.result);
      push(payload.payload && payload.payload.result);
      push(payload.payload && payload.payload.value);
    }
    return out;
  };

  const handleList = (ctx) => {
    for (const node of unwrap(ctx.payload)) {
      rememberShape(node);
      if (Array.isArray(node.msgList)) {
        for (const message of node.msgList) ingest(message);
      }
    }
  };

  // The 3.2.x response envelope carries the method in the request, not in the
  // reply: replies arrive as `{eventName:'ntApi', ...}` + body. Matching only
  // known event names would miss history loads, so every outbound frame is
  // inspected and anything with a `msgList` (or `result.msgList`) is processed.
  // The check is a property read per frame; the handler stays O(1) when the
  // body is not a message list.
  const offs = [api.kernel.send({}, handleList)];

  // Optional: stop your own recall before it reaches the kernel. Off by
  // default because it changes what the client is allowed to do; useful when
  // you want "recall" to be a local no-op instead of an undo.
  const hostConfig = typeof host.config === 'function' ? host.config() : null;
  if (hostConfig && hostConfig.antiRecall && hostConfig.antiRecall.blockRecall) {
    let logged = false;
    offs.push(api.kernel.receive({}, (ctx) => {
      if (!ctx.method || !/recall/i.test(ctx.method)) return;
      if (!logged) {
        logged = true;
        api.log('blocked recall', ctx.method);
      }
      ctx.cancel = true;
    }));
  }

  // Discovery: where do incoming messages actually appear in this build?
  api.commands.register({
    id: 'anti-recall.stats',
    title: '防撤回 Pro: 统计',
    hint: '缓存数量、恢复次数、落盘次数',
    run: () => ({ cached: cache.size, ...stats }),
  });
  api.commands.register({
    id: 'anti-recall.imgstate',
    title: '防撤回 Pro: 图片状态',
    run: (payload) => {
      api.debug('image state', JSON.stringify(payload));
      return { ok: true };
    },
  });
  const download = (url, dest, hops = 0) => new Promise((resolve) => {
    if (hops > 3) return resolve(false);
    const lib = url.startsWith('https:') ? host.require('node:https') : host.require('node:http');
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(false);
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(true)));
      out.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(false);
    });
  });

  api.commands.register({
    id: 'anti-recall.clicklog',
    title: '防撤回 Pro: 点击诊断',
    run(payload) {
      api.log('click target', JSON.stringify(payload));
      return { ok: true };
    },
  });
  let lastOpenId = '';
  let lastOpenAt = 0;

  api.commands.register({
    id: 'anti-recall.open',
    title: '防撤回 Pro: 打开图片',
    async run(payload) {
      const msgId = payload && payload.msgId;
      const now = Date.now();
      if (msgId === lastOpenId && now - lastOpenAt < 600) {
        return { ok: true, deduped: true };
      }
      lastOpenId = msgId;
      lastOpenAt = now;
      api.log('open request', String(msgId));
      const saved = msgId && cache.get(msgId);
      const pic = saved && (saved.elements || [])
        .map((element) => element && element.picElement)
        .find(Boolean);
      if (!pic) {
        api.log('open failed', 'no-pic');
        return { ok: false, error: 'no-pic' };
      }
      const candidates = [pic.oqSavedPath, pic.sourcePath].filter(Boolean);
      for (const file of candidates) {
        try {
          if (fs.existsSync(file)) {
            const error = await host.openPath(file);
            if (error) {
              api.log('open failed', error);
              return { ok: false, error };
            }
            return { ok: true, path: file };
          }
        } catch {
          /* keep trying */
        }
      }
      api.log('open failed', 'missing-file', JSON.stringify(candidates));
      return { ok: false, error: 'missing-file' };
    },
  });
  api.commands.register({
    id: 'anti-recall.recover',
    title: '防撤回 Pro: 重新获取图片',
    hint: '按 originImageUrl 下载到本地缓存',
    async run(payload) {
      const msgId = payload && payload.msgId;
      const saved = msgId && cache.get(msgId);
      const pic = saved && (saved.elements || [])
        .map((element) => element && element.picElement)
        .find(Boolean);
      if (!pic) return { ok: false, error: 'no-pic' };
      const ext = path.extname(pic.fileName || '') || '.jpg';
      const dest = path.join(mediaDir, `${msgId}${ext}`);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        return { ok: true, path: dest };
      }
      if (!pic.originImageUrl) return { ok: false, error: 'no-url' };
      const done = await download(pic.originImageUrl, dest);
      return done ? { ok: true, path: dest } : { ok: false, error: 'download-failed' };
    },
  });
  api.commands.register({
    id: 'anti-recall.flush',
    title: '防撤回 Pro: 立即落盘',
    run: () => ({ flushed: flush(), cached: cache.size }),
  });

  api.lifecycle.onDispose(() => {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    flush();
  });

  const renderer = `
(() => {
  const marked = new Set();
  const style = document.createElement('style');
  style.setAttribute('data-oicq', 'anti-recall');
  style.textContent = [
    '.oq-recall-badge-box{float:right;z-index:99;}',
    '.oq-recall-badge{padding:2px 6px;font-size:12px;opacity:.6;line-height:12px;margin-top:6px;display:inline;width:max-content;color:var(--on_bg_text,#999);}',
    '.oq-recalled-dim{opacity:.7 !important;border:2px solid var(--brand_standard,#5b8cff) !important;border-radius:6px;}',
    '.ml-item[data-oq-recall-marked="1"] img{max-width:220px !important;max-height:220px !important;object-fit:contain;}',
    '.oq-recall-badge-block{display:block;text-align:right;margin-top:4px;}',
  ].join('');
  document.head.appendChild(style);

  const mediaPaths = new Map();
  const mediaUrls = new Map();

  const paintImage = (id) => {
    const file = mediaPaths.get(id);
    if (!file) return;
    const row = document.getElementById(id);
    if (!row) return;
    const content = row.querySelector('.message-content') || row.querySelector('.msg-content-container');
    if (!content) return;
    if (content.querySelector('.oq-recall-img')) return;
    const img = document.createElement('img');
    img.className = 'oq-recall-img';
    img.style.maxWidth = '220px';
    img.style.maxHeight = '220px';
    img.style.borderRadius = '8px';
    img.style.cursor = 'zoom-in';
    img.style.position = 'relative';
    img.style.zIndex = '10';
    img.style.pointerEvents = 'auto';
    img.src = 'file://' + file;
    img.onerror = () => {
      img.onerror = null;
      img.src = 'appimg://' + file;
      img.onerror = () => {
        img.onerror = null;
        const remote = mediaUrls.get(id);
        if (remote) {
          fetch(remote).then((res) => res.blob()).then((blob) => {
            img.src = URL.createObjectURL(blob);
            return;
          }).catch(() => {});
        }
        oicq.invoke('command:run', { id: 'anti-recall.recover', payload: { msgId: id } })
          .then((result) => {
            if (result && result.ok && result.value && result.value.ok && result.value.path) {
              img.src = 'appimg://' + result.value.path;
            }
          })
          .catch(() => {});
      };
    };
    content.insertBefore(img, content.firstChild);
  };

  const mark = (id) => {
    const row = document.getElementById(id);
    if (!row) return false;
    if (row.dataset.oqRecallMarked === '1') return true;
    row.dataset.oqRecallMarked = '1';
    const content = row.querySelector('.message-content') || row.querySelector('.msg-content-container');
    const isPic = Boolean(row.querySelector('.mix-message__container--pic'));
    if (isPic && row.dataset.oqRecallClick !== '1') {
      row.dataset.oqRecallClick = '1';
      const openFor = (event) => {
        // Capture phase on the row: QQ's image container sits above our <img>
        // and swallows the click, so any click inside a marked picture row
        // opens the restored file.
        window.__oqClicks = (window.__oqClicks || 0) + 1;
        if (oicq.bridgePort) {
          fetch('http://127.0.0.1:' + oicq.bridgePort + '/open?msgId=' + encodeURIComponent(id))
            .then((res) => res.json())
            .then((result) => {
              if (!result || !result.ok) oicq.toast('无法打开图片: ' + ((result && result.error) || 'http'));
            })
            .catch((error) => oicq.toast('无法打开图片: ' + error));
          return;
        }
        oicq.toast('点击命中，尝试打开图片');
        oicq.invoke('command:run', { id: 'anti-recall.open', payload: { msgId: id } })
          .then((result) => {
            if (!result || !result.ok || !result.value || !result.value.ok) {
              const reason = result && result.value ? result.value.error : 'invoke-failed';
              oicq.toast('无法打开图片: ' + reason);
            }
          });
      };
      row.addEventListener('click', openFor, true);
    }
    if (content && !row.querySelector('.oq-recall-badge-box')) {
      const box = document.createElement('div');
      box.className = isPic ? 'oq-recall-badge-block' : 'oq-recall-badge-box';
      const badge = document.createElement('span');
      badge.className = 'oq-recall-badge';
      badge.textContent = '(此消息已撤回)';
      box.appendChild(badge);
      if (isPic) {
        // Below the picture: floating inside the image would cover it.
        (content.parentElement || content).appendChild(box);
      } else {
        content.appendChild(box);
      }
    }
    // avatar, text wrapper and canvas are dimmed (images render to canvas)
    for (const el of row.querySelectorAll('.avatar, .message-content__wrapper, .canvas')) {
      el.classList.add('oq-recalled-dim');
    }
    return true;
  };

  // Chat lists mutate constantly (typing, animations); coalesce re-marking to
  // one pass per 250 ms instead of running on every mutation.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      for (const id of marked) {
        mark(id);
        paintImage(id);
      }
    }, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', (event) => {
    const row = event.target && event.target.closest && event.target.closest('.ml-item');
    if (!row) return;
    oicq.invoke('command:run', {
      id: 'anti-recall.clicklog',
      payload: {
        msgId: row.id,
        cls: String((event.target.className && event.target.className.baseVal) || event.target.className || '').slice(0, 60),
        tag: event.target.tagName,
        marked: row.dataset.oqRecallMarked || '',
      },
    });
  }, true);

  window.__oqTestOpen = (id) => oicq.invoke('command:run', {
    id: 'anti-recall.open', payload: { msgId: id },
  });

  oicq.onMessage((payload) => {
    if (!payload || payload.type !== 'recalled' || !payload.msgId) return;
    marked.add(payload.msgId);
    if (payload.mediaPath) mediaPaths.set(payload.msgId, payload.mediaPath);
    if (payload.mediaUrl) mediaUrls.set(payload.msgId, payload.mediaUrl);
    mark(payload.msgId);
    paintImage(payload.msgId);
  });
})();
`;

  return {
    renderer,
    dispose() {
      for (const off of offs) off();
    },
  };
};
