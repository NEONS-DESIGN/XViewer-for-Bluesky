/**
 * ライトボックスに重ねたパネルで、入力欄とボタンを使えるようにするリスナー。
 *
 * Bluesky の画像ライトボックスは aria-modal のダイアログで、フォーカスを
 * ダイアログの中に閉じ込める。パネルは body 直下 (ダイアログの外) にあるため、
 * 何もしないとパネルの入力欄を押してもフォーカスがライトボックスのボタンへ
 * 引き戻され、打った文字は入らず、← → は画像送りになる (2026-10-18 実測)。
 * 次の 3 つで避けられることを同日に実機で確かめた:
 * - パネルの focusin を本体の document の focusin に届かせない
 * - window の capture で、パネルへ / パネルから移る focusout だけを止める
 * - パネル内の keydown を本体のキー操作 (画像送り・閉じる) に届かせない
 *
 * 本体の DOM には触れない。リスナーは自分の要素と window に付け、外すときは
 * 登録と同じ関数参照で外す。
 */

/** 文字を打つ要素の tagName */
const TEXT_FIELD_TAGS = Object.freeze(['TEXTAREA', 'INPUT']);

/**
 * パネル内で起きた keydown を本体へ届かせないか。
 * - 入力欄では Escape 以外のキーをすべて止める (← → は文字のカーソル移動にする)
 * - Escape は、どこかの入力欄に書きかけがあるか削除の聞き返し中なら止める
 *   (書きかけを残して送信ボタンなどへ移ったあとに閉じて、書いたものを失わせない)。
 *   それ以外は本体へ通してライトボックスを閉じさせる
 * - 入力欄の外 (パネルのボタン) では ← → の画像送りを残す
 * @param {{key: string, isTextField: boolean, hasDraft: boolean, confirming: boolean}} input
 *   hasDraft はパネルのどこかの入力欄に書きかけがあるか
 * @returns {boolean}
 */
export function shouldStopPanelKey(input) {
	if (input.key === 'Escape') {
		return input.confirming || input.hasDraft;
	}
	return input.isTextField;
}

/**
 * 要素が文字を打つ欄か。
 * @param {*} target keydown の target
 * @returns {boolean}
 */
function isTextField(target) {
	return !!target && (TEXT_FIELD_TAGS.indexOf(target.tagName) !== -1
		|| target.isContentEditable === true);
}

/**
 * パネルにフォーカスとキーのリスナーを付ける。
 * @param {HTMLElement} panelEl パネルの外枠
 * @param {() => {hasDraft: boolean, confirming: boolean}} readState 返信欄の今の状態
 * @param {EventTarget} [win] focusout を capture で受ける先。既定は window
 * @returns {() => void} 外す関数
 */
export function installPanelFocusGuard(panelEl, readState, win) {
	const target = win || window;
	const inPanel = (node) => {
		try {
			return !!node && panelEl.contains(node);
		} catch (error) {
			return false;
		}
	};
	const onFocusIn = (event) => {
		event.stopPropagation();
	};
	const onFocusOut = (event) => {
		if (inPanel(event.target) || inPanel(event.relatedTarget)) {
			event.stopImmediatePropagation();
		}
	};
	const onKeyDown = (event) => {
		let state = {hasDraft: false, confirming: false};
		try {
			state = readState() || state;
		} catch (error) {
			// 状態が読めなければ、何も書いていないものとして扱う
		}
		if (shouldStopPanelKey({
			key: event.key,
			isTextField: isTextField(event.target),
			hasDraft: state.hasDraft === true,
			confirming: state.confirming === true
		})) {
			event.stopPropagation();
		}
	};
	panelEl.addEventListener('focusin', onFocusIn, false);
	panelEl.addEventListener('keydown', onKeyDown, false);
	target.addEventListener('focusout', onFocusOut, true);
	return () => {
		panelEl.removeEventListener('focusin', onFocusIn, false);
		panelEl.removeEventListener('keydown', onKeyDown, false);
		target.removeEventListener('focusout', onFocusOut, true);
	};
}
