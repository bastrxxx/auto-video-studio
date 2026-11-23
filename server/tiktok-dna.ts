// TikTok Channel DNA Learner:
// Takes 1 or multiple TikTok channel URLs (and/or local reference MP4s),
// extracts channel metadata + video pacing/scene cuts (via yt-dlp / web / FFmpeg),
// then synthesizes the complete Editing DNA via AGY CLI so the auto-editor can replicate it.
import {execFile} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import type {CaptionStyleId, ClipTransition, TikTokChannelDNA} from '../shared/types.js';
import {findAgyBinary, getAgyConfig, runAgyPrompt} from './agy-cli.js';
import {dbDeleteAppRecord, dbGetAppRecord, dbListAppRecords, dbPutAppRecord} from './db.js';
import {probe, run as runFf} from './ff.js';

const execFileAsync = promisify(execFile);

const APP_NS = 'video-studio';
const DNA_COL = 'tiktok_dna';

export type RawChannelVideo = {
	id: string;
	handle: string;
	url: string;
	title: string;
	duration: number;
	views?: number;
	likes?: number;
	comments?: number;
	sceneCuts?: number;
	hook3sCuts?: number;
	avgShotSec?: number;
};

export function normalizeTikTokUrl(raw: string): {url: string; handle: string} | null {
	const s = raw.trim();
	if (!s) return null;
	if (/^@[a-zA-Z0-9._-]+$/.test(s)) {
		return {url: `https://www.tiktok.com/${s}`, handle: s};
	}
	try {
		const u = new URL(s.startsWith('http') ? s : `https://${s}`);
		const m = u.pathname.match(/\/(@[a-zA-Z0-9._-]+)/);
		const handle = m ? m[1] : `@${u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || 'tiktok_channel'}`;
		return {url: u.toString(), handle};
	} catch {
		const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, '');
		if (!cleaned) return null;
		return {url: `https://www.tiktok.com/@${cleaned}`, handle: `@${cleaned}`};
	}
}

async function findYtDlp(): Promise<string | null> {
	const candidates = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', path.join(os.homedir(), '.local', 'bin', 'yt-dlp')];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	try {
		const {stdout} = await execFileAsync('which', ['yt-dlp'], {timeout: 2500});
		if (stdout.trim()) return stdout.trim();
	} catch {}
	return null;
}

/** Measure exact scene cuts, hook 3s cuts, and average shot length using Remotion's bundled FFmpeg */
export async function analyzeVideoPacing(filePath: string): Promise<{
	duration: number;
	sceneCuts: number;
	hook3sCuts: number;
	avgShotSec: number;
	cutTimestamps: number[];
}> {
	const info = await probe(filePath);
	const dur = Math.max(0.5, info.duration || 1);
	let cutTimestamps: number[] = [];
	try {
		// Detect scene changes > 0.30 threshold via showinfo filter
		const {stderr} = await runFf('ffmpeg', [
			'-i',
			filePath,
			'-vf',
			"select='gt(scene,0.30)',showinfo",
			'-vsync',
			'vfr',
			'-f',
			'null',
			'-',
		]);
		const re = /pts_time:(\d+(?:\.\d+)?)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(stderr))) {
			const t = Number(m[1]);
			if (Number.isFinite(t) && (cutTimestamps.length === 0 || t - cutTimestamps[cutTimestamps.length - 1] > 0.25)) {
				cutTimestamps.push(Number(t.toFixed(2)));
			}
		}
	} catch {
		cutTimestamps = [];
	}
	const sceneCuts = cutTimestamps.length;
	const hook3sCuts = cutTimestamps.filter((t) => t <= 3.0).length;
	const avgShotSec = Number((dur / Math.max(1, sceneCuts + 1)).toFixed(2));
	return {duration: Number(dur.toFixed(2)), sceneCuts, hook3sCuts, avgShotSec, cutTimestamps};
}

