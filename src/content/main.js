/**
 * content script の入口。各機能を起動する順序だけを持つ。
 *
 * 順序は旧 manifest の読み込み順で各ファイルが自己起動していた順と同じにする。
 * debug は他のすべてが ExtDebug を使うため最初に、page (ナビボタン・遷移とタブの監視) は
 * メディアグリッドが購読口 (subscribeTabStateChange) を使うためその前に置く。
 * パネルと操作性の調整はどちらも page の購読口 (subscribeLightboxVisibility) を使う。
 */
import {EXT_CONFIG} from '../common/config.js';
import {ExtDebug} from '../common/debug.js';
import {main as startPage} from './page.js';
import {initMediaGrid} from './media-grid.js';
import {LightboxPanel} from './lightbox-panel.js';
import {LightboxGuard} from './lightbox-guard.js';

/**
 * 起動の 1 手順。[名前, 起動する関数] の組。関数は Promise を返してもよい (設定の読み込みなど)。
 * @typedef {readonly [string, () => (void|Promise<void>)]} StartupStep
 */

/**
 * 起動の手順。上から順に呼ぶ。
 * @type {ReadonlyArray<StartupStep>}
 */
const STARTUP_STEPS = Object.freeze([
	['debug', () => ExtDebug.init()],
	['page', () => startPage()],
	['mediaGrid', () => initMediaGrid()],
	['lightboxPanel', () => new LightboxPanel(EXT_CONFIG.lightboxPanel).init()],
	['lightboxGuard', () => new LightboxGuard(EXT_CONFIG.lightboxGuard).init()]
]);

/** 起動する手順の名前 (呼ぶ順)。 */
export const STARTUP_ORDER = Object.freeze(STARTUP_STEPS.map(([name]) => name));

/**
 * 手順を順に呼ぶ。1 つが投げても残りは起動する。
 * (旧方式ではファイルごとに別のスクリプトとして動いていたため、1 つの失敗が他を止めなかった)
 * 手順が返す Promise は待たずに次へ進み (呼ぶ順だけを保つ)、拒否されたらその場で記録する。
 * @param {ReadonlyArray<StartupStep>} steps 起動の手順
 * @returns {void}
 */
export function start(steps) {
	for (const [name, run] of steps) {
		const report = (error) => console.error('[XViewer] 起動に失敗しました', name, error);
		try {
			Promise.resolve(run()).catch(report);
		} catch (error) {
			report(error);
		}
	}
}

// content script としての起動。Node のテストからは document が無いため実行されない
if (typeof document !== 'undefined') {
	start(STARTUP_STEPS);
}
