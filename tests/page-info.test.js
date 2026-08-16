const test = require('node:test');
const assert = require('node:assert');
const {EXT_CONFIG} = require('../config.js');
const {parseProfilePath} = require('../content.js');

const parse = (path) => parseProfilePath(path, EXT_CONFIG);

test('プロフィールページ (2 段ちょうど) だけを対象にする', () => {
    assert.deepStrictEqual(parse('/profile/alice.test'), {actor: 'alice.test'});
    assert.deepStrictEqual(parse('/profile/alice.test/'), {actor: 'alice.test'});
    assert.deepStrictEqual(parse('/profile/did:plc:abc123'), {actor: 'did:plc:abc123'});
});

test('3 段以上のページは対象外', () => {
    assert.strictEqual(parse('/profile/alice.test/post/abc'), null);
    assert.strictEqual(parse('/profile/alice.test/followers'), null);
    assert.strictEqual(parse('/profile/alice.test/follows'), null);
    assert.strictEqual(parse('/profile/alice.test/lists/xyz'), null);
    assert.strictEqual(parse('/profile/alice.test/feed/xyz'), null);
});

test('プロフィール以外のページは対象外', () => {
    assert.strictEqual(parse('/'), null);
    assert.strictEqual(parse('/search'), null);
    assert.strictEqual(parse('/notifications'), null);
    assert.strictEqual(parse('/messages'), null);
    assert.strictEqual(parse('/settings/appearance'), null);
});

test('壊れた入力でも例外を投げず null を返す', () => {
    assert.strictEqual(parse(null), null);
    assert.strictEqual(parse(''), null);
    assert.strictEqual(parse('/profile/'), null);
});
