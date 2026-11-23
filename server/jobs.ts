// Job store + serial runner. A job ("dự án") holds one or more clips:
// per clip: prep -> transcribe (cached) ; then: order clips -> one virtual timeline -> cuts -> AI -> plan -> render.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DEFAULT_OPTIONS, type EditPlan, type FaceSample, type JobOptions, type Take, type Word} from '../shared/types.js';
import {PATHS, PORT} from './config.js';
import {probe, type Probe} from './ff.js';
import {adaptiveSilences, makeProxy} from './pipeline/prep.js';
import {snapWordsToSilences, transcribeWords, whisperPrompt} from './pipeline/transcribe.js';
import {decideCuts, keptDuration, type Sentence, type WordStatus} from './pipeline/edit.js';
import {correctTranscript, runGemini, type AiResult} from './pipeline/llm.js';
import {buildPlan, listMusic} from './pipeline/plan.js';
import {compileTimeline, planToTimeline, timelineToSrt, type CompileCtx, type Timeline} from '../shared/timeline.js';
import {renderPlan} from './pipeline/render.js';
import {orderClips} from './pipeline/order.js';
import {analyzeClipColor} from './pipeline/color.js';
import {DEFAULT_COLOR, type ColorAdjust} from '../shared/color.js';
import {findAgyBinary, getAgyConfig} from './agy-cli.js';
import {getDnaProfile} from './tiktok-dna.js';
import {
	dbClearJobs,
	dbDeleteDoc,
	dbDeleteJob,
	dbLoadJobs,
	dbReadDoc,
	dbSaveJob,
	dbWriteDoc,
	migrateDiskJobsToDb,
} from './db.js';

export type Step = 'upload' | 'prep' | 'transcribe' | 'order' | 'analyze' | 'ai' | 'plan' | 'render' | 'done';

export type Clip = {
	id: string;
	name: string;
	input: string; // absolute path
	probe: Probe;
	recordedAt: number | null; // metadata
	fileModified: number | null; // from the browser
	proxyFile: string;
	wavFile: string;
	analysisFile: string;
	faceFile: string;
	proxy?: {width: number; height: number; duration: number};
	transcriptKey?: string;
	language?: string;
	color?: Partial<ColorAdjust> | null; // automatic color correction measured on the proxy
	colorV?: number;
};

/** manual keep/cut edits, by "clipId:wordIndex" so they survive re-ordering */
export type KeyOverrides = {cut?: string[]; keep?: string[]};

export type Job = {
	id: string;
	name: string;
	createdAt: number;
	clips: Clip[];
	state: 'uploaded' | 'queued' | 'running' | 'done' | 'error' | 'cancelled';
	step: Step;
	progress: number;
	stepProgress: number;
	message: string;
	error?: string;
	log: string[];
	options: JobOptions;
	overrides?: KeyOverrides;
	order?: {ids: string[]; reasons: Record<string, string>; method: string};
	aiKey?: string;
	stats?: Record<string, number>;
	result?: {duration: number; original: number; video: string; srt: string; plan: string; renderedAt: number; renderSeconds: number};
	version: number;
	/** legacy single-clip fields (jobs made before multi-clip) */
	input?: string;
	probe?: Probe;
	proxy?: {width: number; height: number; duration: number};
	transcriptKey?: string;
};

const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const queue: string[] = [];
const modes = new Map<string, 'auto' | 'timeline'>();
let running = false;

const dirOf = (id: string) => path.join(PATHS.jobs, id);
const fileOf = (id: string, f: string) => path.join(dirOf(id), f);
const readJson = <T>(id: string, f: string): T | null => dbReadDoc<T>(id, f);
const writeJson = (id: string, f: string, data: unknown) => {
	dbWriteDoc(id, f, data);
	if (f === 'plan.json' && fs.existsSync(dirOf(id))) {
		try {
			fs.writeFileSync(fileOf(id, f), JSON.stringify(data));
		} catch {}
	}
};
const save = (job: Job) => dbSaveJob(job);

