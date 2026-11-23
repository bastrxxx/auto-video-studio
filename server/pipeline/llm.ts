// Optional AI editor (Gemini): the role the Claude agent plays in ghost-editor — judge retakes,
// pick the hook title, keywords, and where cards / emoji land. Everything degrades to heuristics without a key.
import type {Hook3sBlueprint, TikTokChannelDNA, Word} from '../../shared/types.js';
import type {Sentence} from './edit.js';
import {GEMINI_MODEL} from '../config.js';
import {findAgyBinary, getAgyConfig, runAgyPrompt} from '../agy-cli.js';

export type AiResult = {
	title?: string;
	dropSentences?: number[];
	keepSentences?: number[];
	keywords?: number[];
	beats?: {type: 'big' | 'emoji' | 'pill'; word: number; text?: string; sub?: string; emoji?: string}[];
	fixes?: Record<string, string>;
	summary?: string;
	hook3s?: Hook3sBlueprint;
};

const PROMPT = (
	lang: string,
	maxDuration: number,
	style: string,
	brief: string,
	fashionMode?: boolean,
	dna?: TikTokChannelDNA | null,
	hook3sDescription?: string,
	voiceOverScript?: string,
) => `You are a senior short-form video editor (TikTok/Reels/Shorts)${fashionMode ? ' specializing in viral 20-30 second FASHION videos (lookbook, styling, outfit reveal, fabric details, conversion hooks)' : ''}.
${brief ? `\nTHE CREATOR'S BRIEF — what this video must be (follow it: what to keep, tone, length, audience, title idea):\n"""${brief.slice(0, 2000)}"""\n` : ''}
${hook3sDescription ? `\n3-SECOND HOOK DIRECTION FROM CREATOR:\n"""${hook3sDescription.slice(0, 800)}"""\n` : ''}
${voiceOverScript ? `\nSELECTED VOICE OVER SCRIPT (align cuts and highlights to match this narrative):\n"""${voiceOverScript.slice(0, 1200)}"""\n` : ''}
${
	dna
		? `\nLEARNED TIKTOK CHANNEL DNA ("${dna.name}") — FOLLOW THIS EDITING STYLE:\n- Summary: ${dna.summary}\n- Target duration: ${dna.metrics.targetRangeSec[0]}-${dna.metrics.targetRangeSec[1]}s, avg shot ${dna.metrics.avgShotLengthSec}s\n- 3s Hook Formula: ${dna.hook3sFormula.pattern} | Visual: ${dna.hook3sFormula.visualPattern}\n- Pacing: ${dna.pacingCurve.intro0to3s} | ${dna.pacingCurve.body3to20s} | ${dna.pacingCurve.outro20to30s}\n- Viral rules: ${dna.viralRules.join('; ')}\n`
		: ''
}
You get the word-level transcript of a RAW recording, split into numbered sentences S<n>. Each word has an index [i].
The speaker may repeat a sentence several times (retakes), abandon starts, say "okay again"/"làm lại", or mutter. Later fluent takes are usually better.

