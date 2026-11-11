// Color grading (CapCut-style "Adjust" + filters), pure so both the server render and the browser preview use it.
// Every adjustment is a number in -100..100 (0 = untouched). A grade compiles to an SVG filter:
//   per-channel tone curve (levels, exposure, brightness, contrast, shadows, highlights, fade, white balance)
//   -> saturation -> hue rotation.

export type ColorAdjust = {
	exposure: number;
	brightness: number;
	contrast: number;
	saturation: number;
	temperature: number; // + warm / - cool
	tint: number; // + magenta / - green
	highlights: number;
	shadows: number;
	hue: number;
	fade: number; // 0..100
	vignette: number; // 0..100 (whole video)
	grain: number; // 0..100 (whole video)
	/** internal (auto): input black / white points 0..1 */
	black?: number;
	white?: number;
};

export type ColorSettings = ColorAdjust & {
	auto: boolean; // automatic per-clip correction
	autoStrength: number; // 0..100
	filter: string; // preset id ('' = none)
	filterAmount: number; // 0..100
};

export const ADJUST_KEYS = ['exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows', 'hue', 'fade', 'vignette', 'grain'] as const;
export type AdjustKey = (typeof ADJUST_KEYS)[number];

export const ZERO_ADJUST: ColorAdjust = {exposure: 0, brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, hue: 0, fade: 0, vignette: 0, grain: 0};

export const DEFAULT_COLOR: ColorSettings = {...ZERO_ADJUST, auto: true, autoStrength: 80, filter: '', filterAmount: 100};

/** CapCut-like filter presets */
export const COLOR_FILTERS: {id: string; name: string; adj: Partial<ColorAdjust>}[] = [
	{id: 'natural', name: 'Tự nhiên', adj: {contrast: 8, saturation: 10, highlights: -10, shadows: 8}},
	{id: 'vivid', name: 'Rực rỡ', adj: {contrast: 15, saturation: 35, brightness: 4}},
	{id: 'warm', name: 'Nắng ấm', adj: {temperature: 30, saturation: 12, highlights: -8, brightness: 5}},
	{id: 'cool', name: 'Lạnh', adj: {temperature: -30, tint: -5, saturation: -5, contrast: 6}},
	{id: 'teal-orange', name: 'Teal & Orange', adj: {temperature: 14, tint: -8, contrast: 20, saturation: 18, shadows: -10, hue: -6}},
	{id: 'cinematic', name: 'Điện ảnh', adj: {contrast: 22, saturation: -18, fade: 12, temperature: -6, highlights: -20, vignette: 45}},
	{id: 'film', name: 'Film cũ', adj: {fade: 28, saturation: -22, temperature: 18, contrast: -6, grain: 35, vignette: 30}},
	{id: 'moody', name: 'Trầm', adj: {exposure: -12, contrast: 18, saturation: -28, shadows: -15, temperature: -8, vignette: 40}},
	{id: 'fresh', name: 'Trong trẻo', adj: {brightness: 14, shadows: 18, highlights: -12, saturation: 12, temperature: -6, contrast: -4}},
	{id: 'food', name: 'Đồ ăn', adj: {temperature: 16, saturation: 30, contrast: 12, brightness: 6}},
	{id: 'green', name: 'Cỏ xanh', adj: {saturation: 22, tint: -10, contrast: 12, hue: 4}},
	{id: 'bw', name: 'Đen trắng', adj: {saturation: -100, contrast: 25, vignette: 25}},
];

/** the final adjustment of one clip: auto (scaled) + filter (scaled) + manual + per-segment override */
export const combineAdjust = (settings: Partial<ColorSettings> | undefined, auto?: Partial<ColorAdjust> | null, override?: Partial<ColorAdjust> | null): ColorAdjust => {
	const s = {...DEFAULT_COLOR, ...(settings || {})};
	const out: ColorAdjust = {...ZERO_ADJUST};
	const add = (a: Partial<ColorAdjust> | null | undefined, k = 1) => {
		if (!a) return;
		for (const key of ADJUST_KEYS) out[key] += (a[key] || 0) * k;
	};
	if (s.auto && auto) {
		const k = s.autoStrength / 100;
		add(auto, k);
		if (auto.black !== undefined) out.black = auto.black * k;
		if (auto.white !== undefined) out.white = 1 - (1 - auto.white) * k;
	}
	const f = COLOR_FILTERS.find((x) => x.id === s.filter);
	if (f) add(f.adj, s.filterAmount / 100);
	add(s);
	add(override);
	for (const key of ADJUST_KEYS) out[key] = Math.max(key === 'hue' ? -100 : -100, Math.min(100, out[key]));
	out.fade = Math.max(0, out.fade);
	out.vignette = Math.max(0, out.vignette);
	out.grain = Math.max(0, out.grain);
	return out;
};

export const isNeutral = (a: ColorAdjust) => ADJUST_KEYS.every((k) => k === 'vignette' || k === 'grain' || Math.abs(a[k]) < 0.5) && !a.black && (a.white === undefined || a.white > 0.995);

/** SVG filter description of a grade */
export type Grade = {r: string; g: string; b: string; saturate: number; hue: number};

