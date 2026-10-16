/**
 * 取り返しの付かない操作の確認。
 * ボタンの場所にそのまま確認の行を出す。window.confirm() はネイティブのダイアログが
 * ポップアップの上に浮き、環境によってはポップアップが閉じて操作が途切れる。
 */

/** 確認の行を取り消すキー */
const CANCEL_KEY = 'Escape';

/**
 * 確認の行の文言と目印。
 * @typedef {Object} ConfirmSpec
 * @property {string} role data-role の接頭辞
 * @property {string} label ボタンの文言
 * @property {string} description 確認の行に出す説明 (読み上げ名にもなる)
 * @property {string} cancel やめる側の文言
 * @property {string} confirm 実行する側の文言
 */

/**
 * ボタンと、押した後の確認の行を組み立てる。
 * data-role は spec.role を接頭辞にする: `{role}` (ボタン) / `{role}-confirmation` (行) /
 * `{role}-cancel` (やめる) / `{role}-confirm` (実行する)。
 * @param {Document} doc 対象のドキュメント
 * @param {ConfirmSpec} spec 文言と目印
 * @param {() => void} onConfirm 実行を確定したときの処理
 * @returns {HTMLElement} 置き場 (ボタンと確認の行を入れ替える)
 */
export function renderConfirmRow(doc, spec, onConfirm) {
	const holder = doc.createElement('div');
	holder.className = 'confirm';

	const trigger = doc.createElement('button');
	trigger.type = 'button';
	trigger.textContent = spec.label;
	trigger.dataset.role = spec.role;

	/**
	 * 確認の行を片付けて元のボタンへ戻す。フォーカスも戻す
	 * (確認の行ごとフォーカスの当たっていた要素が消えると、キーボード操作の現在地が失われる)。
	 * @returns {void}
	 */
	function showButton() {
		holder.replaceChildren(trigger);
		trigger.focus();
	}

	/**
	 * ボタンを確認の行に置き換える。「やめる」を左 (元のボタンと同じ位置) に置き、
	 * フォーカスもそこへ移す。連打で 2 回目の入力が実行側に落ちないようにするため。
	 * @returns {void}
	 */
	function showConfirmation() {
		const row = doc.createElement('div');
		row.className = 'confirmation';
		row.dataset.role = `${spec.role}-confirmation`;
		row.setAttribute('role', 'group');
		row.setAttribute('aria-label', spec.description);

		const text = doc.createElement('p');
		text.className = 'description';
		text.textContent = spec.description;

		const buttons = doc.createElement('div');
		buttons.className = 'confirm-buttons';

		const cancel = doc.createElement('button');
		cancel.type = 'button';
		cancel.textContent = spec.cancel;
		cancel.dataset.role = `${spec.role}-cancel`;
		cancel.addEventListener('click', showButton);

		const confirm = doc.createElement('button');
		confirm.type = 'button';
		// 戻せない側を色で区別する (--danger は取り消せない操作専用)
		confirm.className = 'danger';
		confirm.textContent = spec.confirm;
		confirm.dataset.role = `${spec.role}-confirm`;
		// 確定は 1 つの行につき 1 回だけ。素早く 2 回押されても 2 回走らせない
		let confirmed = false;
		confirm.addEventListener('click', () => {
			if (confirmed) {
				return;
			}
			confirmed = true;
			onConfirm();
		});

		row.addEventListener('keydown', (event) => {
			if (event.key !== CANCEL_KEY) {
				return;
			}
			event.preventDefault();
			showButton();
		});

		buttons.append(cancel, confirm);
		row.append(text, buttons);
		holder.replaceChildren(row);
		cancel.focus();
	}

	trigger.addEventListener('click', showConfirmation);
	holder.append(trigger);
	return holder;
}
