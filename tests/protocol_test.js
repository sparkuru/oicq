'use strict';
// Harness for the page <-> host wire format (runtime/protocol.js).
//
// The renderer has no ipcRenderer: every user action travels back as a
// line-prefixed console message, and everything else in QQNT's console stream
// must be left untouched. A parser that is too eager here would swallow the
// host's own log lines; one that is too lax would act on them.

const assert = require('assert');
const protocol = require('../runtime/protocol.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

check('round-trips an action', () => {
  const encoded = protocol.encode({ id: 7, type: 'state' });
  const decoded = protocol.parse(encoded);
  assert.deepStrictEqual(decoded, { id: 7, type: 'state' });
});

check('keeps extra payload fields', () => {
  const decoded = protocol.parse(protocol.encode({ id: 1, type: 'command:run', id2: 2, patch: { ui: { accent: '#fff' } } }));
  assert.strictEqual(decoded.patch.ui.accent, '#fff');
});

check('ignores QQNT console traffic', () => {
  for (const line of [
    '[2026-11-18 17:11:09.002] [ERROR] [QLogger] [AIO] something',
    'GL Driver Message (OpenGL, Performance)',
    '',
    'oicq-action without the prefix',
  ]) {
    assert.strictEqual(protocol.parse(line), null, `parsed ${JSON.stringify(line)}`);
  }
});

check('rejects malformed payloads', () => {
  for (const line of [
    `${protocol.ACTION_PREFIX}{`,
    `${protocol.ACTION_PREFIX}{}`,
    `${protocol.ACTION_PREFIX}{"type":42}`,
    `${protocol.ACTION_PREFIX}{"type":"state","id":"x"}`,
    `${protocol.ACTION_PREFIX}null`,
    `${protocol.ACTION_PREFIX}${'x'.repeat(70 * 1024)}`,
  ]) {
    assert.strictEqual(protocol.parse(line), null, `accepted ${line.slice(0, 40)}`);
  }
});

check('rejects non-strings', () => {
  assert.strictEqual(protocol.parse(undefined), null);
  assert.strictEqual(protocol.parse({ type: 'state' }), null);
});

console.log(results.join('\n'));
