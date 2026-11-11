// The editable timeline (CapCut-style document) and its compiler to a Remotion EditPlan.
// Everything here is pure (no Node APIs): the server uses it to render, the browser uses it for the live preview.
//
// Captions and effects are anchored to SOURCE time (clip + seconds in that clip), not to the output timeline,
// so deleting / trimming / re-ordering video segments carries them along — like linked clips in an NLE.
import {cameraAt, toScreen} from './camera';
import {STYLES} from './styles';
import {combineAdjust, gradeOf, type ColorAdjust, type Grade} from './color';
import type {Beat, CaptionGroup, EditPlan, FaceSample, JobOptions, Push, Segment, SfxCue} from './types';

export type TlSegment = {id: string; clip: string; a: number; b: number; color?: Partial<ColorAdjust>}; // seconds in the clip; color = per-segment adjust
export type TlWord = {text: string; a: number; b: number; keyword?: boolean}; // seconds in the clip
export type TlCaption = {id: string; clip: string; words: TlWord[]};
export type TlBeat = {
	id: string;
	type: 'big' | 'emoji' | 'pill';
	clip: string;
	a: number; // seconds in the clip
	dur: number;
	text?: string;
	sub?: string;
	emoji?: string;
	count?: Beat['count'];
};
export type Timeline = {
	version: 1;
	segments: TlSegment[];
	captions: TlCaption[];
	beats: TlBeat[];
	title: {text: string; dur: number} | null;
	cta: {text: string; dur: number} | null;
};

export type CompileClip = {id: string; url: string; width: number; height: number; duration: number; color?: Partial<ColorAdjust> | null};
export type MusicItem = {id: string; url: string; mood: string[]; styles: string[]; lufs_i?: number};
export type CompileCtx = {
	opts: JobOptions;
	clips: CompileClip[];
	faces: Record<string, FaceSample[]>; // clip id -> samples (clip seconds)
	sfx: Record<string, string>; // sound id -> url
	music: MusicItem[];
	seed?: number;
};

export const FPS = 30;

export const outputSize = (format: JobOptions['format'], src: {width: number; height: number}) => {
	switch (format) {
		case '9:16':
			return {width: 1080, height: 1920};
		case '16:9':
			return {width: 1920, height: 1080};
		case '1:1':
			return {width: 1080, height: 1080};
		case '4:5':
			return {width: 1080, height: 1350};
		default: {
			const k = Math.min(1, 1920 / Math.max(src.width, src.height));
			const even = (x: number) => Math.max(2, Math.round((x * k) / 2) * 2);
			return {width: even(src.width), height: even(src.height)};
		}
	}
};

/** where every segment lands on the output timeline (frame-exact, same rounding as the render) */
export const layoutSegments = (tl: Pick<Timeline, 'segments'>, fps = FPS) => {
	let frame = 0;
	return tl.segments.map((s) => {
		const trimBefore = Math.max(0, Math.round(s.a * fps));
		const dur = Math.max(1, Math.round((s.b - s.a) * fps));
		const out = {seg: s, from: frame, dur, trimBefore, start: frame / fps, end: (frame + dur) / fps, a: trimBefore / fps, b: (trimBefore + dur) / fps};
		frame += dur;
		return out;
	});
};
export type SegLayout = ReturnType<typeof layoutSegments>[number];

export const srcToEdit = (lay: SegLayout[], clip: string, t: number): number | null => {
	for (const s of lay) if (s.seg.clip === clip && t >= s.a - 1e-6 && t < s.b) return s.start + (t - s.a);
	return null;
};
export const editToSrc = (lay: SegLayout[], t: number): {clip: string; t: number; seg: SegLayout} | null => {
	if (!lay.length) return null;
	const s = lay.find((x) => t >= x.start && t < x.end) || (t < 0 ? lay[0] : lay[lay.length - 1]);
	return {clip: s.seg.clip, t: s.a + Math.min(s.b - s.a - 1e-3, Math.max(0, t - s.start)), seg: s};
};