// Migrate any legacy JSON files on disk into SQLite, then restore all jobs from SQLite database
migrateDiskJobsToDb();
for (const j of dbLoadJobs<Job>()) {
	if (!j || !j.id) continue;
	const id = j.id;
	if (!j.clips) {
		j.clips =
			j.input && j.probe
				? [
						{
							id: 'c0', name: j.name, input: j.input, probe: j.probe, recordedAt: j.probe.createdAt ?? null, fileModified: null,
							proxyFile: 'proxy.mp4', wavFile: 'audio16k.wav', analysisFile: 'analysis.json', faceFile: 'face.json',
							proxy: j.proxy, transcriptKey: j.transcriptKey,
						},
					]
				: [];
		if (j.overrides) {
			const o = j.overrides as unknown as {cut?: (number | string)[]; keep?: (number | string)[]};
			j.overrides = {
				cut: (o.cut || []).map((x) => (typeof x === 'number' ? `c0:${x}` : x)),
				keep: (o.keep || []).map((x) => (typeof x === 'number' ? `c0:${x}` : x)),
			};
		}
	}
	j.options = {...DEFAULT_OPTIONS, ...j.options, color: {...DEFAULT_COLOR, ...(j.options?.color || {})}};
	if (j.state === 'running' || j.state === 'queued') {
		j.state = 'error';
		j.error = 'Server đã khởi động lại trong khi xử lý. Bấm “Dựng lại”.';
		dbSaveJob(j);
	}
	jobs.set(id, j);
}

export const listJobs = () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
export const getJob = (id: string) => jobs.get(id);

export type IncomingFile = {path: string; name: string; lastModified?: number | null};

const addClipFiles = async (job: Job, files: IncomingFile[]) => {
	const added: Clip[] = [];
	for (const f of files) {
		let n = job.clips.length + added.length;
		let cid = `c${n}`;
		while (job.clips.some((c) => c.id === cid) || added.some((c) => c.id === cid)) cid = `c${++n}`;
		const ext = (path.extname(f.name) || '.mp4').toLowerCase();
		const input = fileOf(job.id, `input-${cid}${ext}`);
		fs.renameSync(f.path, input);
		let pr: Probe;
		try {
			pr = await probe(input);
		} catch (e) {
			fs.rmSync(input, {force: true});
			throw new Error(`Không đọc được “${f.name}”: ${(e as Error).message.slice(0, 160)}`);
		}
		added.push({
			id: cid,
			name: f.name,
			input,
			probe: pr,
			recordedAt: pr.createdAt,
			fileModified: f.lastModified && f.lastModified > Date.UTC(2000, 0, 1) ? f.lastModified : null,
			proxyFile: `proxy-${cid}.mp4`,
			wavFile: `audio16k-${cid}.wav`,
			analysisFile: `analysis-${cid}.json`,
			faceFile: `face-${cid}.json`,
		});
	}
	job.clips.push(...added);
	job.name = job.clips.length > 1 ? `${job.clips[0].name} +${job.clips.length - 1}` : job.clips[0]?.name || job.name;
	return added;
};

export const createJob = async (files: IncomingFile[]): Promise<Job> => {
	const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
	fs.mkdirSync(dirOf(id), {recursive: true});
	const job: Job = {
		id,
		name: files[0]?.name || 'video',
		createdAt: Date.now(),
		clips: [],
		state: 'uploaded',
		step: 'upload',
		progress: 0,
		stepProgress: 0,
		message: 'Đã tải lên',
		log: [],
		options: {...DEFAULT_OPTIONS},
		version: 0,
	};
	try {
		await addClipFiles(job, files);
	} catch (e) {
		fs.rmSync(dirOf(id), {recursive: true, force: true});
		throw e;
	}
	jobs.set(id, job);
	save(job);
	return job;
};

export const addClips = async (id: string, files: IncomingFile[]) => {
	const job = jobs.get(id);
	if (!job) throw new Error('Không tìm thấy dự án');
	if (job.state === 'running' || job.state === 'queued') throw new Error('Dự án đang xử lý');
	const added = await addClipFiles(job, files);
	save(job);
	return {job, added};
};

