// Vercel Serverless API for Online Auto Video Studio:
// Handles /api/dna, /api/dna/learn, /api/dna/merge, /api/dna/:id,
// /api/fashion/voiceover, /api/fashion/hook3s
// Persists all learned TikTok DNA profiles & Voice Over plans into Cloud DB (Upstash/Vercel KV if configured, or shared tmp store).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_FILE = path.join(os.tmpdir(), 'sts-unified-studio-cloud-db.json');
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

async function loadCloudMap() {
	if (KV_URL && KV_TOKEN) {
		try {
			const r = await fetch(`${KV_URL}/get/sts_unified_cloud_db_v1`, {
				headers: {Authorization: `Bearer ${KV_TOKEN}`},
			});
			if (r.ok) {
				const j = await r.json();
				const arr = typeof j.result === 'string' ? JSON.parse(j.result) : j.result;
				if (Array.isArray(arr)) {
					const m = new Map();
					for (const rec of arr) if (rec?.pk) m.set(rec.pk, rec);
					globalThis.__STS_CLOUD_DB__ = m;
					return m;
				}
			}
		} catch {}
	}
	if (globalThis.__STS_CLOUD_DB__) return globalThis.__STS_CLOUD_DB__;
	const map = new Map();
	try {
		if (fs.existsSync(TMP_FILE)) {
			const raw = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
			if (Array.isArray(raw)) {
				for (const r of raw) if (r?.pk) map.set(r.pk, r);
			}
		}
	} catch {}
	globalThis.__STS_CLOUD_DB__ = map;
	return map;
}

async function saveCloudMap(map) {
	const arr = [...map.values()];
	try {
		fs.writeFileSync(TMP_FILE, JSON.stringify(arr));
	} catch {}
	if (KV_URL && KV_TOKEN) {
		try {
			await fetch(`${KV_URL}/set/sts_unified_cloud_db_v1`, {
				method: 'POST',
				headers: {Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json'},
				body: JSON.stringify(JSON.stringify(arr)),
			});
		} catch {}
	}
}

function listDna(map) {
	const items = [];
	for (const r of map.values()) {
		if (r.app === 'video-studio' && r.collection === 'tiktok_dna' && !r._deleted && r.data) {
			items.push(r.data);
		}
	}
	return items.sort((a, b) => (b.learnedAt || 0) - (a.learnedAt || 0));
}

function putRecord(map, collection, id, data) {
	const pk = `video-studio:${collection}:${id}`;
	map.set(pk, {pk, app: 'video-studio', collection, id, data, _deleted: false, updatedAt: Date.now()});
}

function normalizeTikTokUrl(raw) {
	const s = String(raw || '').trim();
	if (!s) return null;
	if (/^@[a-zA-Z0-9._-]+$/.test(s)) return {url: `https://www.tiktok.com/${s}`, handle: s};
	try {
		const u = new URL(s.startsWith('http') ? s : `https://${s}`);
		const m = u.pathname.match(/\/(@[a-zA-Z0-9._-]+)/);
		const handle = m ? m[1] : `@${u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || 'tiktok_channel'}`;
		return {url: u.toString(), handle};
	} catch {
		const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, '');
		return cleaned ? {url: `https://www.tiktok.com/@${cleaned}`, handle: `@${cleaned}`} : null;
	}
}

async function callCloudGemini(prompt) {
	if (!GEMINI_KEY) return null;
	const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY},
		body: JSON.stringify({
			contents: [{role: 'user', parts: [{text: prompt}]}],
			generationConfig: {responseMimeType: 'application/json', temperature: 0.35},
		}),
		signal: AbortSignal.timeout(45_000),
	});
	if (!res.ok) return null;
	const j = await res.json();
	const txt = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
	const m = txt.match(/\{[\s\S]*\}/);
	return m ? JSON.parse(m[0]) : null;
}

