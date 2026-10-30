// 동기화 판단 로직 자체 검사: node test.js
const Module = require('module');
const load = Module._load;
Module._load = (req, ...rest) => (req === 'obsidian' ? { Plugin: class {}, PluginSettingTab: class {} } : load(req, ...rest));
const { decide, tooManyDeletes, conflictName } = require('./main.js');
const assert = require('assert');

const L = { mtime: 1, size: 10 }, R = { id: 'a', md5: 'x' }, P = { md5: 'x', mtime: 1, size: 10 };
const Lnew = { mtime: 2, size: 10 }, Rnew = { id: 'a', md5: 'y' };

assert.strictEqual(decide(L, undefined, undefined), 'upload');
assert.strictEqual(decide(undefined, R, undefined), 'download');
assert.strictEqual(decide(L, R, undefined), 'both');
assert.strictEqual(decide(L, R, P), 'none');
assert.strictEqual(decide(Lnew, R, P), 'upload');
assert.strictEqual(decide(L, Rnew, P), 'download');
assert.strictEqual(decide(Lnew, Rnew, P), 'both');
assert.strictEqual(decide(undefined, R, P), 'deleteRemote');
assert.strictEqual(decide(undefined, Rnew, P), 'download'); // 아이폰에서 지웠어도 드라이브에서 고쳤으면 살린다
assert.strictEqual(decide(L, undefined, P), 'deleteLocal');
assert.strictEqual(decide(Lnew, undefined, P), 'upload'); // 드라이브에서 지웠어도 아이폰에서 고쳤으면 살린다
assert.strictEqual(decide(undefined, undefined, P), 'forget');

const dels = (k) => Array.from({ length: k }, (_, i) => [String(i), 'deleteLocal']);
assert.strictEqual(tooManyDeletes(dels(5), 10), false);
assert.strictEqual(tooManyDeletes(dels(50), 60), true);
assert.strictEqual(tooManyDeletes(dels(11), 100), false);

assert.match(conflictName('메모/회의.md'), /^메모\/회의 \(아이폰 충돌 .+\)\.md$/);
assert.match(conflictName('a.b/README'), /^a\.b\/README \(아이폰 충돌 .+\)$/);
console.log('ok');
