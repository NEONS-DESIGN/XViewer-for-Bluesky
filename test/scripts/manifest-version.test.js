import { test } from 'node:test';
import assert from 'node:assert';
import { toManifestVersion, applyVersion } from '../../scripts/manifest-version.mjs';

test('semver をそのまま manifest の version にする', () => {
	assert.strictEqual(toManifestVersion('3.0.0'), '3.0.0');
});

test('雛形に version が残っていたら止める', () => {
	assert.throws(() => applyVersion({ version: '1.0.0' }, '3.0.0'));
});