export const removeClip = (id: string, clipId: string) => {
	const job = jobs.get(id);
	if (!job) throw new Error('Không tìm thấy dự án');
	if (job.state === 'running' || job.state === 'queued') throw new Error('Dự án đang xử lý');
	const c = job.clips.find((x) => x.id === clipId);
	if (!c) return;
	if (job.clips.length === 1) {
		deleteJob(id);
		return;
	}
	for (const f of [c.input, c.proxyFile, c.wavFile, c.analysisFile, c.faceFile]) fs.rmSync(path.isAbsolute(f) ? f : fileOf(id, f), {force: true});
	dbDeleteDoc(id, c.analysisFile);
	dbDeleteDoc(id, c.faceFile);
	job.clips = job.clips.filter((x) => x.id !== clipId);
	job.name = job.clips.length > 1 ? `${job.clips[0].name} +${job.clips.length - 1}` : job.clips[0].name;
	job.aiKey = undefined;
	save(job);
};

export const deleteJob = (id: string) => {
	const qi = queue.indexOf(id);
	if (qi >= 0) queue.splice(qi, 1);
	controllers.get(id)?.abort();
	jobs.delete(id);
	dbDeleteJob(id);
	fs.rmSync(dirOf(id), {recursive: true, force: true});
};

export const clearAllJobs = () => {
	for (const id of [...jobs.keys()]) deleteJob(id);
	dbClearJobs();
};

export const startJob = (
	id: string,
	options: Partial<JobOptions>,
	face?: Record<string, FaceSample[]> | FaceSample[] | null,
	overrides?: KeyOverrides | null,
	mode: 'auto' | 'timeline' = 'auto',
) => {
	const job = jobs.get(id);
	if (!job) throw new Error('Không tìm thấy dự án');
	if (job.state === 'running' || job.state === 'queued') throw new Error('Dự án đang chạy');
	if (mode === 'timeline' && !fs.existsSync(fileOf(id, 'timeline.json'))) throw new Error('Chưa có timeline — hãy dựng tự động trước');
	modes.set(id, mode);
	job.options = {...DEFAULT_OPTIONS, ...job.options, ...options, color: {...DEFAULT_COLOR, ...(job.options?.color || {}), ...(options?.color || {})}};
	if (overrides !== undefined) job.overrides = overrides || undefined;
	if (Array.isArray(face)) {
		if (face.length && job.clips[0]) writeJson(id, job.clips[0].faceFile, face);
	} else if (face) {
		for (const [cid, samples] of Object.entries(face)) {
			const c = job.clips.find((x) => x.id === cid);
			if (c && Array.isArray(samples) && samples.length) writeJson(id, c.faceFile, samples);
		}
	}
	job.state = 'queued';
	job.error = undefined;
	job.message = 'Đang chờ...';
	job.progress = 0;
	save(job);
	queue.push(id);
	void pump();
	return job;
};

export const cancelJob = (id: string) => {
	const job = jobs.get(id);
	if (!job) return;
	const qi = queue.indexOf(id);
	if (qi >= 0) queue.splice(qi, 1);
	controllers.get(id)?.abort();
	job.state = 'cancelled';
	job.message = 'Đã huỷ';
	save(job);
};

const WEIGHTS: Record<string, [number, number]> = {
	prep: [0, 0.12],
	transcribe: [0.12, 0.4],
	order: [0.4, 0.41],
	analyze: [0.41, 0.43],
	ai: [0.43, 0.47],
	plan: [0.47, 0.5],
	render: [0.5, 1],
};

const pump = async () => {
	if (running) return;
	const id = queue.shift();
	if (!id) return;
	running = true;
	try {
		await runJob(id);
	} finally {
		running = false;
		void pump();
	}
};

export type Analysis = {words: Word[]; silences: [number, number][]; noise: number; rawWords?: Word[]; fixKey?: string};

/** all clips in edit order on one virtual timeline */
type VTimeline = {
	clips: {clip: Clip; offset: number; duration: number; w0: number; w1: number}[];
	words: Word[];
	keys: string[];
	silences: [number, number][];
	duration: number;
	face: FaceSample[];
};

const buildTimeline = (job: Job, orderIds: string[]): VTimeline => {
	const tl: VTimeline = {clips: [], words: [], keys: [], silences: [], duration: 0, face: []};
	for (const cid of orderIds) {
		const clip = job.clips.find((c) => c.id === cid)!;
		const an = readJson<Analysis>(job.id, clip.analysisFile) || {words: [], silences: [], noise: -35};
		const off = tl.duration;
		const dur = clip.proxy!.duration;
		const w0 = tl.words.length;
		for (const w of an.words) {
			if (w.start >= dur) continue;
			tl.keys.push(`${clip.id}:${w.i}`);
			tl.words.push({...w, i: tl.words.length, start: w.start + off, end: Math.min(dur, w.end) + off});
		}
		for (const [s, e] of an.silences) tl.silences.push([s + off, Math.min(e, dur) + off]);
		const face = readJson<FaceSample[]>(job.id, clip.faceFile) || [];
		for (const f of face) if (f.t <= dur) tl.face.push({...f, t: f.t + off});
		tl.clips.push({clip, offset: off, duration: dur, w0, w1: tl.words.length - 1});
		tl.duration += dur;
	}
	return tl;
};