const endsSentence = (t: string) => /[.!?…。]["')\]]*$/.test(t);

const SFX_ROLES: Record<string, {ids: string[]; vol: number; max: number}> = {
	whoosh: {ids: ['whoosh-1', 'whoosh-2', 'whoosh-3', 'cc0-whoosh-reverse'], vol: 0.16, max: 1.0},
	slam: {ids: ['whoosh-cine', 'cc0-whoosh-reverse'], vol: 0.16, max: 1.2},
	pop: {ids: ['pop-1', 'pop-2', 'pop-3', 'cc0-paper-flip'], vol: 0.12, max: 0.6},
	impact: {ids: ['impact-1', 'impact-2', 'cc0-glitch-hit', 'cc0-deep-boom'], vol: 0.22, max: 1.6},
	riser: {ids: ['riser-1', 'cc0-riser-short', 'cc0-swell-short'], vol: 0.14, max: 1.6},
	ding: {ids: ['ding-1', 'cc0-tada'], vol: 0.2, max: 1.8},
	meme: {ids: ['cc0-wow-voice', 'cc0-group-ooh', 'cc0-huh-voice', 'cc0-cartoon-zip', 'cc0-vinyl-scratch'], vol: 0.35, max: 1.3},
};

const PLATFORM_SAFE: Record<string, {top: number; bottom: number; right: number}> = {
	instagram: {top: 220, bottom: 420, right: 130},
	tiktok: {top: 160, bottom: 480, right: 150},
	shorts: {top: 140, bottom: 380, right: 140},
	all: {top: 220, bottom: 480, right: 150},
	none: {top: 90, bottom: 140, right: 40},
};

export const tlId = () => Math.random().toString(36).slice(2, 9);

export const captionText = (c: TlCaption) => c.words.map((w) => w.text).join(' ');

/** re-split an edited caption into words, keeping timings when the word count is unchanged */
export const retimeCaption = (c: TlCaption, text: string, a?: number, b?: number): TlCaption => {
	const toks = text.trim().split(/\s+/).filter(Boolean);
	const A = a ?? c.words[0]?.a ?? 0;
	const B = b ?? c.words[c.words.length - 1]?.b ?? A + 1;
	if (!toks.length) return {...c, words: []};
	if (toks.length === c.words.length && a === undefined && b === undefined) {
		return {...c, words: c.words.map((w, k) => ({...w, text: toks[k]}))};
	}
	// spread over [A, B] by character length (a long word takes longer to say)
	const weights = toks.map((t) => Math.max(2, t.length) + 1);
	const sum = weights.reduce((x, y) => x + y, 0);
	let cur = A;
	const old = new Set(c.words.filter((w) => w.keyword).map((w) => w.text.toLowerCase()));
	const words = toks.map((t, k) => {
		const d = ((B - A) * weights[k]) / sum;
		const w: TlWord = {text: t, a: cur, b: cur + d * 0.92, keyword: old.has(t.toLowerCase()) || undefined};
		cur += d;
		return w;
	});
	return {...c, words};
};

export const compileTimeline = (tl: Timeline, ctx: CompileCtx): EditPlan => {
	const {opts} = ctx;
	const fps = FPS;
	const style = STYLES[opts.style] || STYLES.clean;
	const clipIdx = new Map(ctx.clips.map((c, i) => [c.id, i]));
	const firstClip = ctx.clips[clipIdx.get(tl.segments[0]?.clip) ?? 0] || ctx.clips[0] || {id: '', url: '', width: 1080, height: 1920, duration: 1};
	const {width: OW, height: OH} = outputSize(opts.format, firstClip);
	const vertical = OH > OW * 1.2;
	const safeBase = vertical ? PLATFORM_SAFE[opts.platform] || PLATFORM_SAFE.all : PLATFORM_SAFE.none;
	const ky = OH / 1920;
	const safe = {top: Math.round(safeBase.top * ky), bottom: Math.round(safeBase.bottom * ky), right: Math.round(safeBase.right * (OW / 1080))};
	const unit = Math.min(OW, OH) / 1080;
	const accent = opts.accent || style.accent;

	// ---- timeline ------------------------------------------------------------
	const lay = layoutSegments(tl, fps);
	// color: one SVG grade per distinct (clip auto-correction + global settings + segment override)
	const grades: (Grade | null)[] = [];
	const gradeKeys = new Map<string, number>();
	const gradeFor = (clipId: string, override?: Partial<ColorAdjust>) => {
		const auto = ctx.clips.find((c) => c.id === clipId)?.color;
		const g = gradeOf(combineAdjust(opts.color, auto, override));
		if (!g) return undefined;
		const key = JSON.stringify(g);
		let i = gradeKeys.get(key);
		if (i === undefined) {
			i = grades.length;
			grades.push(g);
			gradeKeys.set(key, i);
		}
		return i;
	};
	const globalAdj = combineAdjust({...opts.color, auto: false});
	const segments: Segment[] = lay.map((s) => ({from: s.from, dur: s.dur, trimBefore: s.trimBefore, clip: clipIdx.get(s.seg.clip) ?? 0, grade: gradeFor(s.seg.clip, s.seg.color)}));
	let frame = lay.length ? lay[lay.length - 1].from + lay[lay.length - 1].dur : 0;
	const speechEnd = frame / fps;
	const outroDur = tl.cta?.text ? Math.max(1, tl.cta.dur || 2.6) : 0;
	if (outroDur > 0 && segments.length) {
		const last = segments[segments.length - 1];
		const dur = Math.round(outroDur * fps);
		segments.push({from: frame, dur, trimBefore: last.trimBefore + last.dur - 1, clip: last.clip, freeze: true, grade: last.grade});
		frame += dur;
	}
	const total = frame / fps;
	const segAt = (t: number) => lay.find((s) => t >= s.start && t < s.end) || lay[lay.length - 1];

	// ---- caption look ------------------------------------------------------------
	const look = {
		style: style.id,
		...style.caption,
		size: Math.round(style.caption.size * unit * (opts.captionSize || 1) * (vertical ? 1 : 0.8)),
		activeColor: style.caption.activeColor ? opts.accent || style.caption.activeColor : null,
		keywordColor: opts.accent || style.caption.keywordColor,
	};
	const maxLineW = OW * look.maxWidth;
	const charW = look.size * (look.upper ? 0.62 : 0.56) * (look.font === 'Anton' || look.font === 'Oswald' ? 0.8 : 1);
	const maxChars = Math.max(8, Math.floor(maxLineW / charW));

	// ---- captions on the edit timeline -------------------------------------------
	type G = {start: number; end: number; words: {text: string; start: number; end: number; keyword?: boolean}[]};
	const raw: G[] = [];
	for (const c of tl.captions) {
		const ws: G['words'] = [];
		for (const w of c.words) {
			const s = srcToEdit(lay, c.clip, w.a);
			if (s === null) continue;
			const sg = segAt(s);
			ws.push({text: w.text, start: s, end: Math.min(sg.end, s + Math.max(0.05, w.b - w.a)), keyword: w.keyword});
		}
		if (!ws.length) continue;
		ws.sort((x, y) => x.start - y.start);
		raw.push({start: ws[0].start, end: ws[ws.length - 1].end, words: ws});
	}
	raw.sort((a, b) => a.start - b.start);
	const allWords = raw.flatMap((g) => g.words);

	// ---- faces -------------------------------------------------------------------
	const faces: Record<string, FaceSample[]> = {};
	for (const [k, v] of Object.entries(ctx.faces || {})) faces[k] = (v || []).filter((f) => f.w > 0.02).sort((a, b) => a.t - b.t);
	const faceAtLocal = (clip: string, t: number): FaceSample | null => {
		const fs = faces[clip];
		if (!fs?.length) return null;
		let lo = 0;
		let hi = fs.length - 1;
		while (hi - lo > 1) {
			const m = (lo + hi) >> 1;
			if (fs[m].t <= t) lo = m;
			else hi = m;
		}
		const best = Math.abs(fs[lo].t - t) < Math.abs(fs[hi].t - t) ? fs[lo] : fs[hi];
		return Math.abs(best.t - t) < 1.5 ? best : null;
	};
	const median = (xs: number[]) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length ? s[Math.floor(s.length / 2)] : NaN;
	};
	const follow: [number, number, number][] = [];
	const origin: [number, number, number][] = [];
	for (const k of lay) {
		const inSeg = (faces[k.seg.clip] || []).filter((f) => f.t >= k.a - 0.2 && f.t <= k.b + 0.2);
		if (!inSeg.length) continue;
		const cxs = inSeg.map((f) => f.x + f.w / 2);
		const spread = Math.max(...cxs) - Math.min(...cxs);
		const windows: [number, FaceSample[]][] = [];
		if (spread < 0.08 || k.end - k.start < 3) windows.push([k.start, inSeg]);
		else for (let t = k.a; t < k.b; t += 2) windows.push([k.start + (t - k.a), inSeg.filter((f) => f.t >= t && f.t < t + 2)]);
		for (const [t, fs] of windows) {
			if (!fs.length) continue;
			const cx = median(fs.map((f) => f.x + f.w / 2));
			const fy = median(fs.map((f) => f.eye ?? f.y + f.h * 0.4));
			const fh = median(fs.map((f) => f.h));
			const tt = Math.max(k.start, t);
			follow.push([tt, cx, fy + fh * 0.55]);
			origin.push([tt, cx, fy + fh * 0.2]);
		}
		const lf = follow[follow.length - 1];
		const lo = origin[origin.length - 1];
		if (lf) follow.push([k.end - 0.001, lf[1], lf[2]]);
		if (lo) origin.push([k.end - 0.001, lo[1], lo[2]]);
	}

	// ---- zoom --------------------------------------------------------------------
	const intensity = Math.max(0, opts.zoom) * style.zoomBias;
	const snaps: [number, number][] = [];
	const pushes: Push[] = [];
	if (intensity > 0 && lay.length) {
		const Z = 1 + 0.11 * intensity;
		let tight = false;
		let lastSnap = -10;
		const events = [
			...lay.slice(1).map((s) => ({t: s.start, cut: true})),
			...raw.filter((g, k) => k > 0 && (endsSentence(raw[k - 1].words[raw[k - 1].words.length - 1].text) || g.start - raw[k - 1].end > 0.5)).map((g) => ({t: g.start - 0.05, cut: false})),
		].sort((a, b) => a.t - b.t);
		snaps.push([0, 1]);
		for (const e of events) {
			if (e.t - lastSnap < (e.cut ? 0.9 : 2.8)) continue;
			tight = !tight;
			snaps.push([Math.max(0, e.t), tight ? Z : 1]);
			lastSnap = e.t;
		}
		const bounds = [...snaps.map((s) => s[0]), speechEnd];
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
		clips: ctx.clips.map((c) => ({src: c.url, width: c.width, height: c.height})),
		srcWidth: firstClip.width,
		srcHeight: firstClip.height,
		fit: opts.fit,
		camera: {snaps, pushes, follow, origin, ease: opts.style === 'minimal' || opts.style === 'cinematic'},
	};

	// ---- face-safe placement (ghost-editor safezone) ---------------------------------
	const screenFace = (t: number) => {
		const s = segAt(Math.min(t, speechEnd - 0.001));
		if (!s) return null;
		const f = faceAtLocal(s.seg.clip, s.a + (Math.min(t, s.end) - s.start));
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
	const groups: CaptionGroup[] = raw.map((g, gi) => {
		const next = raw[gi + 1];
		const lastEnd = g.end;
		let end = lastEnd + 0.35;
		if (next) end = next.start - lastEnd <= 0.6 ? next.start : Math.min(lastEnd + 0.4, next.start);
		end = Math.min(Math.max(end, lastEnd), outroDur > 0 ? speechEnd : total);
		const text = g.words.map((w) => w.text).join(' ');
		const lines = Math.min(4, Math.ceil(text.length / maxChars));
		const h = lines * lineH + 24 * unit;
		const {top, backing} = placeBlock(g.start, end, h, prevTop);
		prevTop = top;
		return {start: g.start, end: Math.max(end, g.start + 0.1), y: top, backing, words: g.words};
	});

	// ---- beats -----------------------------------------------------------------------
	const beats: Beat[] = [];
	if (tl.title?.text) beats.push({type: 'title', start: 0, end: Math.max(0.8, Math.min(total, tl.title.dur || 2.6)), text: tl.title.text, y: safe.top + 150 * unit});
	for (const b of tl.beats) {
		const s = srcToEdit(lay, b.clip, b.a);
		if (s === null) continue;
		const end = Math.min(s + Math.max(0.3, b.dur), total);
		if (b.type === 'big') {
			const h = 340 * unit;
			const {top} = placeBlock(s, end, h, null);
			beats.push({type: 'big', start: s, end, text: b.text, sub: b.sub, count: b.count, x: OW / 2, y: top + h / 2});
		} else if (b.type === 'emoji') {
			const f = faceSpan(s, end);
			const size = 190 * unit;
			let x = OW * 0.78;
			let y = OH * (vertical ? 0.3 : 0.25);
			if (f) {
				const roomRight = OW - safe.right - f.right;
				x = roomRight > size * 1.1 ? f.right + size * 0.7 : f.left - size * 0.7;
				x = Math.min(OW - safe.right - size * 0.6, Math.max(size * 0.6, x));
				y = Math.max(safe.top + size * 0.6, f.top + size * 0.3);
			}
			beats.push({type: 'emoji', start: s, end, emoji: b.emoji, x, y, size});
		} else if (b.type === 'pill') {
			beats.push({type: 'pill', start: s, end, text: b.text, x: OW / 2, y: safe.top + 120 * unit});
		}
	}
	if (outroDur > 0) beats.push({type: 'endcard', start: speechEnd, end: total, text: tl.cta!.text, x: OW / 2, y: OH * 0.5});
	const clipChanges: number[] = [];
	for (let k = 1; k < lay.length; k++) if (lay[k].seg.clip !== lay[k - 1].seg.clip) clipChanges.push(lay[k].start);
	if (opts.transition === 'flash' || opts.transition === 'dip') {
		const half = opts.transition === 'dip' ? 0.2 : 0.12;
		for (const t of clipChanges) beats.push({type: opts.transition, start: Math.max(0, t - half), end: t + half});
	}
	beats.sort((a, b) => a.start - b.start);

	// ---- sound -------------------------------------------------------------------------
	const sfx: SfxCue[] = [];
	if (opts.sfx !== 'off') {
		const rr: Record<string, number> = {};
		const add = (role: string, at: number, gain = 1) => {
			const r = SFX_ROLES[role];
			const ids = r.ids.filter((id) => ctx.sfx[id]);
			if (!ids.length || at < 0) return;
			const k = (rr[role] = ((rr[role] ?? -1) + 1) % ids.length);
			sfx.push({at, src: ctx.sfx[ids[k]], volume: r.vol * gain, maxDur: r.max});
		};
		const level = opts.sfx;
		for (const b of beats) {
			if (b.type === 'big') {
				add('slam', Math.max(0, b.start - 0.2));
				add('impact', b.start + 0.05, level === 'restrained' ? 0.8 : 1);
			} else if (b.type === 'title') add('whoosh', 0.05);
			else if ((b.type === 'emoji' || b.type === 'pill') && level !== 'restrained') add('pop', b.start);
			else if (b.type === 'endcard') {
				add('riser', Math.max(0, b.start - 1.1));
				add('ding', b.start + 0.1);
			}
		}
		if (opts.transition !== 'cut') for (const t of clipChanges) add(opts.transition === 'dip' ? 'riser' : 'whoosh', Math.max(0, t - 0.25), opts.transition === 'whoosh' ? 1 : 0.6);
		if (level === 'rich') {
			snaps.filter((s, k) => k > 0 && k % 3 === 0).forEach((s) => add('whoosh', Math.max(0, s[0] - 0.12), 0.6));
			const firstEmoji = beats.find((b) => b.type === 'emoji');
			if (firstEmoji) add('meme', firstEmoji.start + 0.15);
		}
	}

	// ---- music ----------------------------------------------------------------------
	let music: EditPlan['music'] = null;
	if (opts.music && ctx.music.length) {
		let m = opts.music !== 'auto' ? ctx.music.find((x) => x.id === opts.music) : undefined;
		if (!m) {
			const scored = ctx.music
				.map((x) => ({x, s: x.mood.filter((md) => style.musicMood.includes(md)).length + (x.styles.includes(style.id) ? 2 : 0)}))
				.sort((a, b) => b.s - a.s);
			const top = scored.filter((s) => s.s === scored[0].s);
			m = top[(ctx.seed ?? 0) % top.length].x;
		}
		const duck = Math.min(0.5, Math.pow(10, (-16 - 21 - (m.lufs_i ?? -12)) / 20));
		const speech: [number, number][] = [];
		for (const w of [...allWords].sort((a, b) => a.start - b.start)) {
			const last = speech[speech.length - 1];
			if (last && w.start - last[1] < 0.6) last[1] = Math.max(last[1], w.end);
			else speech.push([w.start, w.end]);
		}
		music = {src: m.url, volume: Math.min(0.7, duck * 2), duckVolume: duck, speech};
	}

	return {
		version: 1,
		...planBase,
		durationInFrames: Math.max(1, frame),
		src: firstClip.url,
		captions: {enabled: opts.captions, look, groups},
		beats,
		sfx: sfx.sort((a, b) => a.at - b.at),
		music,
		look: {
			...style.look,
			vignette: Math.max(style.look.vignette || 0, (globalAdj.vignette / 100) * 0.85) || undefined,
			grain: Math.max(style.look.grain || 0, (globalAdj.grain / 100) * 0.16) || undefined,
		},
		grades,
		brand: {accent, ink: style.ink, font: style.caption.font},
		progressBar: {enabled: opts.progressBar, color: accent},
		safe,
	};
};

/** the auto edit (an EditPlan from the planner) -> an editable timeline */
export const planToTimeline = (plan: EditPlan, clipIds: string[], opts: Pick<JobOptions, 'cta'>): Timeline => {
	const fps = plan.fps;
	const segs = plan.segments.filter((s) => !s.freeze);
	const lay = segs.map((s) => ({s, start: s.from / fps, end: (s.from + s.dur) / fps, a: s.trimBefore / fps, clip: clipIds[s.clip ?? 0]}));
	const toSrc = (t: number) => {
		const k = lay.find((x) => t >= x.start - 1e-6 && t < x.end) || lay[lay.length - 1];
		return {clip: k.clip, t: k.a + (t - k.start)};
	};
	const captions: TlCaption[] = plan.captions.groups.map((g) => {
		const first = toSrc(g.words[0].start);
		return {
			id: tlId(),
			clip: first.clip,
			words: g.words.map((w) => {
				const s = toSrc(w.start);
				return {text: w.text, a: +s.t.toFixed(3), b: +(s.t + (w.end - w.start)).toFixed(3), keyword: w.keyword};
			}),
		};
	});
	const beats: TlBeat[] = [];
	let title: Timeline['title'] = null;
	for (const b of plan.beats) {
		if (b.type === 'title') title = {text: b.text || '', dur: +(b.end - b.start).toFixed(2)};
		if (b.type !== 'big' && b.type !== 'emoji' && b.type !== 'pill') continue;
		const s = toSrc(b.start);
		beats.push({id: tlId(), type: b.type, clip: s.clip, a: +s.t.toFixed(3), dur: +(b.end - b.start).toFixed(2), text: b.text, sub: b.sub, emoji: b.emoji, count: b.count});
	}
	return {
		version: 1,
		segments: lay.map((x) => ({id: tlId(), clip: x.clip, a: +x.a.toFixed(3), b: +(x.a + x.s.dur / fps).toFixed(3)})),
		captions,
		beats,
		title,
		cta: opts.cta ? {text: opts.cta, dur: 2.6} : null,
	};
};

export const timelineToSrt = (plan: EditPlan) => {
	const ts = (t: number) => {
		const ms = Math.max(0, Math.round(t * 1000));
		const p = (n: number, l = 2) => String(n).padStart(l, '0');
		return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
	};
	return plan.captions.groups.map((g, k) => `${k + 1}\n${ts(g.start)} --> ${ts(g.end)}\n${g.words.map((w) => w.text).join(' ')}\n`).join('\n');
};
