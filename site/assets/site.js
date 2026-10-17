/**
 * 紹介サイトの最小限の動き。配色の切り替え、動画の停止ボタン、静止画の自動切り替え、先頭へ戻るボタンの出し入れ、言語メニューを閉じる操作の 5 つだけを持つ。(動画と静止画の切り替えは今のページには無いが、図を足したときにそのまま使える)
 * 言語の切り替えと先頭へ戻る動作そのものはただのリンクなので JS は関与しない。(JS が無くても読める)
 */
(function () {
	'use strict';

	/** localStorage に配色を覚えるときの鍵。 */
	var STORAGE_KEY = 'xvbluesky-site-theme';

	/** 明示的に選べる配色。無指定 (null) のときは OS の設定に従う。 */
	var THEMES = { DARK: 'dark', LIGHT: 'light' };

	/**
	 * 保存済みの配色を読む。使えない環境 (プライベートウィンドウ等) では null。
	 * @returns {string|null} 'dark' / 'light' / null
	 */
	function readStored() {
		try {
			var value = window.localStorage.getItem(STORAGE_KEY);
			return value === THEMES.DARK || value === THEMES.LIGHT ? value : null;
		} catch (error) {
			return null;
		}
	}

	/**
	 * 配色を保存する。失敗しても表示は続ける。
	 * @param {string} theme 'dark' または 'light'
	 * @returns {void}
	 */
	function store(theme) {
		try {
			window.localStorage.setItem(STORAGE_KEY, theme);
		} catch (error) {
			// 保存できなくてもその場の切り替えは効く
		}
	}

	/**
	 * OS 側の設定を読む。matchMedia が無い環境ではダーク扱い。
	 * @returns {string} 'dark' または 'light'
	 */
	function systemTheme() {
		if (!window.matchMedia) return THEMES.DARK;
		return window.matchMedia('(prefers-color-scheme: light)').matches ? THEMES.LIGHT : THEMES.DARK;
	}

	/**
	 * 今あてられている配色。属性が無ければ OS の設定を答える。
	 * @returns {string} 'dark' または 'light'
	 */
	function currentTheme() {
		var attribute = document.documentElement.getAttribute('data-theme');
		if (attribute === THEMES.DARK || attribute === THEMES.LIGHT) return attribute;
		return systemTheme();
	}

	/**
	 * 配色をあてる。ボタンの読み上げ文言も合わせて直す。
	 * @param {string} theme 'dark' または 'light'
	 * @param {HTMLElement|null} button 切り替えボタン
	 * @returns {void}
	 */
	function apply(theme, button) {
		document.documentElement.setAttribute('data-theme', theme);
		if (!button) return;
		var toLight = theme === THEMES.DARK;
		button.setAttribute('aria-label', button.getAttribute(toLight ? 'data-label-light' : 'data-label-dark') || '');
	}

	/**
	 * OS の「動きを減らす」設定を、自動再生の可否にまで効かせるか。
	 * true にすると、その設定の人には最初から止めた状態で見せる。
	 * 既定は false。止める手段 (停止ボタン) は常に出しているので WCAG 2.2.2 は満たす。
	 */
	var PAUSE_WHEN_CALM = false;

	/**
	 * 自動再生する動画に停止ボタンを配線する。
	 * 5 秒を超えて自動で動くものには止める手段が要る。(WCAG 2.2.2)
	 * @returns {void}
	 */
	function wireVideos() {
		var calm = PAUSE_WHEN_CALM
			&& Boolean(window.matchMedia) && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		var figures = document.querySelectorAll('figure.has-video');
		for (var i = 0; i < figures.length; i += 1) {
			wireOne(figures[i], calm);
		}
	}

	/**
	 * 動画 1 つ分の配線。
	 * @param {HTMLElement} figure video と .media-toggle を含む入れ物
	 * @param {boolean} calm 最初から止めておくか
	 * @returns {void}
	 */
	function wireOne(figure, calm) {
		var video = figure.querySelector('video');
		var button = figure.querySelector('.media-toggle');
		if (!video || !button) return;

		/**
		 * ボタンの見た目と読み上げ文言を今の状態に合わせる。
		 * @returns {void}
		 */
		function sync() {
			var paused = video.paused;
			button.setAttribute('data-state', paused ? 'paused' : 'playing');
			button.setAttribute('aria-label', button.getAttribute(paused ? 'data-label-play' : 'data-label-pause') || '');
		}

		if (calm) {
			video.removeAttribute('autoplay');
			try {
				video.pause();
			} catch (error) {
				// 再生前に呼ばれても問題にしない
			}
		}

		button.addEventListener('click', function () {
			if (video.paused) {
				// 自動再生を拒まれることがある。失敗しても表示は保つ
				var played = video.play();
				if (played && typeof played.catch === 'function') played.catch(function () { sync(); });
			} else {
				video.pause();
			}
		});
		video.addEventListener('play', sync);
		video.addEventListener('pause', sync);
		sync();
	}

	/**
	 * 重ねた静止画を 1 枚見せておく時間。(ミリ秒) 切り替えのフェード (style.css の --slide-fade) もこの中に含まれる。
	 */
	var SLIDE_INTERVAL_MS = 4000;

	/**
	 * 重ねた静止画を一定時間ごとに入れ替える図に配線する。
	 * 動画と同じく 5 秒を超えて自動で動くので、止めるボタンを添える。(WCAG 2.2.2)
	 * @returns {void}
	 */
	function wireSlides() {
		var calm = PAUSE_WHEN_CALM
			&& Boolean(window.matchMedia) && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		var figures = document.querySelectorAll('figure.has-slides');
		for (var i = 0; i < figures.length; i += 1) {
			wireSlideshow(figures[i], calm);
		}
	}

	/**
	 * 入れ替える図 1 つ分の配線。
	 * @param {HTMLElement} figure 重ねた img と .media-toggle を含む入れ物
	 * @param {boolean} calm 最初から止めておくか
	 * @returns {void}
	 */
	function wireSlideshow(figure, calm) {
		var slides = figure.querySelectorAll('img');
		var button = figure.querySelector('.media-toggle');
		if (slides.length < 2 || !button) return;
		var index = 0;
		var timer = null;

		/**
		 * 次の 1 枚へ送る。最後まで行ったら最初へ戻る。
		 * @returns {void}
		 */
		function advance() {
			slides[index].removeAttribute('data-active');
			index = (index + 1) % slides.length;
			slides[index].setAttribute('data-active', '');
		}

		/**
		 * ボタンの見た目と読み上げ文言を今の状態に合わせる。
		 * @returns {void}
		 */
		function sync() {
			var paused = timer === null;
			button.setAttribute('data-state', paused ? 'paused' : 'playing');
			button.setAttribute('aria-label', button.getAttribute(paused ? 'data-label-play' : 'data-label-pause') || '');
		}

		/**
		 * 自動の入れ替えを始める。
		 * @returns {void}
		 */
		function play() {
			if (timer !== null) return;
			timer = window.setInterval(advance, SLIDE_INTERVAL_MS);
			sync();
		}

		/**
		 * 自動の入れ替えを止める。今見えている 1 枚のまま残す。
		 * @returns {void}
		 */
		function pause() {
			if (timer === null) return;
			window.clearInterval(timer);
			timer = null;
			sync();
		}

		button.addEventListener('click', function () {
			if (timer === null) play(); else pause();
		});
		if (calm) sync(); else play();
	}

	/**
	 * 先頭へ戻るボタンを出すまでのスクロール量。画面の高さに対する倍率。(1 = 1 画面分)
	 */
	var TO_TOP_AFTER_SCREENS = 1;

	/**
	 * 先頭へ戻るボタンを、1 画面分スクロールしたときだけ出す。
	 * 飛ぶ動作は href="#top" のリンクに任せる。(JS が無いときは data-js が付かず、常に出たままになる)
	 * @returns {void}
	 */
	function wireToTop() {
		var button = document.querySelector('.to-top');
		if (!button) return;
		var pending = false;

		/**
		 * 今のスクロール量に合わせて出し入れする。
		 * @returns {void}
		 */
		function update() {
			pending = false;
			var threshold = window.innerHeight * TO_TOP_AFTER_SCREENS;
			// 隠すのは head の先読みが付ける data-js と style.css の役目。ここは出すときの印だけを持つ
			if (window.scrollY >= threshold) {
				button.setAttribute('data-shown', '');
			} else {
				button.removeAttribute('data-shown');
			}
		}

		/**
		 * スクロールのたびに計算しないよう、描画 1 回につき 1 度にまとめる。
		 * @returns {void}
		 */
		function schedule() {
			if (pending) return;
			pending = true;
			window.requestAnimationFrame(update);
		}

		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule, { passive: true });
		update();
	}

	/**
	 * 言語メニュー (details) に、外側のクリックと Esc で閉じる動きを足す。
	 * 開閉そのものは details の既定の動きで、JS が無くても言語は選べる。
	 * @returns {void}
	 */
	function wireLangMenu() {
		var menu = document.querySelector('.lang-menu');
		if (!menu) return;
		var summary = menu.querySelector('summary');

		document.addEventListener('click', function (event) {
			if (menu.open && !menu.contains(event.target)) menu.open = false;
		});
		document.addEventListener('keydown', function (event) {
			if (event.key !== 'Escape' || !menu.open) return;
			menu.open = false;
			// 閉じた後もキーボードで続けられるよう、開いたボタンへ戻す
			if (summary) summary.focus();
		});
	}

	document.addEventListener('DOMContentLoaded', function () {
		wireVideos();
		wireSlides();
		wireToTop();
		wireLangMenu();
		var button = document.querySelector('.theme-toggle');
		var stored = readStored();
		// head の先読みスクリプトが既に属性を付けている。ここでは文言だけ合わせる
		apply(stored || currentTheme(), button);
		if (!button) return;

		button.addEventListener('click', function () {
			var next = currentTheme() === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK;
			apply(next, button);
			store(next);
		});
	});
})();