/** Fetch channel videos via yt-dlp if installed */
async function fetchViaYtDlp(ytDlp: string, url: string, handle: string, maxVideos: number): Promise<RawChannelVideo[]> {
	try {
		const {stdout} = await execFileAsync(
			ytDlp,
			['--flat-playlist', '--dump-json', '--no-warnings', '--playlist-end', String(maxVideos), url],
			{timeout: 35_000, maxBuffer: 15 * 1024 * 1024},
		);
		const out: RawChannelVideo[] = [];
		for (const line of stdout.split('\n')) {
			const t = line.trim();
			if (!t.startsWith('{')) continue;
			try {
				const j = JSON.parse(t);
				out.push({
					id: String(j.id || crypto.randomUUID()),
					handle,
					url: String(j.webpage_url || j.url || url),
					title: String(j.title || j.description || '').slice(0, 260),
					duration: Number(j.duration || 0),
					views: Number(j.view_count || 0) || undefined,
					likes: Number(j.like_count || 0) || undefined,
					comments: Number(j.comment_count || 0) || undefined,
				});
			} catch {}
		}
		return out;
	} catch {
		return [];
	}
}

/** Lightweight HTML scrape fallback for public TikTok channel pages */
async function fetchViaWeb(url: string, handle: string, maxVideos: number): Promise<{videos: RawChannelVideo[]; bio: string}> {
	const videos: RawChannelVideo[] = [];
	let bio = '';
	try {
		const res = await fetch(url, {
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
				'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
			},
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return {videos, bio};
		const html = await res.text();
		const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
		if (m) {
			const data = JSON.parse(m[1]);
			const scope = data?.['__DEFAULT_SCOPE__'] || {};
			const userDetail = scope['webapp.user-detail']?.userInfo;
			if (userDetail?.user?.signature) bio = String(userDetail.user.signature).slice(0, 300);
			const itemList = scope['webapp.user-detail']?.itemList || [];
			for (const item of itemList.slice(0, maxVideos)) {
				videos.push({
					id: String(item.id || crypto.randomUUID()),
					handle,
					url: `https://www.tiktok.com/${handle}/video/${item.id}`,
					title: String(item.desc || '').slice(0, 260),
					duration: Number(item.video?.duration || 0),
					views: Number(item.stats?.playCount || 0) || undefined,
					likes: Number(item.stats?.diggCount || 0) || undefined,
					comments: Number(item.stats?.commentCount || 0) || undefined,
				});
			}
		}
	} catch {}
	return {videos, bio};
}

/** Optional: download top N videos via yt-dlp and measure real FFmpeg scene cuts */
async function sampleTopVideosPacing(ytDlp: string, videos: RawChannelVideo[], maxDownload = 2): Promise<void> {
	const sorted = [...videos]
		.filter((v) => v.url && v.duration > 0 && v.duration <= 90)
		.sort((a, b) => (b.views || b.likes || 0) - (a.views || a.likes || 0))
		.slice(0, maxDownload);
	if (!sorted.length) return;

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avs-tiktok-dna-'));
	try {
		for (const v of sorted) {
			const outFile = path.join(tmpDir, `${v.id.replace(/[^a-zA-Z0-9_-]/g, '')}.mp4`);
			try {
				await execFileAsync(
					ytDlp,
					['-f', 'mp4/best[height<=720]/best', '--no-warnings', '--max-filesize', '25M', '-o', outFile, v.url],
					{timeout: 35_000},
				);
				if (fs.existsSync(outFile)) {
					const pacing = await analyzeVideoPacing(outFile);
					v.duration = pacing.duration || v.duration;
					v.sceneCuts = pacing.sceneCuts;
					v.hook3sCuts = pacing.hook3sCuts;
					v.avgShotSec = pacing.avgShotSec;
				}
			} catch {}
		}
	} finally {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	}
}

const VALID_STYLES = new Set<CaptionStyleId>(['clean', 'hormozi', 'meme', 'editorial', 'cinematic', 'news', 'pop', 'minimal']);
const VALID_TRANSITIONS = new Set<ClipTransition>(['cut', 'flash', 'dip', 'whoosh']);

function fallbackDna(
	name: string,
	channels: {url: string; handle: string; videoCount: number; sampledVideos: number}[],
	videos: RawChannelVideo[],
	niche: string,
	modelUsed: string,
): TikTokChannelDNA {
	const durs = videos.map((v) => v.duration).filter((d) => d > 0);
	const avgDur = durs.length ? Number((durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(1)) : 25;
	const shots = videos.map((v) => v.avgShotSec || 0).filter((s) => s > 0);
	const avgShot = shots.length ? Number((shots.reduce((a, b) => a + b, 0) / shots.length).toFixed(2)) : 1.6;
	const cutsPer10 = Number((10 / Math.max(0.5, avgShot)).toFixed(1));

	return {
		id: `dna_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
		name,
		channels,
		learnedAt: Date.now(),
		modelUsed,
		niche,
		summary: `DNA dựng video thời trang 20–30s tối ưu từ ${channels.map((c) => c.handle).join(', ')}. Nhịp cắt nhanh (~${avgShot}s/shot), mở đầu hook 3s mạnh bằng outfit reveal + chữ nổi, kết thúc bằng CTA gọn.`,
		metrics: {
			avgDurationSec: avgDur,
			targetRangeSec: [20, 30],
			avgShotLengthSec: avgShot,
			cutsPer10Sec: cutsPer10,
			hookWindowSec: 3.0,
			wordsPerSec: 3.1,
			musicEnergy: 'high',
		},
		hook3sFormula: {
			pattern: 'Visual Shock + Outfit Reveal + Câu hỏi/Con số gây tò mò trong 0-3s đầu',
			visualPattern: 'Cắt nhanh 2-3 góc (toàn thân → cận chất vải → xoay người) kèm snap zoom 1.12x',
			textStyle: 'Tiêu đề 4-6 chữ in đậm tương phản cao đặt trên vùng an toàn TikTok',
			audioImpact: 'Whoosh/Impact ngay frame 0 + câu mở đầu năng lượng cao, không khoảng lặng',
			examples: [
				'3 cách phối chiếc áo này nhìn sang gấp đôi!',
				'Đừng mua đồ basic nếu chưa biết mẹo phối này…',
				'Outfit 25 giây đi làm lẫn đi chơi đều nổi bật!',
			],
		},
		pacingCurve: {
			intro0to3s: '0–3s: Cắt siêu nhanh (0.8–1.2s/shot), chốt hook thị giác + text hook + SFX impact',
			body3to20s: '3–22s: Nhịp đều 1.4–2.0s/shot, xen kẽ toàn thân – cận chất liệu – chi tiết form dáng',
			outro20to30s: '22–28s: Tổng kết 1 góc đẹp nhất + Endcard CTA lưu/comment nhận link',
		},
		shotGrammar: [
			'0.0–1.5s: Outfit reveal toàn thân + flash cut + hook text',
			'1.5–3.0s: Cận cảnh chi tiết đắt giá (cổ áo, chất vải, phụ kiện)',
			'3.0–10.0s: Trình diễn form dáng khi di chuyển / xoay người theo nhịp beat',
			'10.0–18.0s: Biến thể phối đồ / so sánh trước-sau / highlight ưu điểm che khuyết điểm',
			'18.0–25.0s: Góc lifestyle tự nhiên + lời khuyên chọn size/màu',
			'25.0–28.0s: Freeze frame đẹp nhất + CTA kêu gọi bình luận/lưu video',
		],
		editingPreset: {
			style: 'editorial',
			pace: 'fast',
			transition: 'flash',
			zoom: 1.2,
			sfx: 'standard',
			wordsPerGroup: 3,
			maxDuration: 28,
			accent: '#FF4D8D',
			colorMood: 'Trong trẻo + ấm nhẹ tôn da & màu vải',
		},
		viralRules: [
			'Không bao giờ có khoảng lặng > 0.25s ở 3 giây đầu',
			'Mỗi 1.5–2.2 giây đổi góc máy hoặc snap zoom để giữ retention > 65%',
			'Luôn đặt phụ đề trong vùng an toàn TikTok (tránh che outfit chính & tránh thanh UI dưới)',
			'Giữ tổng thời lượng 22–28 giây để tối ưu tỷ lệ xem hết (completion rate) và replay',
		],
		avoidRules: [
			'Tránh mở đầu chào hỏi dài dòng (“Xin chào mọi người hôm nay mình sẽ…”)',
			'Tránh giữ 1 góc máy tĩnh quá 3.5 giây không có chuyển động hoặc zoom',
			'Tránh chữ quá nhỏ hoặc đè lên phần cổ/mặt/chi tiết trang phục',
		],
		rawVideos: videos.slice(0, 15),
	};
}

export async function learnTikTokChannelsDNA(args: {
	urls: string[];
	name?: string;
	niche?: string;
	notes?: string;
	model?: string;
	maxVideosPerChannel?: number;
	localReferenceFiles?: {path: string; name: string}[];
}): Promise<TikTokChannelDNA> {
	const normalized = args.urls.map(normalizeTikTokUrl).filter(Boolean) as {url: string; handle: string}[];
	if (!normalized.length && !(args.localReferenceFiles?.length)) {
		throw new Error('Vui lòng nhập ít nhất 1 link kênh TikTok (hoặc tải lên video mẫu).');
	}

	const niche = (args.niche || 'Thời trang 20-30s (Fashion Lookbook / Styling / Review)').trim();
	const maxPerChannel = Math.min(20, Math.max(3, args.maxVideosPerChannel || 12));
	const ytDlp = await findYtDlp();

	const allVideos: RawChannelVideo[] = [];
	const channelSummaries: {url: string; handle: string; videoCount: number; sampledVideos: number}[] = [];
	const bios: string[] = [];

	for (const ch of normalized) {
		let vids: RawChannelVideo[] = [];
		if (ytDlp) {
			vids = await fetchViaYtDlp(ytDlp, ch.url, ch.handle, maxPerChannel);
		}
		if (!vids.length) {
			const web = await fetchViaWeb(ch.url, ch.handle, maxPerChannel);
			vids = web.videos;
			if (web.bio) bios.push(`${ch.handle}: ${web.bio}`);
		}
		if (ytDlp && vids.length) {
			await sampleTopVideosPacing(ytDlp, vids, 2);
		}
		const sampled = vids.filter((v) => v.sceneCuts !== undefined).length;
		channelSummaries.push({
			url: ch.url,
			handle: ch.handle,
			videoCount: vids.length,
			sampledVideos: sampled,
		});
		allVideos.push(...vids);
	}

	// Analyze any uploaded local reference MP4s directly with FFmpeg!
	if (args.localReferenceFiles?.length) {
		for (const rf of args.localReferenceFiles) {
			try {
				const pacing = await analyzeVideoPacing(rf.path);
				allVideos.push({
					id: `local_${crypto.randomBytes(3).toString('hex')}`,
					handle: '@local_reference',
					url: rf.name,
					title: rf.name,
					duration: pacing.duration,
					sceneCuts: pacing.sceneCuts,
					hook3sCuts: pacing.hook3sCuts,
					avgShotSec: pacing.avgShotSec,
				});
			} catch {}
		}
		channelSummaries.push({
			url: 'local://uploads',
			handle: '@video_mẫu_tải_lên',
			videoCount: args.localReferenceFiles.length,
			sampledVideos: args.localReferenceFiles.length,
		});
	}

	const profileName =
		(args.name || '').trim() ||
		(channelSummaries.length === 1
			? `DNA ${channelSummaries[0].handle}`
			: `Master DNA (${channelSummaries.map((c) => c.handle).slice(0, 3).join(' + ')})`);

	const agyCfg = getAgyConfig();
	const chosenModel = (args.model || agyCfg.customModel || agyCfg.model || 'gemini-4-neon-high').trim();
	const agyBin = await findAgyBinary(agyCfg.customPath);

	if (!agyBin) {
		const fb = fallbackDna(profileName, channelSummaries, allVideos, niche, 'heuristic-local');
		dbPutAppRecord(APP_NS, DNA_COL, fb.id, fb);
		return fb;
	}

	const videoDigest = allVideos.slice(0, 20).map((v, idx) => {
		const parts = [
			`#${idx + 1} [${v.handle}]`,
			v.duration ? `dur=${v.duration}s` : '',
			v.views ? `views=${v.views}` : '',
			v.likes ? `likes=${v.likes}` : '',
			v.sceneCuts !== undefined ? `sceneCuts=${v.sceneCuts}` : '',
			v.hook3sCuts !== undefined ? `hook3sCuts=${v.hook3sCuts}` : '',
			v.avgShotSec !== undefined ? `avgShot=${v.avgShotSec}s` : '',
			v.title ? `caption="${v.title.replace(/\s+/g, ' ').slice(0, 140)}"` : '',
		].filter(Boolean);
		return parts.join(' | ');
	});

	const prompt = `Bạn là Giám đốc Sáng tạo & Chuyên gia Phân tích Dựng phim TikTok chuyên sâu về ngành Thời trang (Fashion 20-30s) kết hợp Remotion + ghost-editor.

NHIỆM VỤ: Giải mã toàn bộ **Editing DNA** (công thức dựng video, nhịp cắt, hook 3 giây đầu, cấu trúc shot, phụ đề, chuyển cảnh, âm thanh, màu sắc) của các kênh TikTok sau để hệ thống tự động cut-ghép video theo đúng phong cách tối ưu nhất.

THÔNG TIN KÊNH:
- Các kênh mục tiêu: ${channelSummaries.map((c) => `${c.handle} (${c.url})`).join(', ')}
- Ngách nội dung: ${niche}
${bios.length ? `- Bio kênh:\n${bios.join('\n')}` : ''}
${args.notes ? `- Ghi chú thêm từ người dùng: ${args.notes}` : ''}

DỮ LIỆU VIDEO ĐO ĐƯỢC (Metadata + FFmpeg Scene Cut Detection):
${videoDigest.length ? videoDigest.join('\n') : '(Kênh hạn chế crawl trực tiếp — hãy phân tích sâu dựa trên đặc trưng kênh TikTok thời trang 20-30s hàng đầu Việt Nam/Quốc tế và ghi chú người dùng để xây dựng Editing DNA chuẩn xác nhất.)'}

CHỈ TRẢ VỀ DUY NHẤT 1 JSON HỢP LỆ (không markdown, không giải thích ngoài JSON) theo đúng cấu trúc:
{
  "summary": "Tóm tắt sắc nét 2-3 câu về DNA dựng phim của kênh này",
  "metrics": {
    "avgDurationSec": 25,
    "targetRangeSec": [20, 30],
    "avgShotLengthSec": 1.6,
    "cutsPer10Sec": 6.2,
    "hookWindowSec": 3.0,
    "wordsPerSec": 3.2,
    "musicEnergy": "high"
  },
  "hook3sFormula": {
    "pattern": "Công thức hook 3 giây đầu đặc trưng",
    "visualPattern": "Cách chuyển động máy/góc quay trong 0-3s",
    "textStyle": "Kiểu chữ tiêu đề hook 3s",
    "audioImpact": "Âm thanh SFX / giọng nói mở đầu",
    "examples": ["Ví dụ hook 1 bằng tiếng Việt", "Ví dụ hook 2", "Ví dụ hook 3"]
  },
  "pacingCurve": {
    "intro0to3s": "Mô tả nhịp 0-3s",
    "body3to20s": "Mô tả nhịp 3-20s",
    "outro20to30s": "Mô tả nhịp 20-30s"
  },
  "shotGrammar": [
    "0.0-1.5s: ...",
    "1.5-3.0s: ...",
    "3.0-10.0s: ...",
    "10.0-20.0s: ...",
    "20.0-28.0s: ..."
  ],
  "editingPreset": {
    "style": "editorial",
    "pace": "fast",
    "transition": "flash",
    "zoom": 1.2,
    "sfx": "standard",
    "wordsPerGroup": 3,
    "maxDuration": 28,
    "accent": "#FF4D8D",
    "colorMood": "Mô tả tông màu đặc trưng"
  },
  "viralRules": ["Quy tắc vàng 1", "Quy tắc vàng 2", "Quy tắc vàng 3", "Quy tắc vàng 4"],
  "avoidRules": ["Điều cần tránh 1", "Điều cần tránh 2", "Điều cần tránh 3"]
}

Ràng buộc giá trị:
- editingPreset.style CHỈ chọn 1 trong: "clean", "hormozi", "meme", "editorial", "cinematic", "news", "pop", "minimal"
- editingPreset.pace CHỈ chọn 1 trong: "natural", "fast", "ultra"
- editingPreset.transition CHỈ chọn 1 trong: "cut", "flash", "dip", "whoosh"
- editingPreset.sfx CHỈ chọn 1 trong: "off", "restrained", "standard", "rich"
- editingPreset.maxDuration: số nguyên từ 20 đến 30 cho video thời trang 20-30s
- metrics.musicEnergy: "chill" | "medium" | "high"
- Toàn bộ nội dung viết bằng Tiếng Việt chuyên nghiệp, thực chiến.`;

	const fb = fallbackDna(profileName, channelSummaries, allVideos, niche, chosenModel);
	try {
		const res = await runAgyPrompt(prompt, {model: chosenModel, timeoutMs: 120_000});
		const match = res.output.match(/\{[\s\S]*\}/);
		if (match) {
			const p = JSON.parse(match[0]);
			const preset = p.editingPreset || {};
			const dna: TikTokChannelDNA = {
				...fb,
				modelUsed: res.model || chosenModel,
				summary: typeof p.summary === 'string' && p.summary.trim() ? p.summary.trim() : fb.summary,
				metrics: {
					avgDurationSec: Number(p.metrics?.avgDurationSec) || fb.metrics.avgDurationSec,
					targetRangeSec:
						Array.isArray(p.metrics?.targetRangeSec) && p.metrics.targetRangeSec.length === 2
							? [Number(p.metrics.targetRangeSec[0]) || 20, Number(p.metrics.targetRangeSec[1]) || 30]
							: [20, 30],
					avgShotLengthSec: Number(p.metrics?.avgShotLengthSec) || fb.metrics.avgShotLengthSec,
					cutsPer10Sec: Number(p.metrics?.cutsPer10Sec) || fb.metrics.cutsPer10Sec,
					hookWindowSec: Number(p.metrics?.hookWindowSec) || 3.0,
					wordsPerSec: Number(p.metrics?.wordsPerSec) || 3.1,
					musicEnergy: ['chill', 'medium', 'high'].includes(p.metrics?.musicEnergy) ? p.metrics.musicEnergy : 'high',
				},
				hook3sFormula: {
					pattern: String(p.hook3sFormula?.pattern || fb.hook3sFormula.pattern),
					visualPattern: String(p.hook3sFormula?.visualPattern || fb.hook3sFormula.visualPattern),
					textStyle: String(p.hook3sFormula?.textStyle || fb.hook3sFormula.textStyle),
					audioImpact: String(p.hook3sFormula?.audioImpact || fb.hook3sFormula.audioImpact),
					examples: Array.isArray(p.hook3sFormula?.examples) && p.hook3sFormula.examples.length
						? p.hook3sFormula.examples.map(String).slice(0, 5)
						: fb.hook3sFormula.examples,
				},
				pacingCurve: {
					intro0to3s: String(p.pacingCurve?.intro0to3s || fb.pacingCurve.intro0to3s),
					body3to20s: String(p.pacingCurve?.body3to20s || fb.pacingCurve.body3to20s),
					outro20to30s: String(p.pacingCurve?.outro20to30s || fb.pacingCurve.outro20to30s),
				},
				shotGrammar: Array.isArray(p.shotGrammar) && p.shotGrammar.length ? p.shotGrammar.map(String).slice(0, 8) : fb.shotGrammar,
				editingPreset: {
					style: VALID_STYLES.has(preset.style) ? preset.style : fb.editingPreset.style,
					pace: ['natural', 'fast', 'ultra'].includes(preset.pace) ? preset.pace : fb.editingPreset.pace,
					transition: VALID_TRANSITIONS.has(preset.transition) ? preset.transition : fb.editingPreset.transition,
					zoom: Math.min(2, Math.max(0, Number(preset.zoom) || fb.editingPreset.zoom)),
					sfx: ['off', 'restrained', 'standard', 'rich'].includes(preset.sfx) ? preset.sfx : fb.editingPreset.sfx,
					wordsPerGroup: Math.min(6, Math.max(1, Math.round(Number(preset.wordsPerGroup) || 3))),
					maxDuration: Math.min(45, Math.max(15, Math.round(Number(preset.maxDuration) || 28))),
					accent: typeof preset.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(preset.accent) ? preset.accent : fb.editingPreset.accent,
					colorMood: String(preset.colorMood || fb.editingPreset.colorMood),
				},
				viralRules: Array.isArray(p.viralRules) && p.viralRules.length ? p.viralRules.map(String).slice(0, 8) : fb.viralRules,
				avoidRules: Array.isArray(p.avoidRules) && p.avoidRules.length ? p.avoidRules.map(String).slice(0, 6) : fb.avoidRules,
			};
			dbPutAppRecord(APP_NS, DNA_COL, dna.id, dna);
			return dna;
		}
	} catch {}

	dbPutAppRecord(APP_NS, DNA_COL, fb.id, fb);
	return fb;
}