Return ONLY JSON with this shape:
{
 "title": "a punchy hook title for the first 3 seconds, max 6 words, same language as the speech",
 "hook3s": {
   "title": "punchy 0-3s hook headline (max 6 words)",
   "visualAction": "exact visual & cut direction for the first 3 seconds (0-1.5s and 1.5-3.0s)",
   "openingLine": "best opening hook line for 0-3s",
   "textOverlay": "on-screen text overlay for 0-3s",
   "cameraMove": "camera zoom/cut move for 0-3s",
   "sfxCue": "SFX cue for 0-3s",
   "retentionScore": 90,
   "whyItWorks": "short explanation of why this 3-second hook retains viewers"
 },
 "drop_sentences": [sentence numbers that are retakes, false starts, mutters, off-topic chatter or duplicate content — keep the BEST (usually the last fluent) version of each idea],
 ${maxDuration > 0 ? `"keep_sentences": [the sentence numbers forming the strongest ${maxDuration}-second cut: hook first, the core points, the close],` : ''}
 "keywords": [word indices of the single most important word of each caption phrase; about 1 every 3-4 seconds],
 "beats": [
   {"type": "big", "word": <index where it is said>, "text": "50%", "sub": "SHORT LABEL"},   // numbers, durations, money, key claims
   {"type": "emoji", "word": <index>, "emoji": "🔥"},                                       // a feeling, at most 1 per 6 seconds
   {"type": "pill", "word": <index>, "text": "2-4 word tag"}                                // a topic change / list item
 ],
 "fixes": {"misheard word": "correct spelling"}   // brand names, people, technical terms whisper got wrong
}
Rules: never invent content not said in transcript for drop/keep/keywords. Sentences that do not serve the brief may be dropped. Big cards only for things actually said. Style of the edit: ${style}. Language of the speech: ${lang}.`;

const parseHook3s = (raw: any): Hook3sBlueprint | undefined => {
	if (!raw || typeof raw !== 'object') return undefined;
	return {
		title: String(raw.title || '').slice(0, 60),
		visualAction: String(raw.visualAction || ''),
		openingLine: String(raw.openingLine || ''),
		textOverlay: String(raw.textOverlay || '').slice(0, 60),
		cameraMove: String(raw.cameraMove || 'Snap zoom 1.15x + Flash cut'),
		sfxCue: String(raw.sfxCue || 'Impact + Whoosh'),
		retentionScore: Math.min(99, Math.max(50, Number(raw.retentionScore) || 88)),
		whyItWorks: String(raw.whyItWorks || ''),
	};
};

export const runGemini = async (
	key: string,
	words: Word[],
	sentences: Sentence[],
	opts: {
		language: string;
		maxDuration: number;
		style: string;
		brief?: string;
		fashionMode?: boolean;
		dna?: TikTokChannelDNA | null;
		hook3sDescription?: string;
		voiceOverScript?: string;
	},
): Promise<AiResult> => {
	const lines = sentences.map(
		(s) => `S${s.id} (${s.start.toFixed(1)}-${s.end.toFixed(1)}s): ` + words.slice(s.w0, s.w1 + 1).map((w) => `[${w.i}]${w.text}`).join(' '),
	);
	const fullPrompt =
		PROMPT(opts.language, opts.maxDuration, opts.style, opts.brief || '', opts.fashionMode, opts.dna, opts.hook3sDescription, opts.voiceOverScript) +
		'\n\nTRANSCRIPT:\n' +
		lines.join('\n');

	// If local `agy` CLI AI Engine is enabled & installed (or no Gemini API key provided), route via `agy -p --model <selected>`
	const agyCfg = getAgyConfig();
	const agyBin = agyCfg.enabled ? await findAgyBinary(agyCfg.customPath) : null;
	if (agyBin && (!key || agyCfg.enabled)) {
		try {
			const agyRes = await runAgyPrompt(fullPrompt, {timeoutMs: 120_000});
			const jsonMatch = agyRes.output.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				const ints = (xs: any) => (Array.isArray(xs) ? xs.map(Number).filter(Number.isFinite) : undefined);
				const maxWord = words.length - 1;
				return {
					title: typeof parsed.title === 'string' ? parsed.title.slice(0, 60) : undefined,
					hook3s: parseHook3s(parsed.hook3s),
					dropSentences: ints(parsed.drop_sentences),
					keepSentences: ints(parsed.keep_sentences),
					keywords: ints(parsed.keywords)?.filter((i) => i >= 0 && i <= maxWord),
					beats: Array.isArray(parsed.beats)
						? parsed.beats
								.filter((b: any) => b && typeof b.word === 'number' && b.word >= 0 && b.word <= maxWord)
								.map((b: any) => ({
									type: b.type,
									word: b.word,
									text: typeof b.text === 'string' ? b.text.slice(0, 32) : undefined,
									sub: typeof b.sub === 'string' ? b.sub.slice(0, 32) : undefined,
									emoji: typeof b.emoji === 'string' ? b.emoji.slice(0, 4) : undefined,
								}))
						: undefined,
					fixes: parsed.fixes && typeof parsed.fixes === 'object' ? parsed.fixes : undefined,
				};
			}
		} catch (err) {
			if (!key) throw err;
		}
	}

	const body = {
		contents: [{role: 'user', parts: [{text: fullPrompt}]}],
		generationConfig: {responseMimeType: 'application/json', temperature: 0.3},
	};
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 90_000);
	try {
		const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
			body: JSON.stringify(body),
			signal: ctrl.signal,
		});
		if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
		const j: any = await res.json();
		const text = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '{}';
		const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
		const ints = (xs: any) => (Array.isArray(xs) ? xs.map(Number).filter(Number.isFinite) : undefined);
		const maxWord = words.length - 1;
		return {
			title: typeof parsed.title === 'string' ? parsed.title.slice(0, 60) : undefined,
			dropSentences: ints(parsed.drop_sentences),
			keepSentences: ints(parsed.keep_sentences),
			keywords: ints(parsed.keywords)?.filter((i) => i >= 0 && i <= maxWord),
			beats: Array.isArray(parsed.beats)
				? parsed.beats
						.filter((b: any) => b && ['big', 'emoji', 'pill'].includes(b.type) && Number.isFinite(Number(b.word)))
						.map((b: any) => ({type: b.type, word: Number(b.word), text: b.text ? String(b.text).slice(0, 24) : undefined, sub: b.sub ? String(b.sub).slice(0, 32) : undefined, emoji: b.emoji ? String(b.emoji).slice(0, 8) : undefined}))
				: undefined,
			fixes: parsed.fixes && typeof parsed.fixes === 'object' ? parsed.fixes : undefined,
		};
	} finally {
		clearTimeout(timer);
	}
};

const callGemini = async (key: string, prompt: string, timeoutMs = 120_000) => {
	const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
		body: JSON.stringify({contents: [{role: 'user', parts: [{text: prompt}]}], generationConfig: {responseMimeType: 'application/json', temperature: 0.1}}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const j: any = await res.json();
	return JSON.parse((j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '{}').replace(/^```json\s*|\s*```$/g, ''));
};

/**
 * Proof-read the transcript (whisper mishears Vietnamese: wrong tones, split/merged syllables, names).
 * Sentence by sentence, the corrected text is re-aligned onto the original word timings:
 * same word count -> word for word; otherwise spread over the sentence by character length.
 */
export const correctTranscript = async (key: string, words: Word[], language: string, brief: string, vocab: string[]): Promise<{words: Word[]; changed: number}> => {
	if (!words.length) return {words, changed: 0};
	// sentences by pause / punctuation
	const sents: [number, number][] = [];
	let s0 = 0;
	for (let k = 0; k < words.length; k++) {
		const end = k === words.length - 1 || /[.!?…]$/.test(words[k].text) || words[k + 1].start - words[k].end > 0.6 || k - s0 >= 30;
		if (end) {
			sents.push([s0, k]);
			s0 = k + 1;
		}
	}
	const out: Word[] = [];
	let changed = 0;
	const BATCH = 60;
	for (let b = 0; b < sents.length; b += BATCH) {
		const chunk = sents.slice(b, b + BATCH);
		const lines = chunk.map(([a, z], k) => `${k}: ${words.slice(a, z + 1).map((w) => w.text).join(' ')}`);
		const prompt = `You proof-read automatic speech recognition output (${language === 'vi' ? 'Vietnamese' : language}).
