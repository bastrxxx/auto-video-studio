// Text helpers: normalisation, fuzzy matching (for retakes), fillers, keywords, emoji and numbers.
import type {Word} from '../../shared/types.js';

export const norm = (t: string) =>
	t
		.toLowerCase()
		.normalize('NFC')
		.replace(/[^\p{L}\p{N}%$]+/gu, '')
		.trim();

/** strip Vietnamese diacritics for fuzzy comparisons */
export const fold = (t: string) =>
	norm(t)
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/đ/g, 'd');

export const FILLERS = new Set([
	// English
	'um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mhm',
	// Vietnamese
	'hum', 'ơ', 'ờ', 'ừ', 'ừm', 'ừa', 'à', 'ầ', 'ứ', 'hừm', 'ờm',
]);

// fillers that are real words in Vietnamese ("à" in "à vâng", "ừ" = yes): only cut when isolated by pauses
export const isFiller = (w: Word, prev?: Word, next?: Word) => {
	const n = norm(w.text);
	if (!n) return false;
	const strong = ['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'hmm', 'hm', 'mm', 'mhm', 'ừm', 'hừm', 'ơ', 'ờ', 'ầ', 'ahh', 'uhh'];
	if (strong.includes(n)) return true;
	if (!FILLERS.has(n)) return false;
	const gapBefore = prev ? w.start - prev.end : 1;
	const gapAfter = next ? next.start - w.end : 1;
	return gapBefore > 0.25 && gapAfter > 0.2;
};

export const RETAKE_CUES = [
	'làm lại', 'quay lại', 'nói lại', 'lại nhé', 'lại từ đầu', 'cắt đoạn', 'cắt cái', 'xin lỗi nói lại', 'thôi lại',
	'again', 'one more time', 'let me start over', 'start over', 'let me redo', 'redo that', 'take two', 'from the top',
	'sorry let me', 'scratch that', 'let me try that again',
];

/** longest common subsequence length on token arrays (fuzzy token equality) */
export const lcs = (a: string[], b: string[]) => {
	const m = a.length;
	const n = b.length;
	if (!m || !n) return 0;
	const dp = new Array(n + 1).fill(0);
	for (let i = 1; i <= m; i++) {
		let prev = 0;
		for (let j = 1; j <= n; j++) {
			const tmp = dp[j];
			dp[j] = tokEq(a[i - 1], b[j - 1]) ? prev + 1 : Math.max(dp[j], dp[j - 1]);
			prev = tmp;
		}
	}
	return dp[n];
};

/** tokens are equal, tolerating inflections (ghost-editor takes.py uses inflection-tolerant equality) */
export const tokEq = (x: string, y: string) => {
	if (x === y) return true;
	if (x.length >= 5 && y.length >= 5) {
		const k = Math.min(x.length, y.length) - 2;
		return x.slice(0, k) === y.slice(0, k);
	}
	return false;
};

const STOP = new Set(
	(
		'the a an and or but so to of in on at for with is are was were be been it this that i you we they he she my your our ' +
		'me us them do does did have has had not no yes just really very like can will would should could about what when how ' +
		'là và của có không được cho với những các một này đó thì mà cũng rất đã đang sẽ ở trong ra vào lên như để khi nếu bạn ' +
		'mình tôi chúng ta em anh chị nó họ ấy nhé nha ạ à ừ vậy thế rồi nữa lại đi làm nói biết thấy'
	).split(/\s+/),
);

export const isStop = (t: string) => STOP.has(norm(t));

// --- numbers -------------------------------------------------------------
const NUM_WORDS_EN: Record<string, number> = {
	one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
	fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000,
};
const NUM_WORDS_VI: Record<string, number> = {
	mười: 10, trăm: 100, nghìn: 1000, ngàn: 1000, triệu: 1_000_000, tỷ: 1_000_000_000, tỉ: 1_000_000_000,
};

export type NumberHit = {value: number; prefix: string; suffix: string; decimals: number; label: string; words: number};

/** a number the speaker says that deserves a big card ("50%", "$3,000", "10 triệu", "two million") */
export const findNumber = (words: Word[], i: number): NumberHit | null => {
	const raw = words[i].text.replace(/[,]+$/, '');
	const m = /^([$€£₫]?)(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)(%|k|K|M|đ|\$)?[.!?…]*$/.exec(raw);
	if (m) {
		const vi = /\d{1,3}(\.\d{3})+$/.test(m[2]); // Vietnamese thousands separator "1.000"
		const numStr = vi ? m[2].replace(/\./g, '') : m[2].replace(/,/g, '');
		let value = parseFloat(numStr.replace(',', '.'));
		if (!Number.isFinite(value)) return null;
		let suffix = m[3] || '';
		let prefix = m[1] || '';
		let used = 1;
		const next = words[i + 1] ? norm(words[i + 1].text) : '';
		const unitMap: Record<string, string> = {
			percent: '%', phần: '%', 'phầntrăm': '%', triệu: ' triệu', tỷ: ' tỷ', tỉ: ' tỷ', nghìn: 'K', ngàn: 'K', k: 'K',
			million: 'M', billion: 'B', thousand: 'K', đô: '$', dollars: '$', usd: '$', đồng: 'đ', năm: ' năm', years: ' năm',
			ngày: ' ngày', days: ' days', giờ: 'h', hours: 'h', phút: "'", minutes: ' min', người: ' người', people: '', lần: 'x', x: 'x',
		};
		if (!suffix && unitMap[next] !== undefined) {
			let u = unitMap[next];
			if (next === 'phần' && words[i + 2] && norm(words[i + 2].text) === 'trăm') used++;
			if (u === '$') {
				prefix = '$';
				u = '';
			}
			suffix = u;
			used++;
		}
		// tiny bare numbers ("1", "2") are list markers, not claims
		if (!suffix && !prefix && value < 10) return null;
		if (/^(19|20)\d\d$/.test(numStr) && !suffix) return null; // a year
		const decimals = numStr.includes('.') || numStr.includes(',') ? Math.min(2, (numStr.split(/[.,]/)[1] || '').length) : 0;
		if (vi) value = parseFloat(numStr);
		return {value, prefix, suffix, decimals: vi ? 0 : decimals, label: raw, words: used};
	}
	const n = norm(raw);
	const v = NUM_WORDS_EN[n] ?? NUM_WORDS_VI[n];
	if (v && v >= 100) {
		return {value: v, prefix: '', suffix: '', decimals: 0, label: raw, words: 1};
	}
	return null;
};

// --- emoji (ghost-editor "emoji" beats: a feeling, next to the head) ------
const EMOJI: [RegExp, string][] = [
	[/^(money|cash|tiền|lương|thu nhập|income|profit|lợi nhuận|rich|giàu|dollars?|đô)$/, '💰'],
	[/^(fire|lửa|hot|viral|cháy|bùng nổ)$/, '🔥'],
	[/^(love|yêu|thương|tim|heart)$/, '❤️'],
	[/^(idea|ý tưởng|insight|bí quyết|secret|bí mật)$/, '💡'],
	[/^(time|thời gian|giờ|hours?|deadline)$/, '⏰'],
	[/^(rocket|launch|ra mắt|tăng trưởng|growth|scale)$/, '🚀'],
	[/^(warning|cảnh báo|nguy hiểm|danger|careful|cẩn thận|sai lầm|mistake|mistakes)$/, '⚠️'],
	[/^(think|nghĩ|suy nghĩ|wonder|hmm)$/, '🤔'],
	[/^(crazy|điên|insane|wow|shocking|sốc|bất ngờ)$/, '🤯'],
	[/^(sad|buồn|khóc|cry|fail|thất bại)$/, '😢'],
	[/^(laugh|cười|funny|hài|haha)$/, '😂'],
	[/^(goal|mục tiêu|target|win|thắng|chiến thắng|success|thành công)$/, '🎯'],
	[/^(phone|điện thoại|app|ứng dụng|iphone)$/, '📱'],
	[/^(book|sách|learn|học|study|kiến thức)$/, '📚'],
	[/^(strong|mạnh|power|sức mạnh|gym|tập)$/, '💪'],
	[/^(chart|data|dữ liệu|số liệu|thống kê|stats)$/, '📈'],
	[/^(ai|robot|chatgpt|gpt|claude|gemini)$/, '🤖'],
	[/^(world|thế giới|global|toàn cầu)$/, '🌍'],
	[/^(stop|dừng|đừng|never|không bao giờ)$/, '🛑'],
	[/^(check|xong|done|hoàn thành|correct|đúng)$/, '✅'],
	[/^(food|ăn|đồ ăn|eat|cafe|cà phê|coffee)$/, '🍜'],
	[/^(sleep|ngủ|tired|mệt)$/, '😴'],
	[/^(star|ngôi sao|best|tốt nhất|top)$/, '⭐'],
	[/^(gift|quà|free|miễn phí)$/, '🎁'],
];

export const emojiFor = (text: string, next?: string): string | null => {
	const a = norm(text);
	const pair = next ? `${a} ${norm(next)}` : '';
	for (const [re, e] of EMOJI) {
		if (pair && re.test(pair)) return e;
		if (re.test(a)) return e;
	}
	return null;
};

/** emphasis candidates for keyword highlighting: long content words, numbers, ALL CAPS, names */
export const keywordScore = (w: Word, idxInSentence: number) => {
	const t = w.text.replace(/[^\p{L}\p{N}%$]/gu, '');
	if (!t || isStop(t)) return 0;
	let s = 0;
	if (/\d/.test(t)) s += 3;
	if (t.length >= 7) s += 1.5;
	else if (t.length >= 5) s += 0.7;
	if (/^[A-ZĐ][a-zà-ỹ]/.test(t) && idxInSentence > 0) s += 1.2; // a proper noun mid-sentence
	if (/^[A-Z0-9]{2,}$/.test(t)) s += 1.5; // acronym
	if (emojiFor(t)) s += 1;
	return s;
};

export const endsSentence = (t: string) => /[.!?…。]["')\]]*$/.test(t);
