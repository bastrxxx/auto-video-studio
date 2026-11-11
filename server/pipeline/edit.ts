// Step 3: the cut. ghost-editor's take selection (later fluent take wins, restarts/mutters dropped)
// and autocut (pauses from the audio, a breath kept on each side), done automatically without a script.
import type {JobOptions, Take, Word} from '../../shared/types.js';
import {endsSentence, findNumber, fold, isFiller, keywordScore, lcs, norm, RETAKE_CUES} from './text.js';

export type Sentence = {id: number; w0: number; w1: number; start: number; end: number; text: string; toks: string[]};

export type WordStatus = {i: number; keep: boolean; reason?: string};

export type AiCut = {dropSentences?: number[]; keepSentences?: number[]};

export type Overrides = {cut?: number[]; keep?: number[]};

export const splitSentences = (words: Word[], clipOfWord: (i: number) => number = () => 0): Sentence[] => {
	const out: Sentence[] = [];
	let w0 = 0;
	for (let k = 0; k < words.length; k++) {
		const w = words[k];
		const next = words[k + 1];
		const gap = next ? next.start - w.end : 99;
		const len = k - w0 + 1;
		if (!next || endsSentence(w.text) || gap > 0.55 || len >= 28 || clipOfWord(k) !== clipOfWord(k + 1)) {
			const ws = words.slice(w0, k + 1);
			out.push({
				id: out.length,
				w0,
				w1: k,
				start: ws[0].start,
				end: ws[ws.length - 1].end,
				text: ws.map((x) => x.text).join(' '),
				toks: ws.map((x) => fold(x.text)).filter(Boolean),
			});
			w0 = k + 1;
		}
	}
	return out;
};

const PACE = {
	natural: {maxPause: 0.7, pad: 0.16, lead: 0.15, tail: 0.25},
	fast: {maxPause: 0.38, pad: 0.1, lead: 0.12, tail: 0.2},
	ultra: {maxPause: 0.26, pad: 0.07, lead: 0.08, tail: 0.15},
};

