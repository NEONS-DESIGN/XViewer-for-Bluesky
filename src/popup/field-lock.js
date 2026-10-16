/**
 * 親の項目が OFF のとき、子の項目のスイッチを押せなくする。
 *
 * disabled は使わず aria-disabled で見せる。disabled にすると押しても何も届かず、
 * なぜ押せないのかを伝えられないため。押されたら切り替えを止め、項目の下に警告の行を出す。
 * 出した警告はしばらくすると消え、親が ON になったときにも消える。子の保存値は変えない。
 */
import {createIcon} from '../common/icons.js';

/** 警告を出しておく時間 (ミリ秒) */
export const LOCK_WARNING_MS = 4000;

/** ロック中の項目の入れ物に付ける印。見た目 (薄く・押せないカーソル) は popup.css がこれで決める */
export const LOCKED_CLASS = 'is-locked';

/** 警告の行に添えるアイコン。色だけに頼らず形でも示す */
const WARNING_ICON = 'error';

/** 読み上げの結び付け (aria-describedby) */
const DESCRIBED_BY = 'aria-describedby';

/**
 * 空白区切りの属性値へ語を足す・外す。
 * @param {Element} element 対象
 * @param {string} name 属性名
 * @param {string} token 語
 * @param {boolean} present 足すなら true
 * @returns {void}
 */
function toggleToken(element, name, token, present) {
	const tokens = (element.getAttribute(name) ?? '').split(/\s+/).filter((one) => one && one !== token);
	if (present) {
		tokens.push(token);
	}
	if (tokens.length > 0) {
		element.setAttribute(name, tokens.join(' '));
	} else {
		element.removeAttribute(name);
	}
}

/**
 * ロックの操作口。
 * @typedef {Object} FieldLock
 * @property {(locked: boolean) => void} setLocked ロックを切り替える。外したら警告も消す
 * @property {() => boolean} isLocked 今ロックしているか
 * @property {() => void} dispose タイマーを止める
 */

/**
 * スイッチの項目にロックの振る舞いを付ける。
 * @param {Document} doc 対象のドキュメント
 * @param {Object} options 設定
 * @param {HTMLElement} options.wrapper 項目の入れ物。印 (LOCKED_CLASS) を付け、警告の行を足す
 * @param {HTMLInputElement} options.control スイッチ
 * @param {string} options.key 設定キー。警告の行の id と data-role の元にする
 * @param {string} options.message 押されたときに出す警告
 * @param {{setTimeout?: Function, clearTimeout?: Function}} [options.timers] タイマーの差し替え
 * @returns {FieldLock} ロックの操作口
 */
export function attachFieldLock(doc, {wrapper, control, key, message, timers = {}}) {
	const later = timers.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
	const cancel = timers.clearTimeout ?? ((id) => clearTimeout(id));
	let locked = false;
	let timer = null;

	const warningId = `${key}-lock`;
	const warning = doc.createElement('p');
	warning.className = 'field-lock-warning';
	warning.setAttribute('id', warningId);
	warning.dataset.role = warningId;
	// 出たときに読み上げへも届くよう status にする
	warning.setAttribute('role', 'status');
	warning.hidden = true;
	const text = doc.createElement('span');
	warning.append(createIcon(doc, WARNING_ICON), text);
	wrapper.append(warning);

	/**
	 * 警告を消す。
	 * @returns {void}
	 */
	function hideWarning() {
		if (timer !== null) {
			cancel(timer);
		}
		timer = null;
		warning.hidden = true;
		text.textContent = '';
		toggleToken(control, DESCRIBED_BY, warningId, false);
	}

	/**
	 * 警告を出し、しばらくしたら消す。続けて押されたら消すまでの時間を延ばす。
	 * @returns {void}
	 */
	function showWarning() {
		text.textContent = message;
		warning.hidden = false;
		toggleToken(control, DESCRIBED_BY, warningId, true);
		if (timer !== null) {
			cancel(timer);
		}
		timer = later(hideWarning, LOCK_WARNING_MS);
		// テスト (Node) でタイマーがプロセスを待たせないようにする。ブラウザには無いので呼べるときだけ
		timer?.unref?.();
	}

	/**
	 * ロック中のクリックを止めて警告を出す。チェックボックスは click の既定動作を止めれば
	 * 切り替わらない。ラベルを押したときも同じ click がスイッチに届く。
	 * @param {Event} event クリック
	 * @returns {void}
	 */
	function block(event) {
		if (!locked) {
			return;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
		showWarning();
	}

	// 項目の処理より先に止めるため、捕捉で登録する
	control.addEventListener('click', block, true);

	return {
		setLocked(next) {
			locked = next;
			wrapper.classList.toggle(LOCKED_CLASS, next);
			if (next) {
				control.setAttribute('aria-disabled', 'true');
			} else {
				control.removeAttribute('aria-disabled');
				hideWarning();
			}
		},
		isLocked() {
			return locked;
		},
		dispose() {
			if (timer !== null) {
				cancel(timer);
			}
			timer = null;
		}
	};
}
