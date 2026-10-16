import { test } from 'node:test';
import assert from 'node:assert';
import { staticFilesFor } from '../../scripts/static-files.mjs';

test('配布物にライセンス 3 点とアイコン 4 枚と CSS が入る', () => {
	const to = staticFilesFor('dist').map(([, dest]) => dest);
	for (const path of ['dist/LICENSE', 'dist/NOTICE', 'dist/LICENSES/Apache-2.0.txt', 'dist/content.css',
		'dist/popup/popup.html', 'dist/popup/popup.css', 'dist/common/tokens.css',
		'dist/icons/icon-16.png', 'dist/icons/icon-32.png', 'dist/icons/icon-48.png', 'dist/icons/icon-128.png']) {
		assert.ok(to.includes(path), path);
	}
});