const runJob = async (id: string) => {
	const job = jobs.get(id);
	if (!job || job.state !== 'queued') return;
	const ctrl = new AbortController();
	controllers.set(id, ctrl);
	job.state = 'running';
	job.version++;
	const t0 = Date.now();
	const log = (s: string) => {
		job.log.push(`[${new Date().toLocaleTimeString('vi-VN')}] ${s}`);
		if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
		job.message = s;
		save(job);
	};
	let lastSave = 0;
	const step = (s: Step, p: number, msg?: string) => {
		job.step = s;
		job.stepProgress = p;
		const [a, b] = WEIGHTS[s] || [1, 1];
		job.progress = a + (b - a) * p;
		if (msg) job.message = msg;
		if (Date.now() - lastSave > 700) {
			lastSave = Date.now();
			save(job);
		}
	};
	const check = () => {
		if (ctrl.signal.aborted) throw new Error('cancelled');
	};
	const opts = job.options;
	const dir = dirOf(id);
	const n = job.clips.length;
	const mode = modes.get(id) || 'auto';
	modes.delete(id);
	try {
		if (!n) throw new Error('Dự án chưa có video');
		if (mode === 'timeline') {
			// export the edited timeline: no analysis, compile with the current style options and render
			const timeline = readJson<Timeline>(id, 'timeline.json')!;
			const base = `http://127.0.0.1:${PORT}`;
			await ensureAutoColor(job, log);
			step('plan', 0.5, 'Biên dịch timeline...');
			const plan = compileTimeline(timeline, buildCtx(job, base));
			writeJson(id, 'plan.json', plan);
			fs.writeFileSync(fileOf(id, 'captions.srt'), timelineToSrt(plan));
			log(`Xuất từ timeline: ${timeline.segments.length} đoạn, ${plan.captions.groups.length} câu phụ đề, ${timeline.beats.length} hiệu ứng`);
			await renderAndFinish(job, plan, dir, t0, ctrl, step, log, timeline.segments.reduce((a, s) => a + s.b - s.a, 0));
			return;
		}
		// 1. prep every clip
		for (let k = 0; k < n; k++) {
			const c = job.clips[k];
			if (fs.existsSync(fileOf(id, c.proxyFile)) && fs.existsSync(fileOf(id, c.wavFile)) && c.proxy) continue;
			const tag = n > 1 ? ` [${k + 1}/${n}] ${c.name}` : '';
			log(`Chuẩn hoá video (30 fps, -16 LUFS)${tag}...`);
			const r = await makeProxy(c.input, dir, opts.format, (p) => step('prep', (k + p) / n, `Chuẩn hoá video${tag} ${Math.round(p * 100)}%`));
			fs.renameSync(r.proxy, fileOf(id, c.proxyFile));
			fs.renameSync(r.wav, fileOf(id, c.wavFile));
			c.proxy = {width: r.proxyInfo.width, height: r.proxyInfo.height, duration: r.proxyInfo.duration};
			log(`Proxy ${c.proxy.width}x${c.proxy.height}, ${c.proxy.duration.toFixed(1)}s${tag}`);
			check();
		}

		// 1b. automatic color measurement per clip (cached)
		await ensureAutoColor(job, log);

		// 2. silences + transcript per clip (cached)
		const tKey = `${opts.model}|${opts.language}`;
		let transcribed = false;
		for (let k = 0; k < n; k++) {
			const c = job.clips[k];
			if (c.transcriptKey === tKey && fs.existsSync(fileOf(id, c.analysisFile))) continue;
			const tag = n > 1 ? ` [${k + 1}/${n}]` : '';
			const wav = fileOf(id, c.wavFile);
			const sil = await adaptiveSilences(wav, c.proxy!.duration, 0.25);
			let words: Word[] = [];
			if (c.probe.hasAudio) {
				log(`Nhận dạng giọng nói${tag} (Whisper ${opts.model}, ${opts.language})...`);
				const tr = await transcribeWords(wav, {
					model: opts.model,
					language: opts.language,
					prompt: whisperPrompt({language: opts.language, brief: opts.brief, fixes: opts.fixes}),
					trim: speechSpan(sil.sil, c.proxy!.duration),
					onProgress: (p) => step('transcribe', (k + p) / n, `Nhận dạng giọng nói${tag} ${Math.round(p * 100)}%`),
				});
				words = snapWordsToSilences(tr.words, sil.sil);
				c.language = tr.language;
			}
			writeJson(id, c.analysisFile, {words, silences: sil.sil, noise: sil.noise} satisfies Analysis);
			c.transcriptKey = tKey;
			transcribed = true;
			log(`${c.name}: ${words.length} từ, ngưỡng lặng ${sil.noise} dB`);
			check();
		}
		// 2b. AI proof-reading of the transcript (cached per brief + fix list)
		const fixKey = opts.useAI && opts.geminiKey && opts.aiFixCaptions ? hash(`${opts.brief}|${JSON.stringify(opts.fixes)}`) : '';
		for (let k = 0; k < n; k++) {
			const c = job.clips[k];
			const an = readJson<Analysis>(id, c.analysisFile);
			if (!an || (an.fixKey || '') === fixKey) continue;
			const raw = an.rawWords || an.words;
			if (!fixKey) {
				writeJson(id, c.analysisFile, {...an, words: raw, rawWords: raw, fixKey: ''});
				transcribed = true;
				continue;
			}
			if (!raw.length) continue;
			step('transcribe', (k + 0.9) / n, `AI sửa chính tả phụ đề${n > 1 ? ` [${k + 1}/${n}]` : ''}...`);
			try {
				const r = await correctTranscript(opts.geminiKey, raw, c.language || opts.language, opts.brief, Object.values(opts.fixes || {}));
				writeJson(id, c.analysisFile, {...an, words: r.words, rawWords: raw, fixKey});
				log(`AI sửa ${r.changed} câu phụ đề${n > 1 ? ` (${c.name})` : ''}`);
				transcribed = true;
			} catch (e) {
				log(`AI sửa phụ đề lỗi: ${(e as Error).message.slice(0, 120)}`);
			}
			check();
		}
		if (transcribed) job.aiKey = undefined;
		const language = job.clips.find((c) => c.language)?.language || opts.language;

		// 3. clip order
		step('order', 0.2, n > 1 ? 'Sắp xếp thứ tự các clip...' : undefined);
		const ord = await orderClips(
			job.clips.map((c) => ({
				id: c.id,
				name: c.name,
				duration: c.proxy!.duration,
				recordedAt: c.recordedAt,
				fileModified: c.fileModified,
				words: readJson<Analysis>(id, c.analysisFile)?.words || [],
			})),
			opts.order,
			opts.manualOrder || [],
			opts.useAI && opts.geminiKey ? {key: opts.geminiKey, language, brief: opts.brief} : null,
			log,
		);
		job.order = {ids: ord.order, reasons: ord.reasons, method: ord.method};
		if (n > 1) log(`Thứ tự (${ord.method}): ${ord.order.map((cid) => job.clips.find((c) => c.id === cid)!.name).join(' → ')}`);
		const tl = buildTimeline(job, ord.order);
		const clipBounds = tl.clips.map((c) => [c.offset, c.offset + c.duration] as [number, number]);
		const keyIndex = new Map(tl.keys.map((k, i) => [k, i]));
		const overrides = {
			cut: (job.overrides?.cut || []).map((k) => keyIndex.get(k)).filter((x): x is number => x !== undefined),
			keep: (job.overrides?.keep || []).map((k) => keyIndex.get(k)).filter((x): x is number => x !== undefined),
		};

		// 4. first cut (heuristics) — sentences feed the AI
		step('analyze', 0.5, 'Phân tích đoạn hỏng, lặp lại, từ đệm...');
		const cutArgs = {words: tl.words, silences: tl.silences, duration: tl.duration, opts, overrides, clipBounds};
		let cut = decideCuts(cutArgs);

		// 5. AI (AGY CLI local model or Gemini API) — with Fashion 20-30s + TikTok Channel DNA + 3s Hook + Voice Over alignment
		let ai: AiResult | null = null;
		const dna = opts.dnaProfileId ? getDnaProfile(opts.dnaProfileId) : null;
		const effectiveMaxDur =
			opts.maxDuration > 0
				? opts.maxDuration
				: opts.fashionMode && opts.targetDurationRange === '20-30'
					? dna?.editingPreset.maxDuration || 28
					: 0;
		const agyCfg = getAgyConfig();
		const agyBin = agyCfg.enabled ? await findAgyBinary(agyCfg.customPath) : null;
		const aiKey = `${job.clips.map((c) => c.transcriptKey).join(',')}|${ord.order.join(',')}|${effectiveMaxDur}|${opts.style}|${opts.fashionMode ? 'F' : 'G'}|${opts.dnaProfileId || ''}|${hash((opts.brief || '') + (opts.hook3sDescription || '') + (opts.voiceOverScript || ''))}`;
		if (opts.useAI && (opts.geminiKey || agyBin) && tl.words.length) {
			ai = job.aiKey === aiKey ? readJson<AiResult>(id, 'ai.json') : null;
			if (!ai) {
				step('ai', 0.2, agyBin ? `AGY CLI (${agyCfg.customModel || agyCfg.model}) đang phân tích video...` : 'AI (Gemini) đang đọc kịch bản...');
				try {
					ai = await runGemini(opts.geminiKey, tl.words, cut.sentences, {
						language,
						maxDuration: effectiveMaxDur,
						style: opts.style,
						brief: opts.brief,
						fashionMode: opts.fashionMode,
						dna,
						hook3sDescription: opts.hook3sDescription,
						voiceOverScript: opts.voiceOverScript,
					});
					writeJson(id, 'ai.json', ai);
					job.aiKey = aiKey;
					log(`AI: bỏ ${ai.dropSentences?.length || 0} câu, ${ai.beats?.length || 0} hiệu ứng, hook 3s: “${ai.hook3s?.title || ai.title || '-'}”`);
				} catch (e) {
					log(`AI lỗi, dùng thuật toán thay thế: ${(e as Error).message.slice(0, 160)}`);
					ai = null;
				}
			}
			if (ai) cut = decideCuts({...cutArgs, opts: {...opts, maxDuration: effectiveMaxDur}, ai: {dropSentences: ai.dropSentences, keepSentences: ai.keepSentences}});
		}
		step('analyze', 1);
		writeJson(id, 'cut.json', {
			...cut,
			keys: tl.keys,
			clips: tl.clips.map((c) => ({id: c.clip.id, name: c.clip.name, w0: c.w0, w1: c.w1, offset: c.offset, duration: c.duration})),
		});
		job.stats = cut.stats;
		log(`Bản cắt: ${cut.takes.length} đoạn, ${keptDuration(cut.takes).toFixed(1)}s / ${tl.duration.toFixed(1)}s gốc`);

		// 6. plan
		step('plan', 0.3, 'Lên kế hoạch phụ đề, zoom, hiệu ứng...');
		const base = `http://127.0.0.1:${PORT}`;
		const first = tl.clips[0].clip;
		const auto = buildPlan({
			words: tl.words,
			status: cut.status,
			takes: cut.takes,
			opts: {...opts, fixes: {...(ai?.fixes || {}), ...opts.fixes}},
			src: {width: first.proxy!.width, height: first.proxy!.height, url: `${base}/files/${id}/${first.proxyFile}`},
			clips: tl.clips.map((c) => ({
				url: `${base}/files/${id}/${c.clip.proxyFile}`,
				width: c.clip.proxy!.width,
				height: c.clip.proxy!.height,
				offset: c.offset,
				duration: c.duration,
			})),
			face: tl.face.length ? tl.face : null,
			ai: ai ? {title: opts.title ? undefined : ai.title, keywords: ai.keywords, beats: ai.beats} : null,
			baseUrl: base,
			seed: job.version,
		});
		const timeline = planToTimeline(auto, ord.order, opts);
		writeJson(id, 'timeline.json', timeline);
		const plan = compileTimeline(timeline, buildCtx(job, base));
		writeJson(id, 'plan.json', plan);
		fs.writeFileSync(fileOf(id, 'captions.srt'), timelineToSrt(plan));
		log(
			`Kế hoạch: ${plan.captions.groups.length} cụm phụ đề, ${plan.beats.length} hiệu ứng, ${plan.camera.snaps.length} lần zoom, ${plan.sfx.length} âm thanh${tl.face.length ? ', có bám mặt' : ''}`,
		);
		check();

		// 7. render
		await renderAndFinish(job, plan, dir, t0, ctrl, step, log, tl.duration);
	} catch (e) {
		const msg = (e as Error).message || String(e);
		if (ctrl.signal.aborted || msg === 'cancelled' || /cancel/i.test(msg)) {
			job.state = 'cancelled';
			job.message = 'Đã huỷ';
		} else {
			job.state = 'error';
			job.error = msg.slice(0, 2000);
			log(`LỖI: ${msg.slice(0, 400)}`);
			console.error(e);
		}
	} finally {
		controllers.delete(id);
		save(job);
	}
};

