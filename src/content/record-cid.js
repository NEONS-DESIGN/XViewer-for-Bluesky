/**
 * 投稿の record から CID を求める道具と、TID (rkey) の符号化。
 * 連なる返信の親の CID を送信前に手元で決めるために使う。実行時の依存は持たない。
 */
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';

/** TID の文字表。並べ替えても時刻順になる。 */
export const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const TID_LENGTH = 13;
/** TID の形。橋渡しが rkey に課す形と同じものを使う */
const TID_PATTERN = new RegExp(BRIDGE_PROTOCOL.thread.tidPattern);
const CLOCK_ID_MASK = 1023;
const CLOCK_ID_BITS = 10n;
const CID_PREFIX = [0x01, 0x71, 0x12, 0x20];
const CBOR_TAG_CID = 42;

const MAJOR_UNSIGNED = 0;
const MAJOR_NEGATIVE = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;
const MAJOR_SIMPLE = 7;

const textEncoder = new TextEncoder();

/**
 * 小文字・パディング無しの base32 (RFC 4648) を文字列にする。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base32Encode(bytes) {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		value &= (1 << bits) - 1;
	}
	if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

/**
 * 小文字・パディング無しの base32 を復号する。
 * @param {string} text
 * @returns {Uint8Array}
 */
function base32Decode(text) {
	const out = [];
	let bits = 0;
	let value = 0;
	for (const ch of text) {
		const index = BASE32_ALPHABET.indexOf(ch);
		if (index < 0) throw new TypeError('base32 に使えない文字がある');
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
			value &= (1 << bits) - 1;
		}
	}
	return Uint8Array.from(out);
}

/**
 * CBOR の頭 (種別 + 値) を最短の形で作る。
 * @param {number} major 0〜7
 * @param {number} n 0 以上の安全な整数
 * @returns {number[]}
 */
function head(major, n) {
	const m = major << 5;
	if (n < 24) return [m | n];
	if (n < 0x100) return [m | 24, n];
	if (n < 0x10000) return [m | 25, n >>> 8, n & 255];
	if (n < 0x100000000) return [m | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
	const big = BigInt(n);
	const out = [m | 27];
	for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((big >> shift) & 255n));
	return out;
}

/**
 * 2 つのバイト列を辞書順に比べる。
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {number}
 */
function compareBytes(a, b) {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}

/**
 * 値を DAG-CBOR のバイト列にする。対応は整数 (安全な整数のみ)・文字列・配列・map・
 * true / false / null・{$link}・{$bytes}。値が undefined のキーは落とす。
 * @param {*} value
 * @returns {Uint8Array}
 * @throws {TypeError} 小数・NaN・未知の型のとき
 */
export function encodeDagCbor(value) {
	const chunks = [];
	pushValue(value, chunks);
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

/**
 * @param {*} value
 * @param {Array<ArrayLike<number>>} chunks 出力先
 */
function pushValue(value, chunks) {
	if (value === null) {
		chunks.push([(MAJOR_SIMPLE << 5) | 22]);
		return;
	}
	if (value === true || value === false) {
		chunks.push([(MAJOR_SIMPLE << 5) | (value ? 21 : 20)]);
		return;
	}
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value)) throw new TypeError('整数以外の数は扱えない');
		if (value >= 0) chunks.push(head(MAJOR_UNSIGNED, value));
		else chunks.push(head(MAJOR_NEGATIVE, -1 - value));
		return;
	}
	if (typeof value === 'string') {
		const bytes = textEncoder.encode(value);
		chunks.push(head(MAJOR_TEXT, bytes.length), bytes);
		return;
	}
	if (Array.isArray(value)) {
		chunks.push(head(MAJOR_ARRAY, value.length));
		for (const item of value) pushValue(item, chunks);
		return;
	}
	if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
		const keys = Object.keys(value);
		if (keys.length === 1 && keys[0] === '$link' && typeof value.$link === 'string') {
			const raw = base32Decode(value.$link.slice(1));
			const bytes = new Uint8Array(raw.length + 1);
			bytes.set(raw, 1);
			chunks.push(head(MAJOR_TAG, CBOR_TAG_CID), head(MAJOR_BYTES, bytes.length), bytes);
			return;
		}
		if (keys.length === 1 && keys[0] === '$bytes' && typeof value.$bytes === 'string') {
			const binary = atob(value.$bytes);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			chunks.push(head(MAJOR_BYTES, bytes.length), bytes);
			return;
		}
		const entries = keys
			.filter((key) => value[key] !== undefined)
			.map((key) => ({key, bytes: textEncoder.encode(key)}));
		entries.sort((x, y) => (x.bytes.length - y.bytes.length) || compareBytes(x.bytes, y.bytes));
		chunks.push(head(MAJOR_MAP, entries.length));
		for (const entry of entries) {
			chunks.push(head(MAJOR_TEXT, entry.bytes.length), entry.bytes);
			pushValue(value[entry.key], chunks);
		}
		return;
	}
	throw new TypeError('DAG-CBOR にできない型');
}

/**
 * record の CID (CIDv1・dag-cbor・sha2-256) を、b で始まる base32 小文字で返す。
 * @param {Object} record
 * @returns {Promise<string>}
 */
export async function computeRecordCid(record) {
	const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encodeDagCbor(record)));
	const cid = new Uint8Array(CID_PREFIX.length + digest.length);
	cid.set(CID_PREFIX, 0);
	cid.set(digest, CID_PREFIX.length);
	return 'b' + base32Encode(cid);
}

/**
 * マイクロ秒の時刻と clockId から TID (13 文字) を作る。
 * @param {number} micros
 * @param {number} clockId 下位 10 ビットだけを使う
 * @returns {string}
 */
export function encodeTid(micros, clockId) {
	let value = (BigInt(micros) << CLOCK_ID_BITS) | BigInt(clockId & CLOCK_ID_MASK);
	let out = '';
	for (let i = 0; i < TID_LENGTH; i++) {
		out = TID_ALPHABET[Number(value & 31n)] + out;
		value >>= 5n;
	}
	return out;
}

/**
 * TID を時刻と clockId に戻す。形が合わなければ null。
 * @param {string} tid
 * @returns {{micros: number, clockId: number}|null}
 */
export function decodeTid(tid) {
	if (typeof tid !== 'string' || !TID_PATTERN.test(tid)) return null;
	let value = 0n;
	for (const ch of tid) value = (value << 5n) | BigInt(TID_ALPHABET.indexOf(ch));
	return {
		micros: Number(value >> CLOCK_ID_BITS),
		clockId: Number(value & BigInt(CLOCK_ID_MASK)),
	};
}

/**
 * 前の TID より必ず大きい次の TID を返す。時刻が戻っていても前の時刻 + 1 にする。
 * @param {string|null} previous
 * @param {number} nowMicros
 * @param {number} clockId
 * @returns {string}
 */
export function nextTid(previous, nowMicros, clockId) {
	const decoded = previous ? decodeTid(previous) : null;
	const micros = decoded ? Math.max(nowMicros, decoded.micros + 1) : nowMicros;
	return encodeTid(micros, clockId);
}
