/**
 * ライセンスタブと、設定タブの末尾に残す非公式の断り。
 *
 * 帰属の文は NOTICE と同じものを持つ (test/popup-license.test.js が突き合わせる)。
 * 項目を足すときは、ここと NOTICE の両方に足す。
 */
import {POPUP_TEXT} from './sections.js';

/**
 * この拡張機能自身のライセンス。
 * @typedef {Object} ProjectLicense
 * @property {string} name ライセンス名
 * @property {string} copyright 著作権表示
 * @property {string} file 同梱している本文 (拡張機能の根からの相対パス)
 */

/**
 * 同梱している第三者の成果物。
 * @typedef {Object} ThirdPartyLicense
 * @property {string} name 名前
 * @property {string} note この拡張機能のどこで使っているか
 * @property {string} copyright 著作権表示
 * @property {string} license ライセンス名
 * @property {readonly string[]} attribution 帰属の文 (NOTICE と同じ)
 * @property {string} licenseFile 同梱している本文 (拡張機能の根からの相対パス)
 * @property {string} url 配布元
 */

/** @type {Readonly<ProjectLicense>} LICENSE ファイルと一致させる */
export const PROJECT_LICENSE = Object.freeze({
	name: 'MIT License',
	copyright: 'Copyright (c) 2026 NEONS',
	file: 'LICENSE'
});

/** @type {readonly ThirdPartyLicense[]} NOTICE と一致させる */
export const THIRD_PARTY = Object.freeze([
	Object.freeze({
		name: 'Material Symbols',
		note: '画面のアイコンの図形データ',
		copyright: 'Copyright 2023 Google LLC',
		license: 'Apache License, Version 2.0',
		attribution: Object.freeze([
			'Licensed under the Apache License, Version 2.0 (the "License");'
				+ ' you may not use this file except in compliance with the License.'
				+ ' You may obtain a copy of the License at',
			'http://www.apache.org/licenses/LICENSE-2.0',
			'Unless required by applicable law or agreed to in writing, software'
				+ ' distributed under the License is distributed on an "AS IS" BASIS,'
				+ ' WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.'
				+ ' See the License for the specific language governing permissions and'
				+ ' limitations under the License.'
		]),
		licenseFile: 'LICENSES/Apache-2.0.txt',
		url: 'https://github.com/google/material-design-icons'
	}),
	Object.freeze({
		name: 'Emoji Mart (emoji-mart / @emoji-mart/data)',
		note: '返信欄の絵文字の選択画面',
		copyright: 'Copyright (c) Missive.',
		license: 'MIT License',
		attribution: Object.freeze([
			'Licensed under the MIT License.',
			'The above copyright notice and this permission notice shall be included in all'
				+ ' copies or substantial portions of the Software.'
		]),
		licenseFile: 'LICENSES/MIT-emoji-mart.txt',
		url: 'https://github.com/missive/emoji-mart'
	})
]);

/** ライセンスタブの文言 */
const LICENSE_TEXT = Object.freeze({
	headings: Object.freeze({
		disclaimer: '免責事項',
		project: 'この拡張機能のライセンス',
		thirdParty: '同梱している第三者の成果物'
	}),
	disclaimer: Object.freeze([
		'Bluesky 公式の拡張機能ではありません。Bluesky Social PBC が作成・配布するものではなく、'
			+ '同社とは一切関係がありません。提携・支援・推奨を受けたものでもありません。',
		'利用によって生じた一切の結果については、利用者自身が責任を負うものとします。',
		'Bluesky は予告なく機能や画面の作りを変えることがあり、そのときこの拡張機能が動かなくなることがあります。'
	]),
	/**
	 * 同梱している本文の場所の案内。
	 * @param {string} file 拡張機能の根からの相対パス
	 * @returns {string} 案内
	 */
	bundled: (file) => `本文の写しは同梱の ${file} にあります。`
});

/**
 * 外部サイトへのリンクを組み立てる。ポップアップから開くので必ず新しいタブにし、参照元を渡さない。
 * @param {Document} doc 対象のドキュメント
 * @param {string} url 行き先
 * @returns {HTMLAnchorElement} リンク
 */
function createExternalLink(doc, url) {
	const link = doc.createElement('a');
	link.href = url;
	link.textContent = url;
	link.setAttribute('target', '_blank');
	link.setAttribute('rel', 'noopener noreferrer');
	return link;
}

/**
 * 要素を作って文字を入れる。
 * @param {Document} doc 対象のドキュメント
 * @param {string} tag タグ名
 * @param {string} text 中身
 * @param {string} [className] クラス名
 * @returns {HTMLElement} 要素
 */
function textElement(doc, tag, text, className) {
	const element = doc.createElement(tag);
	element.textContent = text;
	if (className) {
		element.className = className;
	}
	return element;
}

/**
 * 設定タブの末尾に残す 1 行を組み立てる。本文はライセンスタブにあるが、
 * タブを切り替えない利用者にも非公式であることだけは届かせる。
 * @param {Document} doc 対象のドキュメント
 * @returns {HTMLElement} 1 行
 */
export function renderBriefDisclaimer(doc) {
	const note = textElement(doc, 'p', POPUP_TEXT.disclaimerBrief, 'disclaimer-brief');
	note.dataset.role = 'disclaimer-brief';
	return note;
}

/**
 * ライセンスタブの中身を組み立てる。
 * @param {Document} doc 対象のドキュメント
 * @returns {HTMLElement} パネル
 */
export function renderLicensePanel(doc) {
	const panel = doc.createElement('div');
	panel.className = 'panel license';
	const {headings} = LICENSE_TEXT;

	const disclaimer = doc.createElement('div');
	disclaimer.className = 'disclaimer';
	disclaimer.dataset.role = 'disclaimer';
	for (const line of LICENSE_TEXT.disclaimer) {
		disclaimer.append(textElement(doc, 'p', line));
	}

	const project = doc.createElement('div');
	project.className = 'license-item';
	project.dataset.role = 'license-project';
	project.append(
		textElement(doc, 'p', `${PROJECT_LICENSE.name} / ${PROJECT_LICENSE.copyright}`),
		textElement(doc, 'p', LICENSE_TEXT.bundled(PROJECT_LICENSE.file), 'description')
	);

	panel.append(
		textElement(doc, 'h2', headings.disclaimer),
		disclaimer,
		textElement(doc, 'h2', headings.project),
		project,
		textElement(doc, 'h2', headings.thirdParty)
	);

	for (const item of THIRD_PARTY) {
		const entry = doc.createElement('div');
		entry.className = 'license-item';
		entry.dataset.role = 'license-third-party';

		const source = doc.createElement('p');
		source.className = 'license-url';
		source.append(createExternalLink(doc, item.url));

		const attribution = doc.createElement('div');
		attribution.className = 'license-attribution';
		for (const line of item.attribution) {
			attribution.append(textElement(doc, 'p', line));
		}

		entry.append(
			textElement(doc, 'h3', item.name),
			textElement(doc, 'p', item.note, 'description'),
			textElement(doc, 'p', `${item.license} / ${item.copyright}`),
			attribution,
			textElement(doc, 'p', LICENSE_TEXT.bundled(item.licenseFile), 'description'),
			source
		);
		panel.append(entry);
	}

	return panel;
}
