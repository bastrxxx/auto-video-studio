// Step 5: the edit plan (ghost-editor's reel.json, generated automatically):
// timeline segments, word-timed captions placed off the face, zoom snaps / pushes, face-following crop,
// big-number cards, emoji reactions, hook title, end card, sound effects levelled by role, ducked music.
import fs from 'node:fs';
import path from 'node:path';
import {cameraAt, toScreen} from '../../shared/camera.js';
import {STYLES} from '../../shared/styles.js';
import type {Beat, CaptionGroup, EditPlan, FaceSample, JobOptions, PlanWord, Push, Segment, SfxCue, Take, Word} from '../../shared/types.js';
import {PATHS} from '../config.js';
import type {WordStatus} from './edit.js';
import {emojiFor, endsSentence, findNumber, isStop, keywordScore} from './text.js';
import {outputSize} from './prep.js';

export type AiBeats = {
	title?: string;
	keywords?: number[]; // word indices
	beats?: {type: 'big' | 'emoji' | 'pill'; word: number; text?: string; sub?: string; emoji?: string}[];
};

const PLATFORM_SAFE: Record<string, {top: number; bottom: number; right: number}> = {
	instagram: {top: 220, bottom: 420, right: 130},
	tiktok: {top: 160, bottom: 480, right: 150},
	shorts: {top: 140, bottom: 380, right: 140},
	all: {top: 220, bottom: 480, right: 150},
	none: {top: 90, bottom: 140, right: 40},
};

// --- sound kit -------------------------------------------------------------
const SFX_ROLES: Record<string, {ids: string[]; vol: number}> = {
	whoosh: {ids: ['whoosh-1', 'whoosh-2', 'whoosh-3', 'cc0-whoosh-reverse'], vol: 0.16},
	slam: {ids: ['whoosh-cine', 'cc0-whoosh-reverse'], vol: 0.16},
	pop: {ids: ['pop-1', 'pop-2', 'pop-3', 'cc0-paper-flip'], vol: 0.12},
	impact: {ids: ['impact-1', 'impact-2', 'cc0-glitch-hit', 'cc0-deep-boom'], vol: 0.22},
	riser: {ids: ['riser-1', 'cc0-riser-short', 'cc0-swell-short'], vol: 0.14},
	ding: {ids: ['ding-1', 'cc0-tada'], vol: 0.2},
	meme: {ids: ['cc0-wow-voice', 'cc0-group-ooh', 'cc0-huh-voice', 'cc0-cartoon-zip', 'cc0-vinyl-scratch'], vol: 0.35},
};

let sfxCache: Map<string, string> | null = null;
const sfxFiles = () => {
	if (sfxCache) return sfxCache;
	const cache = new Map<string, string>();
	if (fs.existsSync(PATHS.sfx))
		for (const f of fs.readdirSync(PATHS.sfx)) {
			const id = f.replace(/\.(wav|mp3)$/, '');
			if (id !== f) cache.set(id, f);
		}
	sfxCache = cache;
	return cache;
};
export const resetSfxCache = () => {
	sfxCache = null;
};

const makeSfxPicker = (baseUrl: string) => {
	const rr: Record<string, number> = {};
	return (role: keyof typeof SFX_ROLES): {src: string; volume: number} | null => {
		const r = SFX_ROLES[role];
		const files = sfxFiles();
		const ids = r.ids.filter((id) => files.has(id));
		if (!ids.length) return null;
		const k = (rr[role] = ((rr[role] ?? -1) + 1) % ids.length);
		// prefer licensed Mixkit files when present (listed first), cc0 as fallback
		return {src: `${baseUrl}/sfx/${files.get(ids[k])}`, volume: r.vol};
	};
};

// --- music -------------------------------------------------------------------
type MusicEntry = {file: string; mood: string[]; styles: string[]; lufs_i?: number};
export const listMusic = (): (MusicEntry & {id: string})[] => {
	const manifest = path.join(PATHS.music, 'manifest.json');
	if (!fs.existsSync(manifest)) return [];
	const m = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, MusicEntry>;
	return Object.entries(m)
		.filter(([, v]) => fs.existsSync(path.join(PATHS.music, v.file)))
		.map(([id, v]) => ({id, ...v}));
};