Fix ONLY recognition errors: wrong words that sound alike, wrong or missing Vietnamese diacritics/tones, wrongly split or merged
syllables, misspelled names/brands/terms, punctuation and capitalisation. Do NOT rephrase, summarise, translate, reorder or drop
content; keep fillers if they were said. Keep each line's meaning and roughly the same words.
${brief ? `Context — what the video is about:\n"""${brief.slice(0, 1200)}"""\n` : ''}${vocab.length ? `Terms that appear: ${vocab.join(', ')}\n` : ''}
Return ONLY JSON: {"lines": ["corrected line 0", "corrected line 1", ...]} with exactly ${lines.length} lines.

LINES:
${lines.join('\n')}`;
		let fixed: string[] = [];
		try {
			const r = await callGemini(key, prompt);
			fixed = Array.isArray(r.lines) ? r.lines.map(String) : [];
		} catch {
			fixed = [];
		}
		chunk.forEach(([a, z], k) => {
			const orig = words.slice(a, z + 1);
			const line = (fixed[k] || '').replace(/^\d+:\s*/, '').trim();
			const toks = line.split(/\s+/).filter(Boolean);
			if (!toks.length || fixed.length !== chunk.length) {
				out.push(...orig);
				return;
			}
			// guard against hallucinated rewrites: the length must stay close
			const ratio = toks.length / orig.length;
			if (ratio < 0.6 || ratio > 1.6) {
				out.push(...orig);
				return;
			}
			if (toks.join(' ') !== orig.map((w) => w.text).join(' ')) changed++;
			if (toks.length === orig.length) {
				orig.forEach((w, i) => out.push({...w, text: toks[i]}));
				return;
			}
			const A = orig[0].start;
			const B = orig[orig.length - 1].end;
			const weights = toks.map((t) => Math.max(2, t.length) + 1);
			const sum = weights.reduce((x, y) => x + y, 0);
			let cur = A;
			const p = Math.min(...orig.map((w) => w.p));
			toks.forEach((t, i) => {
				const d = ((B - A) * weights[i]) / sum;
				out.push({i: 0, text: t, start: cur, end: cur + d * 0.94, p});
				cur += d;
			});
		});
	}
	return {words: out.map((w, i) => ({...w, i})), changed};
};