/** the recording minus its silent head and tail (whisper hallucinates on long silence) */
const speechSpan = (sil: [number, number][], dur: number): [number, number] => {
	let a = 0;
	let b = dur;
	const first = sil[0];
	if (first && first[0] <= 0.05) a = Math.max(0, first[1] - 0.3);
	const last = sil[sil.length - 1];
	if (last && last[1] >= dur - 0.05) b = Math.min(dur, last[0] + 0.4);
	return b - a > 0.5 ? [a, b] : [0, dur];
};

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

const renderAndFinish = async (
	job: Job,
	plan: EditPlan,
	dir: string,
	t0: number,
	ctrl: AbortController,
	step: (s: Step, p: number, msg?: string) => void,
	log: (s: string) => void,
	original: number,
) => {
	const id = job.id;
	const out = fileOf(id, 'output.tmp.mp4');
	const r0 = Date.now();
	await renderPlan(plan, out, job.options.quality, (p, stage) => step('render', p, `${stage} ${Math.round(p * 100)}%`), ctrl.signal);
	const final = `output-v${job.version}.mp4`;
	for (const f of fs.readdirSync(dir)) if (/^output-v\d+\.mp4$/.test(f)) fs.rmSync(path.join(dir, f), {force: true});
	fs.renameSync(out, fileOf(id, final));
	job.result = {
		duration: plan.durationInFrames / plan.fps,
		original,
		video: `/files/${id}/${final}`,
		srt: `/files/${id}/captions.srt`,
		plan: `/files/${id}/plan.json`,
		renderedAt: Date.now(),
		renderSeconds: Math.round((Date.now() - r0) / 1000),
	};
	job.state = 'done';
	job.step = 'done';
	job.progress = 1;
	log(`Hoàn tất sau ${Math.round((Date.now() - t0) / 1000)}s`);
};

