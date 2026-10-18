/**
 * ライトボックスに重ねたパネルの上で、ファイルのドロップをブラウザに開かせないリスナー。
 *
 * 返信の入力欄は自分の上に落とされた画像を取り込むが、パネルのそれ以外の場所
 * (本文・返信の一覧・入力欄の外の余白) にファイルを落とすと、ブラウザの既定の動作で
 * そのファイルを開いてタブが遷移し、書きかけの返信が消える。パネル全体で
 * ファイルのドラッグの既定の動作を止め、受けないこと (dropEffect) を見せる。
 * 取り込みは入力欄だけが行い、ここでは何も取り込まない。
 *
 * 入力欄が既に既定の動作を止めた dragover には触れない (入力欄の dropEffect を残す)。
 * 本体の DOM には触れない。リスナーはパネルの要素に付け、外すときは登録と同じ関数参照で外す。
 */

/**
 * ドラッグの中身にファイルが含まれるか。
 * types の 'Files' (dragover の間も読める) か、items の kind === 'file' で判断する。
 * @param {*} transfer DragEvent の dataTransfer
 * @returns {boolean}
 */
export function isFileDrag(transfer) {
	if (!transfer) return false;
	try {
		const types = transfer.types;
		if (types && Array.from(types).indexOf('Files') !== -1) return true;
		const items = transfer.items;
		if (!items) return false;
		for (let index = 0; index < items.length; index += 1) {
			if (items[index] && items[index].kind === 'file') return true;
		}
	} catch (error) {
		return false;
	}
	return false;
}

/**
 * パネルにファイルのドロップを止めるリスナーを付ける。
 * @param {HTMLElement} panelEl パネルの外枠
 * @param {string} noDropEffect 受けないときの dropEffect ('none')
 * @returns {() => void} 外す関数 (何度呼んでもよい)
 */
export function installPanelDropGuard(panelEl, noDropEffect) {
	const onDragOver = (event) => {
		if (event.defaultPrevented || !isFileDrag(event.dataTransfer)) return;
		event.preventDefault();
		try {
			event.dataTransfer.dropEffect = noDropEffect;
		} catch (error) {
			// dropEffect を書けなくても既定の動作は止めてある
		}
	};
	const onDrop = (event) => {
		if (!isFileDrag(event.dataTransfer)) return;
		event.preventDefault();
	};
	panelEl.addEventListener('dragover', onDragOver);
	panelEl.addEventListener('drop', onDrop);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		panelEl.removeEventListener('dragover', onDragOver);
		panelEl.removeEventListener('drop', onDrop);
	};
}
