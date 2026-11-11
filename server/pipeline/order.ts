// Multi-clip projects: decide which clip comes first.
//  time   : the recording time in the file's metadata (QuickTime creationdate / creation_time),
//           else the file's modified time from the browser, else the file name
//  name   : natural file-name order (IMG_2 before IMG_10)
//  manual : the order dragged in the UI
//  auto   : recording time, then the content decides: a clip that opens with a greeting / intro goes first,
//           one that closes with a call to action / goodbye goes last; with a Gemini key the AI reads every
//           clip's transcript and orders them as a story.
import type {ClipOrderMode, Word} from '../../shared/types.js';
import {GEMINI_MODEL} from '../config.js';

export type ClipInfo = {
	id: string;
	name: string;
	duration: number;
	recordedAt: number | null;
	fileModified: number | null;
	words: Word[];
};

export type OrderResult = {order: string[]; reasons: Record<string, string>; method: string};

const INTRO = [
	'xin chào', 'chào các bạn', 'chào mọi người', 'chào cả nhà', 'hôm nay', 'trong video này', 'mình là', 'tôi là', 'bắt đầu',
	'hello', 'hi guys', 'hey guys', 'hey everyone', 'welcome', 'today i', "today we", 'in this video', 'my name is', "let's start",
];
const OUTRO = [
	'cảm ơn', 'hẹn gặp lại', 'tạm biệt', 'theo dõi', 'đăng ký', 'follow', 'like và share', 'bấm like', 'link ở', 'link dưới', 'phần sau', 'tập sau',
	'subscribe', 'thanks for watching', 'thank you for watching', 'see you', 'bye', 'link below', 'link in bio', 'next video', 'part two', 'part 2',
];

const textOf = (ws: Word[]) => ` ${ws.map((w) => w.text.toLowerCase()).join(' ')} `;
const has = (t: string, list: string[]) => list.find((p) => t.includes(` ${p}`));

const fmtTime = (t: number) => new Date(t).toLocaleString('vi-VN', {hour12: false});

export const timeOrder = (clips: ClipInfo[]) => {
	const key = (c: ClipInfo) => c.recordedAt ?? c.fileModified ?? Infinity;
	return [...clips].sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}));
};

const timeReason = (c: ClipInfo) =>
	c.recordedAt ? `quay lúc ${fmtTime(c.recordedAt)}` : c.fileModified ? `file sửa lúc ${fmtTime(c.fileModified)} (không có giờ quay)` : 'theo tên file';

export const orderClips = async (
	clips: ClipInfo[],
	mode: ClipOrderMode,
	manual: string[],
	ai?: {key: string; language: string; brief?: string} | null,
	log?: (s: string) => void,
): Promise<OrderResult> => {
	if (clips.length <= 1) return {order: clips.map((c) => c.id), reasons: Object.fromEntries(clips.map((c) => [c.id, 'clip duy nhất'])), method: 'single'};
	const reasons: Record<string, string> = {};

	if (mode === 'name') {
		const o = [...clips].sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}));
		o.forEach((c) => (reasons[c.id] = 'theo tên file'));
		return {order: o.map((c) => c.id), reasons, method: 'tên file'};
	}
	if (mode === 'manual') {
		const known = new Set(clips.map((c) => c.id));
		const first = manual.filter((id) => known.has(id));
		const rest = timeOrder(clips.filter((c) => !first.includes(c.id))).map((c) => c.id);
		first.forEach((id) => (reasons[id] = 'thứ tự bạn sắp xếp'));
		rest.forEach((id) => (reasons[id] = 'thêm sau, theo giờ quay'));
		return {order: [...first, ...rest], reasons, method: 'thủ công'};
	}

	const byTime = timeOrder(clips);
	byTime.forEach((c) => (reasons[c.id] = timeReason(c)));
	if (mode === 'time') return {order: byTime.map((c) => c.id), reasons, method: 'thời gian quay'};

	// auto: AI story order
	if (ai?.key && clips.some((c) => c.words.length)) {
		try {
			const r = await geminiOrder(ai.key, byTime, ai.language, ai.brief || '');
			if (r) {
				for (const [id, why] of Object.entries(r.reasons)) reasons[id] = `AI: ${why}`;
				return {order: r.order, reasons, method: 'AI theo nội dung'};
			}
		} catch (e) {
			log?.(`AI sắp xếp lỗi, dùng thuật toán: ${(e as Error).message.slice(0, 120)}`);
		}
	}

	// auto: heuristic — intro clips first, outro clips last, the rest by recording time
	const intro: ClipInfo[] = [];
	const outro: ClipInfo[] = [];
	const middle: ClipInfo[] = [];
	for (const c of byTime) {
		const head = textOf(c.words.slice(0, 10));
		const tail = textOf(c.words.slice(-14));
		const i = has(head, INTRO);
		const o = has(tail, OUTRO);
		if (i && !o) {
			intro.push(c);
			reasons[c.id] = `mở đầu (“${i.trim()}”) · ${timeReason(c)}`;
		} else if (o && !i) {
			outro.push(c);
			reasons[c.id] = `kết thúc (“${o.trim()}”) · ${timeReason(c)}`;
		} else middle.push(c);
	}
	return {order: [...intro, ...middle, ...outro].map((c) => c.id), reasons, method: 'tự động (giờ quay + nội dung)'};
};

const geminiOrder = async (key: string, clips: ClipInfo[], language: string, brief: string): Promise<{order: string[]; reasons: Record<string, string>} | null> => {
	const lines = clips.map((c, k) => {
		const words = c.words.map((w) => w.text);
		const text = words.length > 140 ? `${words.slice(0, 90).join(' ')} … ${words.slice(-40).join(' ')}` : words.join(' ');
		return `C${k} | file "${c.name}" | ${c.duration.toFixed(1)}s | recorded ${c.recordedAt ? new Date(c.recordedAt).toISOString() : 'unknown'} | ${text || '(no speech: B-roll)'}`;
	});
	const prompt = `You are a video editor. These clips belong to ONE short video. Order them so the story flows: hook / intro first,
then the body in logical order, call to action / goodbye last. Recording time is a strong hint (people usually record in order)
unless the content clearly says otherwise.${brief ? ` The creator's brief for the video: """${brief.slice(0, 1000)}"""` : ''} B-roll clips (no speech) go next to the clip they illustrate.
Return ONLY JSON: {"order": ["C2","C0",...every clip exactly once], "reasons": {"C2": "short reason in ${language === 'en' ? 'English' : 'Vietnamese'}", ...}}

CLIPS:
${lines.join('\n')}`;
	const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
		body: JSON.stringify({contents: [{role: 'user', parts: [{text: prompt}]}], generationConfig: {responseMimeType: 'application/json', temperature: 0.2}}),
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) throw new Error(`Gemini ${res.status}`);
	const j: any = await res.json();
	const parsed = JSON.parse(j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '{}');
	const idx = (Array.isArray(parsed.order) ? parsed.order : []).map((x: string) => Number(String(x).replace(/\D/g, '')));
	if (idx.length !== clips.length || new Set(idx).size !== clips.length || idx.some((i: number) => !(i >= 0 && i < clips.length))) return null;
	const reasons: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed.reasons || {})) {
		const i = Number(String(k).replace(/\D/g, ''));
		if (clips[i]) reasons[clips[i].id] = String(v).slice(0, 120);
	}
	return {order: idx.map((i: number) => clips[i].id), reasons};
};