const COLOR_V = 3;
/** measure every clip's colors once (auto color correction) */
export const ensureAutoColor = async (job: Job, log?: (s: string) => void) => {
	let changed = false;
	for (const c of job.clips) {
		if (!c.proxy || c.colorV === COLOR_V) continue;
		const file = fileOf(job.id, c.proxyFile);
		if (!fs.existsSync(file)) continue;
		try {
			c.color = await analyzeClipColor(file, c.proxy.duration, c.proxy.width, c.proxy.height);
		} catch {
			c.color = null;
		}
		c.colorV = COLOR_V;
		changed = true;
	}
	if (changed) {
		log?.('Đo màu từng clip để tự cân bằng màu');
		save(job);
	}
};

/** everything the timeline compiler needs (server render: absolute URLs; browser preview: base = '') */
export const buildCtx = (job: Job, base: string): CompileCtx => {
	const sfx: Record<string, string> = {};
	if (fs.existsSync(PATHS.sfx)) for (const f of fs.readdirSync(PATHS.sfx)) if (/\.(wav|mp3)$/.test(f)) sfx[f.replace(/\.(wav|mp3)$/, '')] = `${base}/sfx/${f}`;
	const faces: Record<string, FaceSample[]> = {};
	for (const c of job.clips) faces[c.id] = readJson<FaceSample[]>(job.id, c.faceFile) || [];
	return {
		opts: job.options,
		clips: job.clips
			.filter((c) => c.proxy)
			.map((c) => ({id: c.id, url: `${base}/files/${job.id}/${c.proxyFile}`, width: c.proxy!.width, height: c.proxy!.height, duration: c.proxy!.duration, color: c.color || null})),
		faces,
		sfx,
		music: listMusic().map((m) => ({id: m.id, url: `${base}/music/${m.file}`, mood: m.mood, styles: m.styles, lufs_i: m.lufs_i})),
		seed: job.version,
	};
};

