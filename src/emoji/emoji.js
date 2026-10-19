import {Picker} from 'emoji-mart';
import data from '@emoji-mart/data';
import ja from '@emoji-mart/data/i18n/ja.json';
import {EXT_CONFIG} from '../common/config.js';

/** 絵文字ピッカーの設定 */
const EMOJI = EXT_CONFIG.lightboxReplies.compose.emoji;

/**
 * 親ページ (bsky.app) へ通知を送る。
 * @param {object} message 送る内容 (type を持つ)
 * @returns {void}
 */
function notifyParent(message) {
	try {
		window.parent.postMessage(message, EMOJI.parentOrigin);
	} catch {
		// 親へ届かないときにできることは無い
	}
}

/**
 * ピッカーを作って差し込む。選択・Escape・準備完了・失敗を親へ通知する。
 * @returns {void}
 */
function mount() {
	try {
		const params = new URLSearchParams(location.search);
		const theme = params.get(EMOJI.query.theme) === EMOJI.query.themeLight ? EMOJI.query.themeLight : EMOJI.query.themeDark;
		// iframe の中の配色を載せる側 (パネルの color-scheme) と揃える。食い違うとブラウザが
		// 不透明な地を敷く。値 (dark / light) はそのまま CSS の color-scheme の語として使える
		document.documentElement.style.colorScheme = theme;
		const useJa = params.get(EMOJI.query.locale) === EMOJI.query.localeJa;
		const picker = new Picker({
			data,
			...(useJa ? {i18n: ja, locale: EMOJI.query.localeJa} : {}),
			theme,
			set: 'native',
			previewPosition: 'none',
			perLine: EMOJI.perLine,
			autoFocus: true,
			onEmojiSelect: (emoji) => notifyParent({type: EMOJI.selectType, native: emoji.native})
		});
		document.getElementById(EMOJI.rootId).appendChild(picker);
		document.addEventListener('keydown', (event) => {
			// 検索欄の変換中 (IME) の Escape は変換の取り消しなので閉じない
			if (event.key === EMOJI.closeKey && !event.isComposing) {
				notifyParent({type: EMOJI.closeType});
			}
		});
		requestAnimationFrame(() => notifyParent({type: EMOJI.readyType}));
	} catch {
		notifyParent({type: EMOJI.closeType, error: true});
	}
}

mount();
