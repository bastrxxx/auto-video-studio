// Step 2: word-level transcription with whisper.cpp (Remotion's @remotion/install-whisper-cpp).
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import os from 'node:os';
import type {TranscriptionJson, WhisperModel} from '@remotion/install-whisper-cpp';

// whisper.cpp 1.5.x: the CLI is ./main; DTW presets are named like large.v3 / small.en
const whisperExe = () => path.join(PATHS.whisper, 'main');
const modelToDtw = (m: string) => m.replace(/-v(\d)$/, '.v$1').replace(/-/g, '.');
import {PATHS} from '../config.js';
import {run} from '../ff.js';
import type {Word} from '../../shared/types.js';

export const availableModels = (): string[] =>
	fs.existsSync(PATHS.whisper)
		? fs
				.readdirSync(PATHS.whisper)
				.filter((f) => /^ggml-.*\.bin$/.test(f))
				.map((f) => f.replace(/^ggml-/, '').replace(/\.bin$/, ''))
		: [];

export const whisperReady = () => fs.existsSync(path.join(PATHS.whisper, 'main')) && availableModels().length > 0;

const decodeEntities = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");

export const transcribeWords = async (
	wav: string,
	opts: {model: string; language: string; prompt?: string; trim?: [number, number]; onProgress: (p: number) => void},
): Promise<{words: Word[]; language: string; model: string}> => {
	const models = availableModels();
	if (!models.length) throw new Error('Chưa có model Whisper. Chạy: npm run setup:whisper');
	const pref = [opts.model, 'large-v3', 'medium', 'small', 'base'];
	const model = (pref.find((m) => models.includes(m)) || models[0]) as WhisperModel;
	// beam search: noticeably fewer wrong words / missing diacritics than greedy decoding
	// --split-on-word is a bare flag in whisper.cpp 1.5.x (the library's splitOnWord option appends a stray "true")
	const extra: string[] = ['-bs', '5', '--split-on-word'];
	if (opts.prompt) extra.push('--prompt', opts.prompt);
	// whisper.cpp 1.5.x can abort in the DTW median filter (WHISPER_ASSERT filter_width < a->ne[2]) on a very short
	// segment, typically a hallucination over trailing silence. Trim the silent head/tail first, then fall back:
	// DTW + beam search -> DTW greedy -> no DTW (segment timings).
	let input = wav;
	let offset = 0;
	if (opts.trim && opts.trim[1] - opts.trim[0] > 0.5) {
		offset = Math.max(0, opts.trim[0]);
		input = wav.replace(/\.wav$/, '.trim.wav');
		await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', offset.toFixed(3), '-to', opts.trim[1].toFixed(3), '-i', wav, '-c:a', 'pcm_s16le', input]);
	}
	const attempts: {dtw: boolean; args: string[]}[] = [
		{dtw: true, args: extra},
		{dtw: true, args: extra.filter((a, i) => a !== '-bs' && extra[i - 1] !== '-bs')},
		{dtw: false, args: extra},
	];
	let out: TranscriptionJson<true> | null = null;
	let lastErr: unknown = null;
	for (const at of attempts) {
		try {
			out = await runWhisper(input, model, opts.language || 'auto', at.args, opts.onProgress, at.dtw);
			break;
		} catch (e) {
			lastErr = e;
			await new Promise((r) => setTimeout(r, 800));
		}
	}
	if (input !== wav) fs.rmSync(input, {force: true});
	if (!out) throw lastErr;
	if (offset > 0)
		for (const it of out.transcription) {
			it.offsets.from += offset * 1000;
			it.offsets.to += offset * 1000;
			for (const t of it.tokens || []) if (t.t_dtw >= 0) t.t_dtw += offset * 100;
		}
	// whisper.cpp segment offsets lag behind the voice (a word absorbs the pause after it); the DTW token
	// timestamps are close to the real onsets, so word timing comes from them.
	type Raw = {text: string; dtw0: number; dtw1: number; from: number; to: number; p: number};
	const raw: Raw[] = [];
	for (const item of out.transcription) {
		let text = decodeEntities(item.text);
		if (!text.trim() || /\[[A-Z_ ]+\]/.test(text)) continue; // [BLANK_AUDIO], [_BEG_], [MUSIC]...
		const toks = (item.tokens || []).filter((t) => !t.text.startsWith('[_') && !/^\s*\[/.test(t.text));
		const alnum = toks.filter((t) => /[\p{L}\p{N}]/u.test(t.text) && t.t_dtw >= 0);
		const ps = toks.map((t) => t.p);
		raw.push({
			text,
			dtw0: alnum.length ? alnum[0].t_dtw / 100 : -1,
			dtw1: alnum.length ? alnum[alnum.length - 1].t_dtw / 100 : -1,
			from: item.offsets.from / 1000,
			to: item.offsets.to / 1000,
			p: ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0.5,
		});
	}
	// merge continuations (punctuation, split words) into the previous word
	const merged: Raw[] = [];
	for (const r of raw) {
		const prev = merged[merged.length - 1];
		if (prev && !/^\s/.test(r.text)) {
			prev.text += r.text;
			if (r.dtw1 >= 0 && /[\p{L}\p{N}]/u.test(r.text)) prev.dtw1 = r.dtw1;
			prev.to = Math.max(prev.to, r.to);
			prev.p = Math.min(prev.p, r.p);
		} else merged.push({...r});
	}
	const words: Word[] = [];
	merged.forEach((r, k) => {
		const text = r.text.trim().replace(/^["“”'‘’«»]+|["“”'‘’«»]+$/g, '').trim();
		if (!/[\p{L}\p{N}]/u.test(text)) return;
		const useDtw = r.dtw0 >= 0;
		let start = useDtw ? r.dtw0 - 0.06 : r.from;
		const prev = words[words.length - 1];
		if (prev && start < prev.start + 0.03) start = prev.start + 0.03;
		const next = merged[k + 1];
		const nextStart = next ? (next.dtw0 >= 0 ? next.dtw0 - 0.06 : next.from) : Infinity;
		let end = useDtw ? Math.min(nextStart - 0.01, Math.max(r.dtw1, r.dtw0) + 0.3) : Math.min(r.to, nextStart);
		if (end < start + 0.08) end = start + 0.08;
		words.push({i: words.length, text, start: Math.max(0, start), end, p: r.p});
	});
	const clean = words.map((w, i) => ({...w, i}));
	return {words: clean, language: (out.result as any)?.language || opts.language, model};
};

/**
 * Whisper stretches words over pauses (ghost-editor: "the pauses come from the AUDIO").
 * Snap word edges that fall inside a detected silence to the silence's border.
 */
export const snapWordsToSilences = (words: Word[], silences: [number, number][]): Word[] =>
	words.map((w) => {
		let {start, end} = w;
		for (const [s, e] of silences) {
			if (start >= s && start < e && e < end) start = e - 0.03;
			if (end > s && end <= e && s > start) end = s + 0.05;
		}
		if (end - start < 0.05) end = start + 0.05;
		return {...w, start, end};
	});

/**
 * Initial prompt for whisper: the decoder continues "in the style" of this text, so a Vietnamese sentence with
 * full diacritics + the names/terms of the video steers it to correct spelling (the brief and the fix list).
 */
export const whisperPrompt = (o: {language: string; brief?: string; fixes?: Record<string, string>}) => {
	const vocab = Object.values(o.fixes || {}).filter(Boolean).join(', ');
	const parts: string[] = [];
	if (o.language === 'vi') parts.push('Xin chào các bạn, hôm nay mình sẽ chia sẻ với mọi người.');
	if (o.brief) parts.push(o.brief.replace(/\s+/g, ' ').slice(0, 220));
	if (vocab) parts.push(vocab.slice(0, 160));
	return parts.join(' ').slice(0, 480);
};

/** run whisper.cpp ourselves: wait for the process to really exit before the next run, read the JSON */
const runWhisper = (wav: string, model: WhisperModel, language: string, extra: string[], onProgress: (p: number) => void, dtw = true) =>
	new Promise<TranscriptionJson<true>>((resolve, reject) => {
		const base = path.join(os.tmpdir(), `avs-whisper-${process.pid}-${Date.now()}`);
		const args = [
			'-f', wav,
			'--output-file', base,
			'--output-json', '-ojf',
			'--max-len', '1',
			...(dtw ? ['--dtw', modelToDtw(model)] : []),
			'-m', path.join(PATHS.whisper, `ggml-${model}.bin`),
			'-pp',
			'-l', language.toLowerCase(),
			'-t', String(Math.max(4, Math.min(8, os.cpus().length))),
			...extra,
		];
		const p = spawn(whisperExe(), args, {cwd: PATHS.whisper});
		let tail = '';
		const onData = (d: Buffer) => {
			const s = d.toString('utf8');
			tail = (tail + s).slice(-4000);
			const m = /progress =\s*(\d+)%/g;
			let x: RegExpExecArray | null;
			while ((x = m.exec(s))) onProgress(Number(x[1]) / 100);
		};
		p.stdout.on('data', onData);
		p.stderr.on('data', onData);
		p.on('error', reject);
		p.on('close', (code, signal) => {
			const file = `${base}.json`;
			if (fs.existsSync(file)) {
				try {
					const j = JSON.parse(fs.readFileSync(file, 'utf8'));
					fs.rmSync(file, {force: true});
					onProgress(1);
					return resolve(j);
				} catch (e) {
					return reject(e);
				}
			}
			const lines = tail.split('\n').filter((l) => !/^(whisper_|ggml_|\s*$)/.test(l)).slice(-6).join(' | ');
			reject(new Error(`whisper.cpp thoát (${signal || code}): ${lines.slice(0, 600)}`));
		});
	});