export const getTimeline = async (id: string) => {
	const job = jobs.get(id);
	if (!job) throw new Error('Không tìm thấy dự án');
	if (job.state !== 'running' && job.state !== 'queued') await ensureAutoColor(job);
	let timeline = readJson<Timeline>(id, 'timeline.json');
	if (!timeline) {
		// projects made before the editor existed: rebuild the timeline from the last plan
		const plan = readJson<EditPlan>(id, 'plan.json');
		if (!plan) throw new Error('Chưa có timeline — hãy dựng tự động trước');
		timeline = planToTimeline(plan, job.order?.ids || job.clips.map((c) => c.id), job.options);
		writeJson(id, 'timeline.json', timeline);
	}
	return {timeline, ctx: buildCtx(job, ''), clips: publicJob(job).clips};
};

export const saveTimeline = (id: string, timeline: Timeline, options?: Partial<JobOptions>) => {
	const job = jobs.get(id);
	if (!job) throw new Error('Không tìm thấy dự án');
	if (!timeline || timeline.version !== 1 || !Array.isArray(timeline.segments)) throw new Error('Timeline không hợp lệ');
	writeJson(id, 'timeline.json', timeline);
	if (options) {
		const {geminiKey, ...rest} = options;
		job.options = {...job.options, ...rest};
		save(job);
	}
};