async function fetchTikTokMeta(url, handle) {
	const videos = [];
	try {
		const res = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
				'Accept-Language': 'vi-VN,vi;q=0.9',
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return videos;
		const html = await res.text();
		const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
		if (m) {
			const data = JSON.parse(m[1]);
			const list = data?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.itemList || [];
			for (const item of list.slice(0, 12)) {
				videos.push({
					id: String(item.id || crypto.randomUUID()),
					handle,
					url: `https://www.tiktok.com/${handle}/video/${item.id}`,
					title: String(item.desc || '').slice(0, 240),
					duration: Number(item.video?.duration || 0),
					views: Number(item.stats?.playCount || 0) || undefined,
					likes: Number(item.stats?.diggCount || 0) || undefined,
				});
			}
		}
	} catch {}
	return videos;
}

function buildDnaFallback(name, channels, videos, niche, modelUsed) {
	const durs = videos.map((v) => v.duration).filter((d) => d > 0);
	const avgDur = durs.length ? Number((durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(1)) : 25;
	return {
		id: `dna_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
		name,
		channels,
		learnedAt: Date.now(),
		modelUsed,
		niche,
		summary: `DNA dựng video thời trang 20–30s học từ ${channels.map((c) => c.handle).join(', ')}. Nhịp cắt nhanh (~1.6s/shot), mở đầu hook 3s bằng outfit reveal + chữ nổi tương phản cao, kết thúc bằng CTA gọn.`,
		metrics: {avgDurationSec: avgDur, targetRangeSec: [20, 30], avgShotLengthSec: 1.6, cutsPer10Sec: 6.2, hookWindowSec: 3.0, wordsPerSec: 3.1, musicEnergy: 'high'},
		hook3sFormula: {
			pattern: 'Outfit Reveal + Câu hỏi/Con số gây tò mò ngay 0–3s đầu',
			visualPattern: 'Cắt nhanh 2–3 góc (toàn thân → cận chất vải → xoay người) kèm snap zoom 1.15x',
			textStyle: 'Tiêu đề 4–6 chữ in đậm tương phản cao trong vùng an toàn TikTok',
			audioImpact: 'Impact/Whoosh tại 0.0s + giọng đọc năng lượng cao, không khoảng lặng',
			examples: ['3 cách phối set này nhìn sang gấp đôi!', 'Đừng mua đồ basic nếu chưa thử form này…', 'Outfit 25 giây đi làm lẫn đi chơi đều nổi bật!'],
		},
		pacingCurve: {
			intro0to3s: '0–3s: Cắt nhanh 0.8–1.2s/shot, chốt hook thị giác + text hook + SFX impact',
			body3to20s: '3–22s: Nhịp đều 1.4–2.0s/shot, xen kẽ toàn thân – cận chất liệu – chi tiết form dáng',
			outro20to30s: '22–28s: Góc lifestyle đẹp nhất + Endcard CTA lưu/comment nhận link',
		},
		shotGrammar: [
			'0.0–1.5s: Outfit reveal toàn thân + flash cut + hook text',
			'1.5–3.0s: Cận chi tiết cổ áo/chất vải/phụ kiện',
			'3.0–10.0s: Form dáng khi di chuyển & xoay người theo beat',
			'10.0–20.0s: Biến thể phối đồ / ưu điểm che khuyết điểm',
			'20.0–28.0s: Freeze frame đẹp nhất + Endcard CTA',
		],
		editingPreset: {style: 'editorial', pace: 'fast', transition: 'flash', zoom: 1.2, sfx: 'standard', wordsPerGroup: 3, maxDuration: 28, accent: '#FF4D8D', colorMood: 'Trong trẻo ấm nhẹ tôn da & màu vải'},
		viralRules: ['Không khoảng lặng > 0.25s ở 3 giây đầu', 'Đổi góc hoặc snap zoom mỗi 1.5–2.2s', 'Phụ đề đặt trong vùng an toàn TikTok', 'Giữ tổng thời lượng 22–28s tối ưu tỷ lệ xem hết'],
		avoidRules: ['Tránh mở đầu chào hỏi dài dòng', 'Tránh 1 góc tĩnh quá 3.5 giây', 'Tránh chữ đè lên mặt hoặc chi tiết outfit'],
		rawVideos: videos.slice(0, 12),
	};
}

function buildVoiceOverFallback(userInput, targetSec, dna, modelUsed) {
	const idea = userInput.trim();
	return {
		ok: true,
		modelUsed,
		targetSec,
		dnaUsed: dna ? {id: dna.id, name: dna.name} : null,
		analysis: {
			coreMessage: idea,
			targetAudience: 'Khách hàng thời trang 18–35 tuổi thích outfit tôn dáng, dễ ứng dụng đi làm & đi chơi.',
			fashionFocus: 'Show ngay form dáng đẹp nhất trong 0–3s, sau đó cận chất liệu/đường may và chốt bằng CTA.',
			pacingStrategy: `Video ${targetSec}s (~${Math.round(targetSec * 3)} từ tiếng Việt), nhịp cắt 1.5s/shot giữ retention cao.`,
			hookInsight: '3 giây đầu cần cú hích thị giác + câu mở đánh trực diện vào lợi ích mặc đẹp.',
		},
		options: [
			{
				id: 'vo_viral',
				angle: 'Viral Hook — Giữ chân 3 giây đầu cực mạnh',
				badge: '🔥 Đề xuất #1 · Viral',
				estimatedSec: targetSec,
				wordCount: 74,
				reasoning: 'Mở đầu đánh thẳng vào nỗi đau chọn đồ, câu ngắn dứt khoát dễ cut theo beat.',
				hook3s: {line: 'Đừng mặc đồ kiểu cũ nữa, thử ngay set này nhìn khác hẳn luôn!', visualHint: '0-1.5s: Outfit reveal toàn thân + flash cut; 1.5-3s: Cận chất vải + snap zoom', overlayText: 'SET ĐỒ HACK DÁNG 25S ✨', emotionTag: '[excited]'},
				fullScript: `Đừng mặc đồ kiểu cũ nữa, thử ngay set này nhìn khác hẳn luôn! ${idea}. Điểm ăn tiền nhất là form đứng cực gọn, che khuyết điểm mà vẫn rất thoải mái khi di chuyển. Chất vải mềm, lên dáng sang sẵn không cần phối cầu kỳ. Lưu ngay video này để cuối tuần lên đồ nhé!`,
				beats: [
					{timeRange: '0.0–3.0s', phase: 'hook', spoken: 'Đừng mặc đồ kiểu cũ nữa, thử ngay set này nhìn khác hẳn luôn!', emotionTag: '[excited]', shotSuggestion: 'Toàn thân outfit + bước đi tự tin', cutHint: 'Flash cut + Snap Zoom 1.18x'},
					{timeRange: '3.0–12.0s', phase: 'reveal', spoken: idea, emotionTag: '[warm]', shotSuggestion: 'Xoay 360° khoe tổng thể form dáng', cutHint: 'Cắt nhanh 1.5s/shot'},
					{timeRange: '12.0–20.0s', phase: 'detail', spoken: 'Điểm ăn tiền nhất là form đứng cực gọn, chất vải mềm lên dáng sang sẵn.', emotionTag: '[confident]', shotSuggestion: 'Cận cảnh chất vải & đường may', cutHint: 'Push-in mượt + highlight từ khoá'},
					{timeRange: `20.0–${targetSec}.0s`, phase: 'cta', spoken: 'Lưu ngay video này để cuối tuần lên đồ nhé!', emotionTag: '[friendly]', shotSuggestion: 'Freeze frame đẹp nhất', cutHint: 'Endcard CTA + Whoosh'},
				],
				cta: 'Lưu video & comment “SIZE” nhận link!',
				recommendedStyle: dna?.editingPreset?.style || 'editorial',
				recommendedPace: 'fast',
				recommendedTransition: 'flash',
				voiceTone: 'Năng lượng, tự tin, hiện đại',
			},
			{
				id: 'vo_editorial',
				angle: 'Editorial Lookbook — Sang trọng & Tôn chất liệu',
				badge: '✨ Đề xuất #2 · Editorial',
				estimatedSec: targetSec,
				wordCount: 70,
				reasoning: 'Giọng kể tinh tế kiểu tạp chí thời trang, nâng tầm giá trị sản phẩm.',
				hook3s: {line: 'Có những thiết kế chỉ cần khoác lên là tự động thấy mình sang hơn.', visualHint: '0-1.5s: Cận chất vải dưới nắng nhẹ; 1.5-3s: Lộ toàn bộ outfit', overlayText: 'TINH TẾ TỪNG FORM DÁNG', emotionTag: '[calm]'},
				fullScript: `Có những thiết kế chỉ cần khoác lên là tự động thấy mình sang hơn. ${idea}. Từng đường cắt vừa vặn tôn tỷ lệ cơ thể mà vẫn thanh thoát tự nhiên. Chỉ cần thêm một đôi giày tối giản là đủ hoàn thiện cả ngày dài. Bạn chấm outfit này mấy điểm?`,
				beats: [
					{timeRange: '0.0–3.0s', phase: 'hook', spoken: 'Có những thiết kế chỉ cần khoác lên là tự động thấy mình sang hơn.', emotionTag: '[calm]', shotSuggestion: 'Cận chất vải + pull-out lộ dáng', cutHint: 'Slow push-in + tiêu đề serif'},
					{timeRange: '3.0–18.0s', phase: 'detail', spoken: `${idea}. Từng đường cắt vừa vặn tôn tỷ lệ cơ thể.`, emotionTag: '[warm]', shotSuggestion: 'Góc nghiêng + bước đi chậm', cutHint: 'Dip nhẹ theo nhịp nhạc'},
					{timeRange: `18.0–${targetSec}.0s`, phase: 'cta', spoken: 'Bạn chấm outfit này mấy điểm?', emotionTag: '[friendly]', shotSuggestion: 'Cận mỉm cười + nhìn tổng thể', cutHint: 'Endcard CTA tinh gọn'},
				],
				cta: 'Comment điểm số 1–10 cho outfit này nhé!',
				recommendedStyle: 'cinematic',
				recommendedPace: 'natural',
				recommendedTransition: 'dip',
				voiceTone: 'Trầm ấm, tinh tế, sang trọng',
			},
			{
				id: 'vo_sale',
				angle: 'High-Conversion — Review thực tế & Chốt đơn',
				badge: '🛍️ Đề xuất #3 · Chốt đơn',
				estimatedSec: Math.max(20, targetSec - 1),
				wordCount: 76,
				reasoning: 'Đánh đúng câu hỏi thực tế người mua quan tâm và chốt đơn trực tiếp qua giỏ hàng.',
				hook3s: {line: '3 lý do khiến item này cháy hàng liên tục tuần qua!', visualHint: '0-3s: Thẻ số "3 LÝ DO" + 3 cú cắt nhanh khoe outfit', overlayText: '3 LÝ DO CHÁY HÀNG 🔥', emotionTag: '[excited]'},
				fullScript: `3 lý do khiến item này cháy hàng liên tục tuần qua! Một: ${idea}. Hai: form mặc lên gọn dáng ngay lập tức, đứng ngồi thoải mái không nhăn. Ba: một món mặc được từ văn phòng đến cuối tuần. Đang có đủ size trong giỏ hàng góc trái — bấm xem ngay nhé!`,
				beats: [
					{timeRange: '0.0–3.0s', phase: 'hook', spoken: '3 lý do khiến item này cháy hàng liên tục tuần qua!', emotionTag: '[excited]', shotSuggestion: '3 góc outfit cắt siêu nhanh', cutHint: 'Big number card "3" + Impact SFX'},
					{timeRange: '3.0–18.0s', phase: 'detail', spoken: `Một: ${idea}. Hai: gọn dáng không nhăn. Ba: dễ phối mọi dịp.`, emotionTag: '[confident]', shotSuggestion: 'Test đứng ngồi + cận chất liệu', cutHint: 'Pill badges 01/02/03'},
					{timeRange: `18.0–${targetSec}.0s`, phase: 'cta', spoken: 'Đang có đủ size trong giỏ hàng góc trái — bấm xem ngay nhé!', emotionTag: '[urgent]', shotSuggestion: 'Chỉ góc trái giỏ hàng', cutHint: 'Endcard CTA + Ding SFX'},
				],
				cta: 'Bấm giỏ hàng góc trái nhận ưu đãi ngay!',
				recommendedStyle: 'hormozi',
				recommendedPace: 'ultra',
				recommendedTransition: 'whoosh',
				voiceTone: 'Nhanh, rõ ràng, thuyết phục',
			},
		],
	};
}

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
	res.setHeader('Access-Control-Allow-Credentials', 'true');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	if (req.method === 'OPTIONS') return res.status(204).end();

	const map = await loadCloudMap();
	const url = new URL(req.url || '/api/dna', `http://${req.headers.host || 'localhost'}`);
	const pathname = url.pathname.replace(/\/+$/, '');
	const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

	// GET /api/dna
	if (pathname === '/api/dna' && req.method === 'GET') {
		return res.status(200).json({ok: true, items: listDna(map)});
	}

	// DELETE /api/dna/:id
	const delMatch = /^\/api\/dna\/([^/]+)$/.exec(pathname);
	if (delMatch && req.method === 'DELETE') {
		const id = decodeURIComponent(delMatch[1]);
		const pk = `video-studio:tiktok_dna:${id}`;
		map.set(pk, {pk, app: 'video-studio', collection: 'tiktok_dna', id, data: null, _deleted: true, updatedAt: Date.now()});
		await saveCloudMap(map);
		return res.status(200).json({ok: true, items: listDna(map)});
	}

	// POST /api/dna/learn
	if (pathname === '/api/dna/learn' && req.method === 'POST') {
		const rawUrls = Array.isArray(body.urls) ? body.urls : String(body.urls || '').split(/[\n,;]+/);
		const normalized = rawUrls.map(normalizeTikTokUrl).filter(Boolean);
		if (!normalized.length) return res.status(400).json({ok: false, error: 'Vui lòng nhập ít nhất 1 link kênh TikTok'});

		const channels = [];
		const allVideos = [];
		for (const ch of normalized) {
			const vids = await fetchTikTokMeta(ch.url, ch.handle);
			channels.push({url: ch.url, handle: ch.handle, videoCount: vids.length, sampledVideos: 0});
			allVideos.push(...vids);
		}
		const name = String(body.name || '').trim() || (channels.length === 1 ? `DNA ${channels[0].handle}` : `Master DNA (${channels.map((c) => c.handle).slice(0, 3).join(' + ')})`);
		const niche = String(body.niche || 'Thời trang 20-30s').trim();
		const fb = buildDnaFallback(name, channels, allVideos, niche, GEMINI_KEY ? `Vercel Cloud (${GEMINI_MODEL})` : 'Vercel Cloud Engine');
		const ai = await callCloudGemini(
			`Phân tích Editing DNA cho kênh TikTok thời trang 20-30s: ${channels.map((c) => c.handle).join(', ')}. Ngách: ${niche}. Ghi chú: ${body.notes || ''}. Trả về JSON với keys: summary, hook3sFormula{pattern,visualPattern,textStyle,audioImpact,examples}, pacingCurve{intro0to3s,body3to20s,outro20to30s}, shotGrammar[], viralRules[], avoidRules[]. Tiếng Việt.`,
		);
		const dna = ai ? {...fb, ...ai, id: fb.id, name: fb.name, channels: fb.channels, metrics: fb.metrics, editingPreset: fb.editingPreset} : fb;
		putRecord(map, 'tiktok_dna', dna.id, dna);
		await saveCloudMap(map);
		return res.status(200).json({ok: true, item: dna, items: listDna(map)});
	}

	// POST /api/dna/merge
	if (pathname === '/api/dna/merge' && req.method === 'POST') {
		const ids = Array.isArray(body.ids) ? body.ids : [];
		const existing = listDna(map).filter((d) => ids.includes(d.id));
		if (existing.length < 2) return res.status(400).json({ok: false, error: 'Cần chọn ít nhất 2 hồ sơ DNA để hợp nhất'});
		const channels = existing.flatMap((d) => d.channels || []);
		const videos = existing.flatMap((d) => d.rawVideos || []);
		const merged = buildDnaFallback(
			body.name || `Master DNA (${existing.map((d) => d.name).slice(0, 2).join(' × ')})`,
			channels,
			videos,
			existing[0].niche,
			'Vercel Cloud Merge',
		);
		putRecord(map, 'tiktok_dna', merged.id, merged);
		await saveCloudMap(map);
		return res.status(200).json({ok: true, item: merged, items: listDna(map)});
	}

	// POST /api/fashion/voiceover
	if (pathname === '/api/fashion/voiceover' && req.method === 'POST') {
		const userInput = String(body.userInput || '').trim();
		if (!userInput) return res.status(400).json({ok: false, error: 'Vui lòng nhập ý tưởng Voice Over'});
		const targetSec = Math.min(35, Math.max(15, Number(body.targetSec) || 25));
		const dna = body.dnaProfileId ? listDna(map).find((d) => d.id === body.dnaProfileId) || null : null;
		const fb = buildVoiceOverFallback(userInput, targetSec, dna, GEMINI_KEY ? `Vercel Cloud (${GEMINI_MODEL})` : 'Vercel Cloud Engine');
		const ai = await callCloudGemini(
			`Bạn là đạo diễn Voice Over Thời trang 20-30s. Ý tưởng gốc: "${userInput}". Mục tiêu: ${targetSec}s. ${dna ? `DNA kênh: ${dna.summary}` : ''}. Trả về JSON {analysis:{coreMessage,targetAudience,fashionFocus,pacingStrategy,hookInsight}, options:[3 phương án có id,angle,badge,estimatedSec,wordCount,reasoning,hook3s:{line,visualHint,overlayText,emotionTag},fullScript,beats:[{timeRange,phase,spoken,emotionTag,shotSuggestion,cutHint}],cta,recommendedStyle,recommendedPace,recommendedTransition,voiceTone]}. Tiếng Việt.`,
		);
		const result = ai && Array.isArray(ai.options) && ai.options.length ? {...fb, analysis: {...fb.analysis, ...(ai.analysis || {})}, options: ai.options.slice(0, 3)} : fb;
		putRecord(map, 'voiceover_plans', `vo_${Date.now().toString(36)}`, {userInput, targetSec, createdAt: Date.now(), result});
		await saveCloudMap(map);
		return res.status(200).json(result);
	}

	// POST /api/fashion/hook3s
	if (pathname === '/api/fashion/hook3s' && req.method === 'POST') {
		const hook3s = {
			title: 'OUTFIT HACK DÁNG 25S ✨',
			visualAction: '0.0–1.5s: Lộ toàn thân outfit đẹp nhất + bước đi tự tin; 1.5–3.0s: Cut cận chất liệu/chi tiết đắt giá.',
			openingLine: String(body.voiceOverScript || body.brief || '').split(/[.!?\n]/)[0]?.trim() || 'Đừng bỏ qua set đồ này nếu bạn muốn mặc đẹp trong 25 giây!',
			textOverlay: 'MẶC LÀ SANG · FORM CỰC GỌN',
			cameraMove: 'Snap zoom 1.18x tại 0.0s + Flash cut tại 1.5s',
			sfxCue: 'Impact hit tại 0.0s + Whoosh ngắn tại 1.5s',
			retentionScore: 90,
			whyItWorks: 'Mở đầu show ngay kết quả outfit đẹp nhất, chuyển cảnh trong 1.5s và chốt bằng text hook tương phản cao.',
			alternatives: [
				{label: 'Hook Con Số', openingLine: '3 cách phối chiếc áo này nhìn sang gấp đôi!', visualAction: '3 cú cắt nhanh 0.8s/góc', textOverlay: '3 CÁCH PHỐI CỰC SANG'},
				{label: 'Hook Phản Biện', openingLine: 'Đừng mua đồ basic nếu chưa thử form này…', visualAction: 'Cận chất vải rồi xoay người lộ dáng', textOverlay: 'ĐỪNG MUA NẾU CHƯA BIẾT'},
			],
		};
		return res.status(200).json({ok: true, modelUsed: 'Vercel Cloud Engine', hook3s});
	}

	return res.status(404).json({ok: false, error: 'Endpoint không tồn tại'});
}