const N = 33;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const gradeOf = (a: ColorAdjust): Grade | null => {
	if (isNeutral(a)) return null;
	const black = a.black || 0;
	const white = a.white ?? 1;
	const expo = Math.pow(2, a.exposure / 100);
	const gamma = Math.pow(2, (-a.brightness / 100) * 0.8);
	const k = a.contrast >= 0 ? 1 + (a.contrast / 100) * 0.7 : 1 + (a.contrast / 100) * 0.5;
	const T = a.temperature / 100;
	const Ti = a.tint / 100;
	const gains = [1 + T * 0.12 + Ti * 0.05, 1 + T * 0.02 - Ti * 0.1, 1 - T * 0.14 + Ti * 0.05];
	const tone = (x0: number) => {
		let x = clamp01((x0 - black) / Math.max(0.05, white - black));
		x = clamp01(x * expo);
		x = Math.pow(x, gamma);
		// smooth contrast: blend a linear stretch with a sigmoid so ends roll off instead of clipping
		const lin = 0.5 + (x - 0.5) * k;
		const sig = 1 / (1 + Math.exp(-(x - 0.5) * 4 * k)) ;
		const s0 = 1 / (1 + Math.exp(2 * k));
		const s1 = 1 / (1 + Math.exp(-2 * k));
		x = clamp01(0.5 * lin + 0.5 * ((sig - s0) / (s1 - s0)));
		const ws = Math.pow(Math.max(0, 1 - x / 0.6), 2);
		x += (a.shadows / 100) * 0.22 * ws;
		const wh = Math.pow(Math.max(0, (x - 0.4) / 0.6), 2);
		x += (a.highlights / 100) * 0.22 * wh;
		const f = a.fade / 100;
		x = x * (1 - f * 0.22) + f * 0.12;
		return clamp01(x);
	};
	const base: number[] = [];
	for (let i = 0; i < N; i++) base.push(tone(i / (N - 1)));
	const ch = (g: number) => base.map((v) => clamp01(v * g).toFixed(4)).join(' ');
	return {r: ch(gains[0]), g: ch(gains[1]), b: ch(gains[2]), saturate: Math.max(0, 1 + a.saturation / 100), hue: a.hue * 0.6};
};

export type FrameStats = {mean: number; p1: number; p99: number; r: number; g: number; b: number; neutral: number; sat: number; clipHi: number; clipLo: number};

/** pixel statistics of a few RGB frames (rgb24 bytes) */
export const statsOf = (frames: Uint8Array[]): FrameStats | null => {
	const hist = new Array(256).fill(0);
	let n = 0;
	let sumL = 0;
	let mr = 0;
	let mg = 0;
	let mb = 0;
	let mn = 0;
	let sumS = 0;
	let hi = 0;
	let lo = 0;
	for (const fr of frames) {
		for (let i = 0; i + 2 < fr.length; i += 3) {
			const r = fr[i] / 255;
			const g = fr[i + 1] / 255;
			const b = fr[i + 2] / 255;
			const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			hist[Math.min(255, Math.round(l * 255))]++;
			sumL += l;
			n++;
			const mx = Math.max(r, g, b);
			const mi = Math.min(r, g, b);
			sumS += mx > 0 ? (mx - mi) / mx : 0;
			if (l > 0.97) hi++;
			if (l < 0.05) lo++;
			// near-neutral pixels (walls, clothes, asphalt) carry the white balance; grass / sky / skin would bias it
			if (l > 0.2 && l < 0.9 && mx > 0 && (mx - mi) / mx < 0.22) {
				mr += r;
				mg += g;
				mb += b;
				mn++;
			}
		}
	}
	if (!n) return null;
	const pct = (p: number) => {
		let acc = 0;
		for (let i = 0; i < 256; i++) {
			acc += hist[i];
			if (acc >= n * p) return i / 255;
		}
		return 1;
	};
	return {mean: sumL / n, p1: pct(0.01), p99: pct(0.99), r: mn ? mr / mn : 0.5, g: mn ? mg / mn : 0.5, b: mn ? mb / mn : 0.5, neutral: mn / n, sat: sumS / n, clipHi: hi / n, clipLo: lo / n};
};

/** automatic correction: gentle levels, exposure only when clearly too dark / bright, white balance from neutral pixels, saturation */
export const autoAdjust = (s: FrameStats): Partial<ColorAdjust> => {
	const out: Partial<ColorAdjust> = {};
	const black = s.p1 > 0.035 ? Math.min(0.06, s.p1 - 0.02) : 0;
	const white = s.p99 < 0.93 ? Math.max(0.88, s.p99 + 0.02) : 1;
	if (black > 0.005) out.black = +black.toFixed(3);
	if (white < 0.995) out.white = +white.toFixed(3);
	const m = clamp01((s.mean - black) / (white - black));
	// only correct exposure outside a comfortable band
	const target = m < 0.36 ? 0.42 : m > 0.64 ? 0.58 : m;
	if (target !== m && m > 0.02 && m < 0.98) {
		const ratio = Math.log(target) / Math.log(m);
		out.brightness = Math.max(-25, Math.min(30, (-100 / 0.8) * Math.log2(ratio)));
	}
	if (s.neutral > 0.03) {
		const T = (s.b - s.r) / Math.max(0.05, 0.12 * s.r + 0.14 * s.b);
		out.temperature = Math.max(-25, Math.min(25, T * 100 * 0.5));
		const rb = (s.r + s.b) / 2;
		const t = (s.g - rb) / Math.max(0.05, 0.1 * s.g + 0.05 * rb);
		out.tint = Math.max(-15, Math.min(15, t * 100 * 0.4));
	}
	out.saturation = Math.max(-15, Math.min(18, (0.3 / Math.max(0.05, s.sat) - 1) * 100 * 0.35));
	out.contrast = s.p99 - s.p1 < 0.6 ? 12 : 5;
	if (s.clipHi > 0.04) out.highlights = -Math.min(30, s.clipHi * 300);
	if (s.clipLo > 0.12 || m < 0.3) out.shadows = Math.min(25, 8 + s.clipLo * 60);
	for (const key of Object.keys(out) as (keyof ColorAdjust)[]) out[key] = Math.round((out[key] as number) * 1000) / 1000;
	return out;
};
