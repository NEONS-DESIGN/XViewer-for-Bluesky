import test from 'node:test';
import assert from 'node:assert';
import {readFileSync, existsSync} from 'node:fs';
import {PROJECT_LICENSE, THIRD_PARTY} from '../src/popup/license-panel.js';

const LICENSE = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
const NOTICE = readFileSync(new URL('../NOTICE', import.meta.url), 'utf8');

/**
 * 改行と字下げの違いを無視して比べるために空白を 1 つにまとめる。
 * @param {string} text 文
 * @returns {string} まとめた文
 */
const squash = (text) => text.replace(/\s+/g, ' ').trim();

test('この拡張機能のライセンス表示は LICENSE と一致する', () => {
	assert.ok(LICENSE.startsWith(PROJECT_LICENSE.name));
	assert.ok(LICENSE.includes(PROJECT_LICENSE.copyright));
	assert.ok(existsSync(new URL(`../${PROJECT_LICENSE.file}`, import.meta.url)));
});

test('第三者の帰属は NOTICE と同じ文', () => {
	for (const item of THIRD_PARTY) {
		assert.ok(NOTICE.includes(item.name), `${item.name} が NOTICE に無い`);
		assert.ok(NOTICE.includes(item.copyright), `${item.name} の著作権表示が NOTICE と違う`);
		assert.ok(squash(NOTICE).includes(squash(item.attribution.join(' '))), `${item.name} の帰属文が NOTICE と違う`);
		assert.ok(NOTICE.includes(item.url), `${item.name} の配布元が NOTICE と違う`);
		assert.ok(existsSync(new URL(`../${item.licenseFile}`, import.meta.url)), `${item.licenseFile} が無い`);
	}
});