export const publicJob = (job: Job) => ({
	...job,
	options: {...job.options, geminiKey: job.options.geminiKey ? '••••' : ''},
	clips: job.clips.map((c) => ({
		id: c.id,
		name: c.name,
		url: `/files/${job.id}/${path.basename(c.input)}`,
		duration: c.probe.duration,
		width: c.probe.width,
		height: c.probe.height,
		recordedAt: c.recordedAt,
		fileModified: c.fileModified,
		hasAudio: c.probe.hasAudio,
	})),
});

/** transcript view for the editor UI */
export const jobDetail = (id: string) => {
	const job = jobs.get(id);
	if (!job) return null;
	const cut = readJson<{
		takes: Take[];
		status: WordStatus[];
		sentences: Sentence[];
		keys?: string[];
		clips?: {id: string; name: string; w0: number; w1: number}[];
	}>(id, 'cut.json');
	const plan = readJson<EditPlan>(id, 'plan.json');
	const ai = readJson<AiResult>(id, 'ai.json');
	// words in the last edit order
	const words: {i: number; k: string; t: string; s: number; e: number}[] = [];
	const order = job.order?.ids || job.clips.map((c) => c.id);
	for (const cid of order) {
		const c = job.clips.find((x) => x.id === cid);
		if (!c) continue;
		const an = readJson<Analysis>(id, c.analysisFile);
		for (const w of an?.words || []) {
			if (c.proxy && w.start >= c.proxy.duration) continue;
			words.push({i: words.length, k: `${c.id}:${w.i}`, t: w.text, s: +w.start.toFixed(2), e: +w.end.toFixed(2)});
		}
	}
	const keys = cut?.keys || words.map((w) => w.k.replace(/^c0:/, 'c0:'));
	const sameKeys = !!cut && keys.length === words.length && keys.every((k, i) => k === words[i].k);
	return {
		job: publicJob(job),
		words,
		status: sameKeys ? cut!.status : [],
		sentences: sameKeys ? cut!.sentences.map((s) => ({id: s.id, w0: s.w0, w1: s.w1})) : [],
		clipRanges: sameKeys ? cut!.clips || [] : [],
		takes: cut?.takes || [],
		hook3s: ai?.hook3s || null,
		planSummary: plan
			? {
					groups: plan.captions.groups.length,
					beats: plan.beats.filter((b) => b.type !== 'flash' && b.type !== 'dip').map((b) => ({type: b.type, start: +b.start.toFixed(2), text: b.text || b.emoji})),
					duration: plan.durationInFrames / plan.fps,
				}
			: null,
	};
};