export const decideCuts = (args: {
	words: Word[];
	silences: [number, number][];
	duration: number;
	opts: JobOptions;
	ai?: AiCut | null;
	overrides?: Overrides | null;
	/** multi-clip: [start, end] of every clip on the virtual timeline, in edit order */
	clipBounds?: [number, number][];
}): {takes: Take[]; status: WordStatus[]; sentences: Sentence[]; stats: Record<string, number>} => {
	const {words, silences, duration, opts} = args;
	const pace = PACE[opts.pace] || PACE.fast;
	const status: WordStatus[] = words.map((w) => ({i: w.i, keep: true}));
	const drop = (i: number, reason: string) => {
		if (status[i].keep) status[i] = {i, keep: false, reason};
	};
	const bounds = args.clipBounds?.length ? args.clipBounds : [[0, duration] as [number, number]];
	const clipAt = (t: number) => {
		let k = 0;
		for (let i = 0; i < bounds.length; i++) if (t >= bounds[i][0] - 1e-6) k = i;
		return k;
	};
	const wordClip = words.map((w) => clipAt((w.start + w.end) / 2));
	const sentences = splitSentences(words, (i) => wordClip[i] ?? -1);
	const dropSentence = (s: Sentence, reason: string) => {
		for (let k = s.w0; k <= s.w1; k++) drop(k, reason);
	};

	// 1. whisper hallucinations over silence (e.g. "thanks for watching" on room tone)
	for (const w of words) {
		const len = w.end - w.start;
		let inside = 0;
		for (const [s, e] of silences) inside += Math.max(0, Math.min(e, w.end) - Math.max(s, w.start));
		if (len > 0.12 && inside / len > 0.8 && w.p < 0.6) drop(w.i, 'noise');
	}

	if (opts.removeRetakes) {
		// 2. retake cues ("làm lại", "okay again"): drop the chatter and the take it abandons
		sentences.forEach((s, idx) => {
			const t = ` ${s.text.toLowerCase()} `;
			if (RETAKE_CUES.some((c) => t.includes(` ${c} `) || t.includes(` ${c},`) || t.includes(` ${c}.`)) && s.toks.length <= 9) {
				dropSentence(s, 'retake-cue');
				const prev = sentences[idx - 1];
				if (prev && s.start - prev.end < 4) dropSentence(prev, 'retake');
			}
		});
		// 3. false starts and repeated takes: the earlier version loses (people warm up)
		for (let i = 0; i < sentences.length; i++) {
			const si = sentences[i];
			const ti = si.toks;
			if (!ti.length) continue;
			for (let j = i + 1; j <= Math.min(i + 4, sentences.length - 1); j++) {
				const tj = sentences[j].toks;
				if (sentences[j].start - si.end > 25) break;
				if (ti.length >= 3) {
					const prefix = tj.slice(0, ti.length + 2);
					const sim = lcs(ti, prefix) / ti.length;
					const headSame = lcs(ti.slice(0, 3), tj.slice(0, 3)) >= 3;
					if (sim >= 0.7 || (headSame && ti.length <= tj.length + 2 && sim >= 0.5)) {
						dropSentence(si, 'retake');
						break;
					}
				} else if (si.end - si.start < 1.5 && tj.length > ti.length && ti.every((t, k) => t === tj[k])) {
					dropSentence(si, 'false-start');
					break;
				}
			}
		}
		// 4. stutters inside a sentence: "tôi nghĩ tôi nghĩ là" -> drop the first copy
		for (const s of sentences) {
			const idx = [];
			for (let k = s.w0; k <= s.w1; k++) if (status[k].keep) idx.push(k);
			for (let n = 3; n >= 1; n--) {
				for (let k = 0; k + 2 * n <= idx.length; k++) {
					const a = idx.slice(k, k + n).map((x) => fold(words[x].text));
					const b = idx.slice(k + n, k + 2 * n).map((x) => fold(words[x].text));
					if (a.some((x) => !x) || a.join(' ') !== b.join(' ')) continue;
					const gap = words[idx[k + n]].start - words[idx[k + n - 1]].end;
					if (n === 1 && (gap < 0.12 || a[0].length < 2)) continue; // reduplication like "dần dần"
					for (let q = k; q < k + n; q++) drop(idx[q], 'stutter');
				}
			}
		}
	}

	// 5. fillers
	if (opts.removeFillers) {
		words.forEach((w, k) => {
			if (isFiller(w, words[k - 1], words[k + 1])) drop(k, 'filler');
		});
	}

	// 6. AI decisions (Gemini): sentences it judged as retakes / off-topic
	if (args.ai?.dropSentences) {
		for (const id of args.ai.dropSentences) if (sentences[id]) dropSentence(sentences[id], 'ai');
	}

	// 7. length limit: keep the best sentences in order (hook and close always stay)
	const keptDur = () => words.filter((w, k) => status[k].keep).reduce((a, w) => a + (w.end - w.start) + 0.12, 0);
	if (opts.maxDuration > 0 && keptDur() > opts.maxDuration) {
		const alive = sentences.filter((s) => {
			for (let k = s.w0; k <= s.w1; k++) if (status[k].keep) return true;
			return false;
		});
		const prefer = new Set(args.ai?.keepSentences || []);
		const scored = alive.map((s, rank) => {
			const ws = words.slice(s.w0, s.w1 + 1);
			let score = ws.reduce((a, w, k) => a + keywordScore(w, k), 0) / Math.max(4, ws.length);
			if (ws.some((w, k) => findNumber(ws, k))) score += 1;
			if (/\?/.test(s.text)) score += 0.6;
			score += ws.reduce((a, w) => a + w.p, 0) / ws.length;
			if (rank === 0) score += 100;
			if (rank === alive.length - 1) score += 5;
			if (prefer.has(s.id)) score += 50;
			return {s, score, dur: s.end - s.start + 0.2};
		});
		const order = [...scored].sort((a, b) => b.score - a.score);
		const keepIds = new Set<number>();
		let total = 0;
		for (const x of order) {
			if (total + x.dur > opts.maxDuration && keepIds.size > 0) continue;
			keepIds.add(x.s.id);
			total += x.dur;
		}
		for (const s of alive) if (!keepIds.has(s.id)) dropSentence(s, 'trim');
	}

	// 8. manual overrides from the transcript editor
	for (const i of args.overrides?.cut || []) if (status[i]) status[i] = {i, keep: false, reason: 'manual'};
	for (const i of args.overrides?.keep || []) if (status[i]) status[i] = {i, keep: true};

	// 9. words -> takes (original seconds)
	const takes: Take[] = [];
	let run: number[] = [];
	const flush = () => {
		if (!run.length) return;
		const f = words[run[0]];
		const l = words[run[run.length - 1]];
		const before = words[run[0] - 1];
		const after = words[run[run.length - 1] + 1];
		let a = f.start - pace.lead;
		let b = l.end + pace.tail;
		const [c0, c1] = bounds[wordClip[run[0]]];
		if (before && wordClip[run[0] - 1] === wordClip[run[0]]) a = Math.max(a, before.end + 0.03);
		if (after && wordClip[run[run.length - 1] + 1] === wordClip[run[0]]) b = Math.min(b, after.start - 0.05);
		a = Math.max(c0, a);
		b = Math.min(c1, Math.max(b, l.end + 0.02));
		// pauses inside the run
		let pieceStart = a;
		for (let k = 0; k < run.length - 1; k++) {
			const w = words[run[k]];
			const nx = words[run[k + 1]];
			const gap = nx.start - w.end;
			if (opts.removeSilence && gap > pace.maxPause) {
				takes.push({a: pieceStart, b: w.end + pace.pad});
				pieceStart = nx.start - pace.pad;
			}
		}
		takes.push({a: pieceStart, b});
		run = [];
	};
	for (let k = 0; k < words.length; k++) {
		if (run.length && wordClip[k] !== wordClip[run[0]]) flush();
		if (status[k].keep) run.push(k);
		else flush();
	}
	flush();

	// clips without any speech (B-roll, scenery): keep them, minus long silences when asked
	bounds.forEach(([c0, c1], ci) => {
		if (wordClip.includes(ci)) return;
		if (!opts.removeSilence) {
			takes.push({a: c0, b: c1, reason: 'broll'});
			return;
		}
		let cur = c0;
		for (const [s0, e0] of silences) {
			if (e0 <= c0 || s0 >= c1 || e0 - s0 < 1.2) continue;
			if (s0 > cur) takes.push({a: cur, b: Math.min(c1, s0 + 0.2), reason: 'broll'});
			cur = Math.max(cur, e0 - 0.2);
		}
		if (cur < c1 - 0.2) takes.push({a: cur, b: c1, reason: 'broll'});
	});

	// merge touching pieces, drop slivers
	const merged: Take[] = [];
	for (const t of takes.sort((x, y) => x.a - y.a)) {
		const last = merged[merged.length - 1];
		if (last && t.a - last.b < 0.08 && clipAt(t.a + 0.01) === clipAt(last.a + 0.01)) last.b = Math.max(last.b, t.b);
		else merged.push({...t});
	}
	const final = merged.filter((t) => t.b - t.a >= 0.2);

	const stats: Record<string, number> = {};
	for (const s of status) if (!s.keep) stats[s.reason || 'cut'] = (stats[s.reason || 'cut'] || 0) + 1;
	return {takes: final.length ? final : [{a: 0, b: duration}], status, sentences, stats};
};

export const keptDuration = (takes: Take[]) => takes.reduce((a, t) => a + (t.b - t.a), 0);

export {norm};
