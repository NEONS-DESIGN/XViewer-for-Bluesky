/**
 * 返信の一覧の動画を再生する束。Chrome は HLS を直接再生できない (canPlayType が
 * maybe を返しても再生は始まらない) ため、hls.js で MSE に流す。
 * 使うときだけ content script が import() で読み込む。
 */

import Hls from 'hls.js';

/**
 * video に HLS の playlist をつなぐ。致命的なエラーでは video に error を出して止める。
 * @param {HTMLVideoElement} video 再生先
 * @param {string} url playlist (.m3u8) の URL
 * @returns {{destroy: () => void}} 後始末
 * @throws {Error} hls.js が使えない環境のとき
 */
export function attachHls(video, url) {
	if (!Hls.isSupported()) {
		throw new Error('hls.js is not supported');
	}
	const hls = new Hls({enableWorker: false});
	hls.on(Hls.Events.ERROR, (_event, data) => {
		if (data && data.fatal) {
			try {
				hls.destroy();
			} finally {
				video.dispatchEvent(new Event('error'));
			}
		}
	});
	hls.loadSource(url);
	hls.attachMedia(video);
	return {
		destroy() {
			try {
				hls.destroy();
			} catch (_e) {
				// 破棄済みなら何もしない
			}
		}
	};
}