// ---------------------------------------------------------------------------

export const buildPlan = (args: {
	words: Word[];
	status: WordStatus[];
	takes: Take[];
	opts: JobOptions;
	src: {width: number; height: number; url: string};
	/** multi-clip projects: clips in edit order on one virtual timeline (offset = start second of the clip) */
	clips?: {url: string; width: number; height: number; offset: number; duration: number}[];
	face: FaceSample[] | null;
	ai?: AiBeats | null;
	baseUrl: string; // http://localhost:PORT
	seed?: number;
}): EditPlan => {
	const {words, status, takes, opts, face, ai, baseUrl} = args;
	const fps = 30;
	const style = STYLES[opts.style] || STYLES.clean;
	const clips = args.clips?.length ? args.clips : [{url: args.src.url, width: args.src.width, height: args.src.height, offset: 0, duration: Infinity}];
	const clipOf = (t: number) => {
		let k = 0;
		for (let i = 0; i < clips.length; i++) if (t >= clips[i].offset - 1e-6) k = i;
		return k;
	};
	const {width: OW, height: OH} = outputSize(opts.format, clips[0]);
	const vertical = OH > OW * 1.2;
	const safeBase = vertical ? PLATFORM_SAFE[opts.platform] || PLATFORM_SAFE.all : PLATFORM_SAFE.none;
	const ky = OH / 1920;
	const safe = {top: Math.round(safeBase.top * ky), bottom: Math.round(safeBase.bottom * ky), right: Math.round(safeBase.right * (OW / 1080))};
	const unit = Math.min(OW, OH) / 1080; // scale for sizes designed at 1080 short side
	const accent = opts.accent || style.accent;

	// ---- timeline -------------------------------------------------------------
	const segments: Segment[] = [];
	const editTakes: {a: number; b: number; start: number; end: number; clip: number}[] = [];
	let frame = 0;
	for (const t of takes) {
		const clip = clipOf((t.a + t.b) / 2);
		const off = clips[clip].offset;
		const trimBefore = Math.max(0, Math.round((t.a - off) * fps));
		const dur = Math.max(1, Math.round((t.b - t.a) * fps));
		segments.push({from: frame, dur, trimBefore, clip});
		editTakes.push({a: off + trimBefore / fps, b: off + (trimBefore + dur) / fps, start: frame / fps, end: (frame + dur) / fps, clip});
		frame += dur;
	}
	const speechEnd = frame / fps;
	const toEdit = (orig: number): number | null => {
		for (const k of editTakes) if (orig >= k.a - 1e-6 && orig < k.b) return k.start + (orig - k.a);
		return null;
	};
	const takeOfEdit = (t: number) => editTakes.find((k) => t >= k.start && t < k.end) || editTakes[editTakes.length - 1];
	const toOrig = (t: number) => {
		const k = takeOfEdit(t);
		return k.a + (t - k.start);
	};

	// outro (frozen last frame under the end card, ghost-editor "outro")
	const outroDur = opts.cta ? 2.6 : 0;
	if (outroDur > 0 && segments.length) {
		const last = segments[segments.length - 1];
		const dur = Math.round(outroDur * fps);
		segments.push({from: frame, dur, trimBefore: last.trimBefore + last.dur - 1, clip: last.clip, freeze: true});
		frame += dur;
	}
	const total = frame / fps;

	// ---- words on the edit timeline --------------------------------------------
	const fixes = Object.entries(opts.fixes || {}).filter(([k]) => k.trim());
	const applyFix = (t: string) => {
		for (const [from, to] of fixes) {
			const re = new RegExp(`(^|[^\\p{L}])(${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}])`, 'giu');
			t = t.replace(re, (_m, pre) => `${pre}${to}`);
		}
		return t;
	};
	type EW = PlanWord & {i: number; orig: Word};
	const ew: EW[] = [];
	for (const w of words) {
		if (!status[w.i]?.keep) continue;
		const mid = (w.start + w.end) / 2;
		const s = toEdit(Math.max(w.start, mid - 0.01)) ?? toEdit(mid);
		if (s === null) continue;
		const k = takeOfEdit(s);
		const start = Math.max(k.start, toEdit(w.start) ?? k.start);
		const end = Math.min(k.end, toEdit(Math.min(w.end, k.b - 0.001)) ?? k.end);
		ew.push({i: w.i, orig: w, text: applyFix(w.text), start, end: Math.max(end, start + 0.05)});
	}

	// ---- keywords -------------------------------------------------------------
	const aiKeywords = new Set(ai?.keywords || []);

	// ---- caption groups ---------------------------------------------------------
	const look = {
		style: style.id,
		...style.caption,
		size: Math.round(style.caption.size * unit * (opts.captionSize || 1) * (vertical ? 1 : 0.8)),
		activeColor: style.caption.activeColor ? (opts.accent || style.caption.activeColor) : null,
		keywordColor: opts.accent || style.caption.keywordColor,
	};
	const maxLineW = OW * look.maxWidth;
	const charW = look.size * (look.upper ? 0.62 : 0.56) * (look.font === 'Anton' || look.font === 'Oswald' ? 0.8 : 1);
	const maxChars = Math.max(8, Math.floor(maxLineW / charW));
	const rawGroups: EW[][] = [];
	let cur: EW[] = [];
	for (let k = 0; k < ew.length; k++) {
		const w = ew[k];
		const prev = cur[cur.length - 1];
		const len = cur.reduce((a, x) => a + x.text.length + 1, 0) + w.text.length;
		const brk =
			prev &&
			(cur.length >= Math.max(1, opts.wordsPerGroup) ||
				w.start - prev.end > 0.6 ||
				clipOf(w.orig.start) !== clipOf(prev.orig.start) ||
				/[,;:]$/.test(prev.text) ||
				endsSentence(prev.text) ||
				len > maxChars * 2);
		if (brk) {
			rawGroups.push(cur);
			cur = [];
		}
		cur.push(w);
	}
	if (cur.length) rawGroups.push(cur);

	// ---- face on screen -----------------------------------------------------------
	const faces = (face || []).filter((f) => f.w > 0.02).sort((a, b) => a.t - b.t);
	const faceAtOrig = (t: number): FaceSample | null => {
		if (!faces.length) return null;
		let lo = 0;
		let hi = faces.length - 1;
		while (hi - lo > 1) {
			const m = (lo + hi) >> 1;
			if (faces[m].t <= t) lo = m;
			else hi = m;
		}
		const best = Math.abs(faces[lo].t - t) < Math.abs(faces[hi].t - t) ? faces[lo] : faces[hi];
		return Math.abs(best.t - t) < 1.5 ? best : null;
	};

	// crop-follow and zoom-origin tracks: steady per take (a static frame reads as a camera operator;
	// only a real move of the speaker re-frames, in 2 s windows)
	const follow: [number, number, number][] = [];
	const origin: [number, number, number][] = [];
	const median = (xs: number[]) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length ? s[Math.floor(s.length / 2)] : NaN;
	};
	for (const k of editTakes) {
		const inTake = faces.filter((f) => f.t >= k.a - 0.2 && f.t <= k.b + 0.2);
		if (!inTake.length) continue;
		const cxs = inTake.map((f) => f.x + f.w / 2);
		const spread = Math.max(...cxs) - Math.min(...cxs);
		const windows: [number, FaceSample[]][] = [];
		if (spread < 0.08 || k.end - k.start < 3) windows.push([k.start, inTake]);
		else
			for (let t = k.a; t < k.b; t += 2) windows.push([k.start + (t - k.a), inTake.filter((f) => f.t >= t && f.t < t + 2)]);
		for (const [t, fs] of windows) {
			if (!fs.length) continue;
			const cx = median(fs.map((f) => f.x + f.w / 2));
			const fy = median(fs.map((f) => (f.eye ?? f.y + f.h * 0.4)));
			const fh = median(fs.map((f) => f.h));
			// crop centre: face slightly above the middle of the frame (eyes on the upper third)
			const cy = fy + fh * 0.55;
			const tt = Math.max(k.start, t);
			follow.push([tt, cx, cy]);
			origin.push([tt, cx, fy + fh * 0.2]);
		}
		// hold until the cut, then jump (no slide across a cut)
		const lf = follow[follow.length - 1];
		const lo = origin[origin.length - 1];
		if (lf) follow.push([k.end - 0.001, lf[1], lf[2]]);
		if (lo) origin.push([k.end - 0.001, lo[1], lo[2]]);
	}

	// ---- zoom: snaps at cuts and sentence starts, slow pushes on long takes ------------
	const intensity = Math.max(0, opts.zoom) * style.zoomBias;
	const snaps: [number, number][] = [];
	const pushes: Push[] = [];
	const Z = 1 + 0.11 * intensity;
	if (intensity > 0) {
		let tight = false;
		let lastSnap = -10;
		const sentenceStarts = new Set<number>();
		for (let k = 1; k < ew.length; k++) if (endsSentence(ew[k - 1].text) || ew[k].start - ew[k - 1].end > 0.5) sentenceStarts.add(k);
		const cutTimes = editTakes.slice(1).map((k) => k.start);
		const events = [...cutTimes.map((t) => ({t, cut: true})), ...[...sentenceStarts].map((k) => ({t: ew[k].start - 0.05, cut: false}))].sort((a, b) => a.t - b.t);
		snaps.push([0, 1]);
		for (const e of events) {
			if (e.t - lastSnap < (e.cut ? 0.9 : 2.8)) continue;
			tight = !tight;
			snaps.push([Math.max(0, e.t), tight ? Z : 1]);
			lastSnap = e.t;
		}
		// slow pushes on long stretches without a snap (4-6 per reel in ghost-editor)
		const bounds = [...snaps.map((s) => s[0]), outroDur > 0 ? speechEnd : total];
		let count = 0;
		for (let k = 0; k < bounds.length - 1 && count < 8; k++) {
			const a = bounds[k];
			const b = bounds[k + 1];
			if (b - a >= 3.5) {
				pushes.push({start: a + 0.2, end: b, z: 1 + 0.06 * intensity, up: (b - a) * 0.9, down: 0});
				count++;
			}
		}
		if (outroDur > 0) pushes.push({start: speechEnd, end: total, z: 1 + 0.05 * intensity, up: outroDur, down: 0});
	}

	const planBase = {
		width: OW,
		height: OH,
		fps,
		segments,
		clips: clips.map((c) => ({src: c.url, width: c.width, height: c.height})),
		srcWidth: clips[0].width,
		srcHeight: clips[0].height,
		fit: opts.fit,
		camera: {snaps, pushes, follow, origin, ease: opts.style === 'minimal' || opts.style === 'cinematic'},
	};

	const screenFace = (t: number) => {
		const f = faceAtOrig(toOrig(Math.min(t, speechEnd - 0.01)));
		if (!f) return null;
		const cam = cameraAt(planBase, t);
		const [l, top] = toScreen(cam, f.x, f.y);
		const [r, bottom] = toScreen(cam, f.x + f.w, f.y + f.h);
		const [, mouth] = toScreen(cam, 0, f.mouth ?? f.y + f.h * 0.78);
		const [, chin] = toScreen(cam, 0, f.chin ?? f.y + f.h);
		return {left: l, right: r, top, bottom: Math.max(bottom, chin), mouth};
	};
	const faceSpan = (t0: number, t1: number) => {
		let r: {left: number; right: number; top: number; bottom: number; mouth: number} | null = null;
		for (let t = t0; t <= t1 + 1e-6; t += 0.1) {
			const f = screenFace(t);
			if (!f) continue;
			if (!r) r = {...f};
			else {
				r.left = Math.min(r.left, f.left);
				r.right = Math.max(r.right, f.right);
				r.top = Math.min(r.top, f.top);
				r.bottom = Math.max(r.bottom, f.bottom);
				r.mouth = Math.max(r.mouth, f.mouth);
			}
		}
		return r;
	};

	// caption placement (ghost-editor safezone.mjs): below the chin, else above the head,
	// else under the mouth on a dark backing; always inside the platform safe area; hysteresis
	const idealCenter = vertical ? OH * 0.64 : OH * 0.83;
	const gap = 36 * unit;
	const placeBlock = (t0: number, t1: number, h: number, prevTop: number | null) => {
		const minTop = safe.top;
		const maxTop = OH - safe.bottom - h;
		let top = Math.min(maxTop, Math.max(minTop, idealCenter - h / 2));
		let backing = false;
		const f = faceSpan(t0, t1);
		if (f) {
			const overlaps = (y: number) => y < f.bottom && y + h > f.top + (f.bottom - f.top) * 0.15;
			if (overlaps(top)) {
				const below = Math.max(top, f.bottom + gap);
				const above = f.top - gap - h;
				if (below <= maxTop) top = below;
				else if (above >= minTop) top = above;
				else {
					top = Math.min(maxTop, Math.max(minTop, f.mouth + gap * 0.6));
					backing = true;
				}
			}
		}
		if (prevTop !== null && Math.abs(prevTop - top) < 60 * unit && !backing) {
			const t = Math.min(maxTop, Math.max(minTop, prevTop));
			if (!f || t >= f.bottom || t + h <= f.top) top = t;
		}
		return {top: Math.round(top), backing};
	};

	const lineH = look.size * 1.22;
	let prevTop: number | null = null;
	const groups: CaptionGroup[] = rawGroups.map((g, gi) => {
		const next = rawGroups[gi + 1];
		const start = g[0].start;
		const lastEnd = g[g.length - 1].end;
		let end = lastEnd + 0.35;
		if (next) {
			const gapToNext = next[0].start - lastEnd;
			end = gapToNext <= 0.6 ? next[0].start : Math.min(lastEnd + 0.4, next[0].start);
		}
		end = Math.min(Math.max(end, lastEnd), outroDur > 0 ? speechEnd : total);
		// keyword: one per group at most, the strongest
		let bestK = -1;
		let bestS = 2.2;
		g.forEach((w, k) => {
			const s = aiKeywords.has(w.i) ? 10 : aiKeywords.size ? keywordScore(w.orig, k) * 0.5 : keywordScore(w.orig, k);
			if (s > bestS) {
				bestS = s;
				bestK = k;
			}
		});
		const text = g.map((w) => w.text).join(' ');
		const lines = Math.min(3, Math.ceil(text.length / maxChars));
		const h = lines * lineH + 24 * unit;
		const {top, backing} = placeBlock(start, end, h, prevTop);
		prevTop = top;
		return {
			start,
			end,
			y: top,
			backing,
			words: g.map((w, k) => ({text: w.text, start: w.start, end: w.end, keyword: k === bestK || undefined})),
		};
	});

	// ---- beats -----------------------------------------------------------------
	const beats: Beat[] = [];
	const busy = (a: number, b: number, types?: string[]) => beats.some((x) => (!types || types.includes(x.type)) && a < x.end && b > x.start);

	if (opts.title || ai?.title) {
		const text = (opts.title || ai?.title || '').trim();
		if (text)
			beats.push({type: 'title', start: 0, end: Math.min(3.2, Math.max(2, (ew.find((w) => endsSentence(w.text))?.end ?? 2.6) + 0.2)), text, y: safe.top + 150 * unit});
	}

	const addBig = (k: number, text: string, sub: string | undefined, count?: Beat['count']) => {
		const w = ew[k];
		const start = Math.max(0, w.start - 0.05);
		const end = Math.min(start + 2.2, outroDur > 0 ? speechEnd : total);
		if (end - start < 1 || busy(start - 0.3, end + 0.3, ['big', 'title'])) return false;
		const h = 340 * unit;
		const {top} = placeBlock(start, end, h, null);
		beats.push({type: 'big', start, end, text, sub, count, x: OW / 2, y: top + h / 2});
		return true;
	};

	let lastBig = -10;
	if (opts.bigNumbers) {
		for (let k = 0; k < ew.length; k++) {
			const hit = findNumber(ew.map((x) => x.orig), k);
			if (!hit) continue;
			if (ew[k].start - lastBig < 5) continue;
			const after = ew.slice(k + hit.words, k + hit.words + 4).filter((x) => !isStop(x.text));
			const sub = after
				.slice(0, 3)
				.map((x) => x.text.replace(/[.,!?…]+$/, ''))
				.join(' ')
				.toUpperCase();
			const integer = hit.decimals === 0;
			const text = `${hit.prefix}${integer ? Math.round(hit.value).toLocaleString('en-US') : hit.value.toFixed(hit.decimals)}${hit.suffix}`;
			const count = hit.value <= 1e7 && hit.value >= 5 ? {from: 0, to: hit.value, prefix: hit.prefix, suffix: hit.suffix, decimals: hit.decimals} : undefined;
			if (addBig(k, text, sub || undefined, count)) lastBig = ew[k].start;
		}
	}

	// AI beats (Gemini) by word index
	const byIdx = new Map(ew.map((w, k) => [w.i, k]));
	for (const b of ai?.beats || []) {
		const k = byIdx.get(b.word);
		if (k === undefined) continue;
		if (b.type === 'big' && opts.bigNumbers && b.text) addBig(k, b.text, b.sub);
		if (b.type === 'emoji' && opts.emoji && b.emoji) addEmoji(k, b.emoji);
		if (b.type === 'pill' && b.text) {
			const s = ew[k].start;
			if (!busy(s, s + 1.8, ['pill', 'big', 'title'])) beats.push({type: 'pill', start: s, end: s + 1.8, text: b.text, x: OW / 2, y: safe.top + 120 * unit});
		}
	}

	function addEmoji(k: number, emoji: string) {
		const w = ew[k];
		const start = w.start;
		const end = Math.min(start + 1.6, total);
		if (busy(start - 1.5, end + 1.5, ['emoji']) || busy(start, end, ['big', 'title'])) return false;
		const perMin = Math.max(0, style.emojiDensity);
		const already = beats.filter((x) => x.type === 'emoji').length;
		if (already >= Math.max(ai?.beats ? 6 : 1, Math.ceil((perMin * total) / 60))) return false;
		const f = faceSpan(start, end);
		const size = 190 * unit;
		let x = OW * 0.78;
		let y = OH * (vertical ? 0.3 : 0.25);
		if (f) {
			const roomRight = OW - safe.right - f.right;
			x = roomRight > size * 1.1 ? f.right + size * 0.7 : f.left - size * 0.7;
			x = Math.min(OW - safe.right - size * 0.6, Math.max(size * 0.6, x));
			y = Math.max(safe.top + size * 0.6, f.top + size * 0.3);
		}
		beats.push({type: 'emoji', start, end, emoji, x, y, size});
		return true;
	}

	if (opts.emoji && style.emojiDensity > 0 && !(ai?.beats || []).some((b) => b.type === 'emoji')) {
		for (let k = 0; k < ew.length; k++) {
			const e = emojiFor(ew[k].text, ew[k + 1]?.text);
			if (e) addEmoji(k, e);
		}
	}

	if (opts.cta && outroDur > 0) {
		beats.push({type: 'endcard', start: speechEnd, end: total, text: opts.cta, x: OW / 2, y: OH * 0.5});
	}
	// scene changes between clips (multi-clip projects)
	const clipChanges: number[] = [];
	for (let k = 1; k < editTakes.length; k++) if (editTakes[k].clip !== editTakes[k - 1].clip) clipChanges.push(editTakes[k].start);
	if (opts.transition === 'flash' || opts.transition === 'dip') {
		for (const t of clipChanges) {
			const half = opts.transition === 'dip' ? 0.2 : 0.12;
			beats.push({type: opts.transition, start: Math.max(0, t - half), end: t + half});
		}
	}
	beats.sort((a, b) => a.start - b.start);

	// ---- sound -------------------------------------------------------------------
	const sfx: SfxCue[] = [];
	if (opts.sfx !== 'off') {
		const pick = makeSfxPicker(baseUrl);
		const level = opts.sfx;
		const MAXDUR: Record<string, number> = {pop: 0.6, whoosh: 1.0, slam: 1.2, impact: 1.6, riser: 1.6, ding: 1.8, meme: 1.3};
		const add = (role: keyof typeof SFX_ROLES, at: number, gain = 1) => {
			const s = pick(role);
			if (s && at >= 0) sfx.push({at, src: s.src, volume: s.volume * gain, maxDur: MAXDUR[role] ?? 1.5});
		};
		for (const b of beats) {
			if (b.type === 'big') {
				add('slam', Math.max(0, b.start - 0.2));
				add('impact', b.start + 0.05, level === 'restrained' ? 0.8 : 1);
			} else if (b.type === 'title') add('whoosh', 0.05);
			else if (b.type === 'emoji' && level !== 'restrained') add('pop', b.start);
			else if (b.type === 'pill' && level !== 'restrained') add('pop', b.start);
			else if (b.type === 'endcard') {
				add('riser', Math.max(0, b.start - 1.1));
				add('ding', b.start + 0.1);
			}
		}
		if (opts.transition !== 'cut') for (const t of clipChanges) add(opts.transition === 'dip' ? 'riser' : 'whoosh', Math.max(0, t - 0.25), opts.transition === 'whoosh' ? 1 : 0.6);
		if (level === 'rich') {
			// a quiet whoosh on every third snap, and a reaction on the first emoji
			snaps.filter((s, k) => k > 0 && k % 3 === 0).forEach((s) => add('whoosh', Math.max(0, s[0] - 0.12), 0.6));
			const firstEmoji = beats.find((b) => b.type === 'emoji');
			if (firstEmoji) add('meme', firstEmoji.start + 0.15);
		}
	}

	// ---- music ---------------------------------------------------------------
	let music: EditPlan['music'] = null;
	if (opts.music) {
		const lib = listMusic();
		let m = opts.music !== 'auto' ? lib.find((x) => x.id === opts.music) : undefined;
		if (!m && lib.length) {
			const scored = lib
				.map((x) => ({x, s: x.mood.filter((md) => style.musicMood.includes(md)).length + (x.styles.includes(style.id) ? 2 : 0)}))
				.sort((a, b) => b.s - a.s);
			const top = scored.filter((s) => s.s === scored[0].s);
			m = top[(args.seed ?? 0) % top.length].x;
		}
		if (m) {
			// music bed ~20 dB under the -16 LUFS voice while speaking, +6 dB in the gaps
			const lufs = m.lufs_i ?? -12;
			const duck = Math.min(0.5, Math.pow(10, (-16 - 21 - lufs) / 20));
			const speech: [number, number][] = [];
			for (const w of ew) {
				const last = speech[speech.length - 1];
				if (last && w.start - last[1] < 0.6) last[1] = w.end;
				else speech.push([w.start, w.end]);
			}
			music = {src: `${baseUrl}/music/${m.file}`, volume: Math.min(0.7, duck * 2), duckVolume: duck, speech};
		}
	}

	return {
		version: 1,
		...planBase,
		durationInFrames: Math.max(1, frame),
		src: clips[0].url,
		captions: {enabled: opts.captions, look, groups},
		beats,
		sfx: sfx.sort((a, b) => a.at - b.at),
		music,
		look: style.look,
		brand: {accent, ink: style.ink, font: style.caption.font},
		progressBar: {enabled: opts.progressBar, color: accent},
		safe,
	};
};

const srtTime = (t: number) => {
	const ms = Math.max(0, Math.round(t * 1000));
	const h = Math.floor(ms / 3600000);
	const m = Math.floor((ms % 3600000) / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	const r = ms % 1000;
	const p = (n: number, l = 2) => String(n).padStart(l, '0');
	return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
};

export const toSrt = (plan: EditPlan) =>
	plan.captions.groups.map((g, k) => `${k + 1}\n${srtTime(g.start)} --> ${srtTime(g.end)}\n${g.words.map((w) => w.text).join(' ')}\n`).join('\n');