export function listDnaProfiles(): TikTokChannelDNA[] {
	const rows = dbListAppRecords(APP_NS, DNA_COL);
	return rows.map((r) => r.data as TikTokChannelDNA).filter((d) => d && d.id);
}

export function getDnaProfile(id: string): TikTokChannelDNA | null {
	if (!id) return null;
	return dbGetAppRecord<TikTokChannelDNA>(APP_NS, DNA_COL, id);
}

export function deleteDnaProfile(id: string): void {
	dbDeleteAppRecord(APP_NS, DNA_COL, id);
}

/** Merge multiple learned TikTok Channel DNA profiles into one unified Master DNA */
export async function mergeDnaProfiles(ids: string[], name?: string, model?: string): Promise<TikTokChannelDNA> {
	const profiles = ids.map(getDnaProfile).filter(Boolean) as TikTokChannelDNA[];
	if (profiles.length < 2) throw new Error('Cần chọn ít nhất 2 hồ sơ DNA để hợp nhất.');

	const combinedChannels = profiles.flatMap((p) => p.channels);
	const combinedVideos = profiles.flatMap((p) => p.rawVideos || []);
	const mergedName = (name || '').trim() || `Master DNA (${profiles.map((p) => p.name).slice(0, 2).join(' × ')})`;
	const notes =
		'Hợp nhất các DNA kênh đã học sau thành 1 Master DNA tối ưu nhất cho video thời trang 20-30s:\n' +
		profiles
			.map(
				(p, i) =>
					`DNA #${i + 1} (${p.name}): ${p.summary} | Shot avg=${p.metrics.avgShotLengthSec}s | Hook=${p.hook3sFormula.pattern} | Preset=${JSON.stringify(p.editingPreset)}`,
			)
			.join('\n');

	return await learnTikTokChannelsDNA({
		urls: combinedChannels.filter((c) => c.url.startsWith('http')).map((c) => c.url),
		name: mergedName,
		niche: profiles[0].niche,
		notes,
		model,
		maxVideosPerChannel: 6,
	});
}
