/**
 * ポップアップのエントリ。
 * 組み立てと保存の橋渡しは app.js が持つ。ここは実物の document と保存領域で起動するだけ。
 * popup.html は <script type="module"> で読む。module は defer 相当で、DOM の解析後に走る。
 */
import {main} from './app.js';

void main({doc: document, storage: globalThis.chrome?.storage?.sync ?? null}).catch((error) => {
	// ここまで来ると画面が空のままなので、原因を残して気づけるようにする
	console.error('[Bluesky拡張] ポップアップの起動に失敗しました', error);
});
