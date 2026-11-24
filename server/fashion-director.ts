// Fashion 20-30s Director:
// 1. Voice Over Script Reasoner (user writes a few sentences -> AGY CLI reasons & returns 3 optimal VO options + beat/cut plans)
// 2. 3-Second Hook Analyzer & Blueprint generator
// 3. Optional Voice Over Audio Synthesizer (VoiceStudio Pro CLI -> macOS `say` fallback -> WAV)
import {execFile} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import type {CaptionStyleId, ClipTransition, Hook3sBlueprint, TikTokChannelDNA, VoiceOverOption} from '../shared/types.js';
import {findAgyBinary, getAgyConfig, runAgyPrompt} from './agy-cli.js';
import {PATHS} from './config.js';
import {dbPutAppRecord} from './db.js';
import {run as runFf} from './ff.js';
import {getDnaProfile} from './tiktok-dna.js';

const execFileAsync = promisify(execFile);

const VALID_STYLES = new Set<CaptionStyleId>(['clean', 'hormozi', 'meme', 'editorial', 'cinematic', 'news', 'pop', 'minimal']);
const VALID_TRANSITIONS = new Set<ClipTransition>(['cut', 'flash', 'dip', 'whoosh']);

export type VoiceOverPlanResponse = {
	ok: boolean;
	modelUsed: string;
	targetSec: number;
	dnaUsed?: {id: string; name: string} | null;
	analysis: {
		coreMessage: string;
		targetAudience: string;
		fashionFocus: string;
		pacingStrategy: string;
		hookInsight: string;
	};
	options: VoiceOverOption[];
};

function formatDnaContext(dna: TikTokChannelDNA | null): string {
	if (!dna) return '';
	return `\nDNA KÊNH TIKTOK ĐANG ÁP DỤNG ("${dna.name}"):
- Tóm tắt: ${dna.summary}
- Thời lượng trung bình: ${dna.metrics.avgDurationSec}s (mục tiêu ${dna.metrics.targetRangeSec[0]}-${dna.metrics.targetRangeSec[1]}s)
- Nhịp cắt: ${dna.metrics.avgShotLengthSec}s/shot (${dna.metrics.cutsPer10Sec} cuts/10s), tốc độ nói ~${dna.metrics.wordsPerSec} từ/giây
- Công thức Hook 3s đầu: ${dna.hook3sFormula.pattern} | Visual: ${dna.hook3sFormula.visualPattern} | Text: ${dna.hook3sFormula.textStyle}
- Cấu trúc nhịp: Intro: ${dna.pacingCurve.intro0to3s} | Body: ${dna.pacingCurve.body3to20s} | Outro: ${dna.pacingCurve.outro20to30s}
- Ngữ pháp shot: ${dna.shotGrammar.join(' -> ')}
- Quy tắc viral: ${dna.viralRules.join('; ')}
- Cần tránh: ${dna.avoidRules.join('; ')}\n`;
}

function buildFallbackVoiceOver(userInput: string, targetSec: number, dna: TikTokChannelDNA | null, modelUsed: string): VoiceOverPlanResponse {
	const idea = userInput.trim() || 'Set đồ thời trang tôn dáng, dễ phối đi làm và đi chơi';
	return {
		ok: true,
		modelUsed,
		targetSec,
		dnaUsed: dna ? {id: dna.id, name: dna.name} : null,
		analysis: {
			coreMessage: idea,
			targetAudience: 'Khách hàng yêu thời trang 18–35 tuổi thích outfit tôn dáng, mặc đẹp nhanh và có tính ứng dụng cao.',
			fashionFocus: 'Nhấn mạnh form dáng ngay 3 giây đầu, sau đó cận chất vải/đường may và kết bằng 2 cách phối thực tế.',
			pacingStrategy: `Video mục tiêu ${targetSec}s (~${Math.round(targetSec * 3)} từ tiếng Việt), nhịp cắt nhanh 1.4–1.8s/shot để giữ retention cao.`,
			hookInsight: '3 giây đầu phải show ngay thành quả outfit đẹp nhất + câu mở đầu đánh thẳng vào nỗi đau hoặc sự tò mò.',
		},
		options: [
			{
				id: 'vo_viral_hook',
				angle: 'Viral Hook — Giữ chân 3 giây đầu cực mạnh',
				badge: '🔥 Đề xuất #1 · Viral',
				estimatedSec: 25,
				wordCount: 74,
				reasoning: 'Đánh trực diện vào nỗi đau chọn đồ trong 3 giây đầu, nhịp câu ngắn dứt khoát giúp cắt ghép theo beat cực mượt.',
				hook3s: {
					line: 'Đừng mặc đồ kiểu cũ nữa, thử ngay set này nhìn khác hẳn luôn!',
					visualHint: '0-1.5s: Outfit reveal toàn thân + flash cut; 1.5-3s: Cận chi tiết cổ/eo + snap zoom',
					overlayText: 'SET ĐỒ HACK DÁNG 25S ✨',
					emotionTag: '[excited]',
				},
				fullScript: `Đừng mặc đồ kiểu cũ nữa, thử ngay set này nhìn khác hẳn luôn! ${idea}. Điểm ăn tiền nhất là phần form đứng cực gọn, che khuyết điểm mà vẫn cực kỳ thoải mái khi di chuyển. Chất vải mềm, lên dáng sang sẵn nên không cần phối cầu kỳ. Đi làm thanh lịch, chiều đi cà phê vẫn nổi bật. Lưu ngay video này lại để cuối tuần lên đồ nhé!`,
				beats: [
					{timeRange: '0.0–3.0s', phase: 'hook', spoken: 'Đừng mặc đồ kiểu cũ nữa, thử ngay set này nhìn khác hẳn luôn!', emotionTag: '[excited]', shotSuggestion: 'Toàn thân outfit đẹp nhất + bước đi tự tin', cutHint: 'Flash cut + Snap Zoom 1.18x + SFX Impact'},
					{timeRange: '3.0–9.0s', phase: 'reveal', spoken: `${idea}.`, emotionTag: '[warm]', shotSuggestion: 'Xoay 360° khoe tổng thể form dáng', cutHint: '2-3 shot cắt nhanh 1.5s/shot'},
					{timeRange: '9.0–17.0s', phase: 'detail', spoken: 'Điểm ăn tiền nhất là phần form đứng cực gọn, che khuyết điểm mà vẫn cực kỳ thoải mái khi di chuyển. Chất vải mềm, lên dáng sang sẵn nên không cần phối cầu kỳ.', emotionTag: '[confident]', shotSuggestion: 'Cận cảnh chất vải, đường may, chi tiết eo/tay áo', cutHint: 'Push-in mượt + từ khoá tô màu nổi'},
					{timeRange: '17.0–25.0s', phase: 'cta', spoken: 'Đi làm thanh lịch, chiều đi cà phê vẫn nổi bật. Lưu ngay video này lại để cuối tuần lên đồ nhé!', emotionTag: '[friendly]', shotSuggestion: 'Góc lifestyle ngoài trời + freeze frame cuối', cutHint: 'Endcard CTA + Whoosh nhẹ'},
				],
				cta: 'Lưu video & comment “SIZE” để nhận link!',
				recommendedStyle: dna?.editingPreset.style || 'editorial',
				recommendedPace: 'fast',
				recommendedTransition: 'flash',
				voiceTone: 'Năng lượng, tự tin, nhịp nhanh hiện đại',
			},
			{
				id: 'vo_editorial_lux',
				angle: 'Editorial Lookbook — Sang trọng & Tôn chất liệu',
				badge: '✨ Đề xuất #2 · Editorial',
				estimatedSec: 26,
				wordCount: 72,
				reasoning: 'Giọng kể tinh tế như tạp chí thời trang, phù hợp thương hiệu local brand muốn nâng tầm cảm nhận giá trị sản phẩm.',
				hook3s: {
					line: 'Có những thiết kế chỉ cần khoác lên là tự động thấy mình sang hơn.',
					visualHint: '0-1.5s: Cận chất vải dưới ánh sáng tự nhiên; 1.5-3s: Pull-out lộ toàn bộ outfit',
					overlayText: 'TINH TẾ TRONG TỪNG FORM DÁNG',
					emotionTag: '[calm]',
				},
				fullScript: `Có những thiết kế chỉ cần khoác lên là tự động thấy mình sang hơn. ${idea}. Từng đường cắt được tinh chỉnh vừa vặn để tôn tỷ lệ cơ thể mà không hề gò bó. Khi di chuyển, chất vải rủ nhẹ tạo cảm giác thanh thoát rất tự nhiên. Chỉ cần thêm một đôi giày tối giản là đủ hoàn thiện cả ngày dài. Bạn chấm outfit này mấy điểm?`,
				beats: [
					{timeRange: '0.0–3.0s', phase: 'hook', spoken: 'Có những thiết kế chỉ cần khoác lên là tự động thấy mình sang hơn.', emotionTag: '[calm]', shotSuggestion: 'Cận chất vải + lộ dáng mượt', cutHint: 'Slow push-in + tiêu đề serif tinh tế'},
					{timeRange: '3.0–12.0s', phase: 'reveal', spoken: `${idea}. Từng đường cắt được tinh chỉnh vừa vặn để tôn tỷ lệ cơ thể mà không hề gò bó.`, emotionTag: '[warm]', shotSuggestion: 'Toàn thân + góc nghiêng tôn đường cắt', cutHint: 'Cắt nhịp 2.0s theo tiếng nhạc'},
					{timeRange: '12.0–21.0s', phase: 'detail', spoken: 'Khi di chuyển, chất vải rủ nhẹ tạo cảm giác thanh thoát rất tự nhiên.', emotionTag: '[gentle]', shotSuggestion: 'Slow-mo bước đi + cận độ rủ vải', cutHint: 'Dip mượt nhẹ + màu điện ảnh'},
					{timeRange: '21.0–26.0s', phase: 'cta', spoken: 'Chỉ cần thêm một đôi giày tối giản là đủ hoàn thiện cả ngày dài. Bạn chấm outfit này mấy điểm?', emotionTag: '[friendly]', shotSuggestion: 'Góc cận mỉm cười + nhìn tổng thể', cutHint: 'Endcard CTA tinh gọn'},
				],
				cta: 'Comment điểm số 1–10 cho outfit này nhé!',
				recommendedStyle: 'cinematic',
				recommendedPace: 'natural',
				recommendedTransition: 'dip',
				voiceTone: 'Trầm ấm, sang trọng, truyền cảm hứng',
			},
			{
				id: 'vo_conversion_sale',
				angle: 'High-Conversion — Review thực tế & Chốt đơn',
				badge: '🛍️ Đề xuất #3 · Chốt đơn',
				estimatedSec: 24,
				wordCount: 76,
				reasoning: 'Tập trung giải quyết thắc mắc thực tế của người mua (có tôn dáng không, vải có mát không, mặc dịp nào) để tăng tỷ lệ click giỏ hàng.',
				hook3s: {
					line: '3 lý do khiến item này cháy hàng liên tục tuần qua!',
					visualHint: '0-3s: Hiện thẻ số "3 LÝ DO" + cắt nhanh 3 góc outfit đẹp nhất',
					overlayText: '3 LÝ DO CHÁY HÀNG 🔥',
					emotionTag: '[excited]',
				},
				fullScript: `3 lý do khiến item này cháy hàng liên tục tuần qua! Một: ${idea}. Hai: form mặc lên gọn dáng ngay lập tức, đứng ngồi đều thoải mái không nhăn. Ba: cực kỳ dễ phối, một món nhưng mặc được từ văn phòng tới cuối tuần. Hiện đang có đủ size và ưu đãi tốt nhất trong giỏ hàng góc trái — bấm xem ngay kẻo hết size đẹp nhé!`,
				beats: [
					{timeRange: '0.0–3.0s', phase: 'hook', spoken: '3 lý do khiến item này cháy hàng liên tục tuần qua!', emotionTag: '[excited]', shotSuggestion: '3 cú cắt siêu nhanh 0.8s khoe outfit', cutHint: 'Big number card "3" + Impact SFX'},
					{timeRange: '3.0–10.0s', phase: 'reveal', spoken: `Một: ${idea}.`, emotionTag: '[confident]', shotSuggestion: 'Toàn thân + chỉ tay vào điểm nhấn', cutHint: 'Pill badge "01" + Pop SFX'},
					{timeRange: '10.0–18.0s', phase: 'detail', spoken: 'Hai: form mặc lên gọn dáng ngay lập tức, đứng ngồi đều thoải mái không nhăn. Ba: cực kỳ dễ phối, một món nhưng mặc được từ văn phòng tới cuối tuần.', emotionTag: '[confident]', shotSuggestion: 'Test đứng/ngồi + cận vải không nhăn', cutHint: 'Pill badge "02", "03" + cắt nhanh'},
					{timeRange: '18.0–24.0s', phase: 'cta', spoken: 'Hiện đang có đủ size và ưu đãi tốt nhất trong giỏ hàng góc trái — bấm xem ngay kẻo hết size đẹp nhé!', emotionTag: '[urgent]', shotSuggestion: 'Chỉ góc trái giỏ hàng + nụ cười tự tin', cutHint: 'Endcard CTA + Ding SFX'},
				],
				cta: 'Bấm giỏ hàng góc trái nhận ưu đãi ngay!',
				recommendedStyle: 'hormozi',
				recommendedPace: 'ultra',
				recommendedTransition: 'whoosh',
				voiceTone: 'Nhanh, rõ ràng, thuyết phục, giàu năng lượng',
			},
		],
	};
}

export async function generateVoiceOverOptions(args: {
	userInput: string;
	targetSec?: number;
	dnaProfileId?: string;
	brandStyle?: string;
	model?: string;
}): Promise<VoiceOverPlanResponse> {
	const userInput = (args.userInput || '').trim();
	if (!userInput) throw new Error('Vui lòng nhập ít nhất 1 vài câu mô tả ý tưởng / sản phẩm thời trang.');

	const targetSec = Math.min(35, Math.max(15, Number(args.targetSec) || 25));
	const dna = args.dnaProfileId ? getDnaProfile(args.dnaProfileId) : null;
	const agyCfg = getAgyConfig();
	const chosenModel = (args.model || agyCfg.customModel || agyCfg.model || 'gemini-4-neon-high').trim();
	const agyBin = await findAgyBinary(agyCfg.customPath);

	if (!agyBin) {
		return buildFallbackVoiceOver(userInput, targetSec, dna, 'heuristic-local');
	}

	const approxWords = Math.round(targetSec * (dna?.metrics.wordsPerSec || 3.0));
	const prompt = `Bạn là Giám đốc Sáng tạo Thời trang & Chuyên gia Kịch bản Voice Over TikTok/Reels 20-30s hàng đầu.

NGƯỜI DÙNG VIẾT VÀI CÂU Ý TƯỞNG GỐC:
"""
${userInput}
"""
${args.brandStyle ? `Phong cách thương hiệu mong muốn: ${args.brandStyle}\n` : ''}
Mục tiêu thời lượng video: ${targetSec} giây (khoảng ${approxWords - 10} đến ${approxWords + 10} từ tiếng Việt đọc tự nhiên).
${formatDnaContext(dna)}

NHIỆM VỤ:
1. Phân tích & suy luận sâu về sản phẩm/ý tưởng thời trang này (nỗi đau khách hàng, điểm ăn tiền thị giác, nhịp cut-ghép cho video 20-30s, bí quyết giữ chân 3 giây đầu).
2. Đưa ra ĐÚNG 3 phương án Voice Over tối ưu nhất theo 3 góc tiếp cận khác nhau:
   - Phương án 1: 🔥 Viral Hook (giữ chân 3s đầu cực mạnh, nhịp nhanh)
   - Phương án 2: ✨ Editorial / Storytelling Thời trang (sang trọng, tôn chất liệu & form dáng)
   - Phương án 3: 🛍️ High-Conversion / Chốt đơn (review thực tế, giải đáp nỗi lo, CTA mạnh)
3. Mỗi phương án PHẢI có mô tả chi tiết **Hook 3 giây đầu** (câu nói, hình ảnh, chữ overlay, cảm xúc) và **chia beat từng giây** (0.0-3.0s, 3.0-10.0s, 10.0-20.0s, 20.0-${targetSec}.0s) kèm gợi ý góc quay & kỹ thuật cut ghép (Remotion + ghost-editor).

CHỈ TRẢ VỀ DUY NHẤT 1 JSON HỢP LỆ (không markdown, không text thừa):
{
  "analysis": {
    "coreMessage": "...",
    "targetAudience": "...",
    "fashionFocus": "...",
    "pacingStrategy": "...",
    "hookInsight": "..."
  },
  "options": [
    {
      "id": "vo_1",
      "angle": "Tên góc tiếp cận",
      "badge": "🔥 Đề xuất #1 · Viral",
      "estimatedSec": ${targetSec},
      "wordCount": ${approxWords},
      "reasoning": "Lý do phương án này tối ưu...",
      "hook3s": {
        "line": "Câu mở đầu 0-3s",
        "visualHint": "Hình ảnh/cắt cảnh cụ thể trong 3 giây đầu",
        "overlayText": "CHỮ HIỆN 3S ĐẦU (tối đa 6 từ)",
        "emotionTag": "[excited]"
      },
      "fullScript": "Toàn bộ lời Voice Over liền mạch bằng tiếng Việt tự nhiên, đúng độ dài ${targetSec}s...",
      "beats": [
        {
          "timeRange": "0.0-3.0s",
          "phase": "hook",
          "spoken": "...",
          "emotionTag": "[excited]",
          "shotSuggestion": "Gợi ý cảnh quay thời trang",
          "cutHint": "Gợi ý kỹ thuật cut/zoom/SFX"
        }
      ],
      "cta": "Câu CTA cuối video",
      "recommendedStyle": "editorial",
      "recommendedPace": "fast",
      "recommendedTransition": "flash",
      "voiceTone": "Mô tả tông giọng đọc phù hợp"
    }
  ]
}

Ràng buộc:
- recommendedStyle CHỈ chọn trong: "clean", "hormozi", "meme", "editorial", "cinematic", "news", "pop", "minimal"
- recommendedPace CHỈ chọn trong: "natural", "fast", "ultra"
- recommendedTransition CHỈ chọn trong: "cut", "flash", "dip", "whoosh"
- phase CHỈ chọn trong: "hook", "problem", "reveal", "detail", "cta"
- Viết 100% tiếng Việt tự nhiên, sắc bén, mang hơi thở thời trang TikTok thực chiến.`;

	const fb = buildFallbackVoiceOver(userInput, targetSec, dna, chosenModel);
	try {
		const res = await runAgyPrompt(prompt, {model: chosenModel, timeoutMs: 120_000});
		const match = res.output.match(/\{[\s\S]*\}/);
		if (match) {
			const p = JSON.parse(match[0]);
			const options: VoiceOverOption[] = Array.isArray(p.options)
				? p.options.slice(0, 3).map((o: any, idx: number) => {
						const fullScript = String(o.fullScript || '').trim();
						const wc = fullScript ? fullScript.split(/\s+/).filter(Boolean).length : Number(o.wordCount) || 70;
						return {
							id: String(o.id || `vo_${idx + 1}`),
							angle: String(o.angle || `Phương án ${idx + 1}`),
							badge: String(o.badge || `Đề xuất #${idx + 1}`),
							estimatedSec: Number(o.estimatedSec) || Math.round(wc / 3),
							wordCount: wc,
							reasoning: String(o.reasoning || ''),
							hook3s: {
								line: String(o.hook3s?.line || ''),
								visualHint: String(o.hook3s?.visualHint || ''),
								overlayText: String(o.hook3s?.overlayText || '').slice(0, 48),
								emotionTag: String(o.hook3s?.emotionTag || '[confident]'),
							},
							fullScript,
							beats: Array.isArray(o.beats)
								? o.beats.map((b: any) => ({
										timeRange: String(b.timeRange || ''),
										phase: ['hook', 'problem', 'reveal', 'detail', 'cta'].includes(b.phase) ? b.phase : 'reveal',
										spoken: String(b.spoken || ''),
										emotionTag: String(b.emotionTag || '[warm]'),
										shotSuggestion: String(b.shotSuggestion || ''),
										cutHint: String(b.cutHint || ''),
									}))
								: [],
							cta: String(o.cta || ''),
							recommendedStyle: VALID_STYLES.has(o.recommendedStyle) ? o.recommendedStyle : 'editorial',
							recommendedPace: ['natural', 'fast', 'ultra'].includes(o.recommendedPace) ? o.recommendedPace : 'fast',
							recommendedTransition: VALID_TRANSITIONS.has(o.recommendedTransition) ? o.recommendedTransition : 'flash',
							voiceTone: String(o.voiceTone || 'Tự tin, cuốn hút'),
						};
					})
				: fb.options;

			const finalRes: VoiceOverPlanResponse = {
				ok: true,
				modelUsed: res.model || chosenModel,
				targetSec,
				dnaUsed: dna ? {id: dna.id, name: dna.name} : null,
				analysis: {
					coreMessage: String(p.analysis?.coreMessage || fb.analysis.coreMessage),
					targetAudience: String(p.analysis?.targetAudience || fb.analysis.targetAudience),
					fashionFocus: String(p.analysis?.fashionFocus || fb.analysis.fashionFocus),
					pacingStrategy: String(p.analysis?.pacingStrategy || fb.analysis.pacingStrategy),
					hookInsight: String(p.analysis?.hookInsight || fb.analysis.hookInsight),
				},
				options: options.length ? options : fb.options,
			};
			dbPutAppRecord('video-studio', 'voiceover_plans', `vo_${Date.now().toString(36)}`, {
				userInput,
				targetSec,
				dnaProfileId: dna?.id || '',
				createdAt: Date.now(),
				result: finalRes,
			});
			return finalRes;
		}
	} catch {}

	dbPutAppRecord('video-studio', 'voiceover_plans', `vo_${Date.now().toString(36)}`, {
		userInput,
		targetSec,
		dnaProfileId: dna?.id || '',
		createdAt: Date.now(),
		result: fb,
	});
	return fb;
}

export async function analyzeHook3s(args: {
	brief?: string;
	transcript?: string;
	voiceOverScript?: string;
	dnaProfileId?: string;
	model?: string;
}): Promise<{ok: boolean; modelUsed: string; hook3s: Hook3sBlueprint}> {
	const dna = args.dnaProfileId ? getDnaProfile(args.dnaProfileId) : null;
	const agyCfg = getAgyConfig();
	const chosenModel = (args.model || agyCfg.customModel || agyCfg.model || 'gemini-4-neon-high').trim();
	const agyBin = await findAgyBinary(agyCfg.customPath);

	const fallback: Hook3sBlueprint = {
		title: 'OUTFIT HACK DÁNG 25S ✨',
		visualAction: '0.0–1.5s: Outfit reveal toàn thân đẹp nhất bước thẳng vào khung hình; 1.5–3.0s: Cut cận chất vải/chi tiết đắt giá.',
		openingLine: (args.voiceOverScript || args.transcript || '').split(/[.!?\n]/)[0]?.trim() || 'Đừng bỏ qua set đồ này nếu bạn muốn mặc đẹp trong 30 giây!',
		textOverlay: 'MẶC LÀ SANG · FORM CỰC GỌN',
		cameraMove: 'Snap zoom 1.18x tại 0.0s + Flash cut tại 1.5s',
		sfxCue: 'Impact hit tại 0.0s + Whoosh ngắn tại 1.5s',
		retentionScore: 88,
		whyItWorks: 'Kết hợp 3 yếu tố giữ chân vàng của TikTok Thời trang: khoe ngay kết quả outfit đẹp nhất ở giây 0, đổi góc sau 1.5s, và có tiêu đề tương phản cao.',
		alternatives: [
			{label: 'Hook Con Số', openingLine: '3 cách phối chiếc áo này nhìn sang gấp đôi!', visualAction: 'Split nhịp 3 góc quay nhanh 0.8s/góc', textOverlay: '3 CÁCH PHỐI CỰC SANG'},
			{label: 'Hook Phản Biện', openingLine: 'Đừng mua đồ basic nếu chưa thử form này…', visualAction: 'Cận chất vải rồi xoay người lộ dáng', textOverlay: 'ĐỪNG MUA NẾU CHƯA BIẾT'},
		],
	};

	if (!agyBin) return {ok: true, modelUsed: 'heuristic-local', hook3s: fallback};

	const prompt = `Bạn là Chuyên gia tối ưu Retention 3 giây đầu (3-Second Hook) cho video TikTok Thời trang 20-30s.

NGỮ CẢNH VIDEO:
- Ý tưởng / Brief: ${args.brief || '(Chưa nhập)'}
- Kịch bản Voice Over: ${args.voiceOverScript || '(Chưa có)'}
- Lời thoại hiện tại: ${(args.transcript || '').slice(0, 1200) || '(Chưa có)'}
${formatDnaContext(dna)}

Hãy phân tích và thiết kế **Bản mô tả Hook 3 giây đầu (0.0s -> 3.0s)** tối ưu nhất để giữ chân người xem không lướt qua.
CHỈ TRẢ VỀ DUY NHẤT 1 JSON:
{
  "title": "Tiêu đề hook tối đa 6 từ in hoa",
  "visualAction": "Mô tả chi tiết hình ảnh & động tác trong 0-1.5s và 1.5-3.0s",
  "openingLine": "Câu nói/Voice Over mở đầu trong 3 giây đầu",
  "textOverlay": "Chữ hiển thị trên màn hình trong 3 giây đầu",
  "cameraMove": "Chuyển động máy/zoom/transition (vd: Snap zoom 1.18x + Flash cut 1.4s)",
  "sfxCue": "Hiệu ứng âm thanh 3s đầu (vd: Impact 0.0s + Whoosh 1.4s)",
  "retentionScore": 91,
  "whyItWorks": "Giải thích ngắn gọn tại sao hook này giữ chân được người xem thời trang",
  "alternatives": [
    {"label": "Phương án A", "openingLine": "...", "visualAction": "...", "textOverlay": "..."},
    {"label": "Phương án B", "openingLine": "...", "visualAction": "...", "textOverlay": "..."}
  ]
}`;

	try {
		const res = await runAgyPrompt(prompt, {model: chosenModel, timeoutMs: 90_000});
		const match = res.output.match(/\{[\s\S]*\}/);
		if (match) {
			const p = JSON.parse(match[0]);
			return {
				ok: true,
				modelUsed: res.model || chosenModel,
				hook3s: {
					title: String(p.title || fallback.title).slice(0, 60),
					visualAction: String(p.visualAction || fallback.visualAction),
					openingLine: String(p.openingLine || fallback.openingLine),
					textOverlay: String(p.textOverlay || fallback.textOverlay).slice(0, 60),
					cameraMove: String(p.cameraMove || fallback.cameraMove),
					sfxCue: String(p.sfxCue || fallback.sfxCue),
					retentionScore: Math.min(99, Math.max(50, Number(p.retentionScore) || 88)),
					whyItWorks: String(p.whyItWorks || fallback.whyItWorks),
					alternatives: Array.isArray(p.alternatives)
						? p.alternatives.slice(0, 3).map((a: any) => ({
								label: String(a.label || 'Biến thể'),
								openingLine: String(a.openingLine || ''),
								visualAction: String(a.visualAction || ''),
								textOverlay: String(a.textOverlay || ''),
							}))
						: fallback.alternatives,
				},
			};
		}
	} catch {}

	return {ok: true, modelUsed: chosenModel, hook3s: fallback};
}

/** Synthesize Voice Over script to a WAV file (tries VoiceStudio Pro -> macOS `say` + FFmpeg voice shaping for Male/Female) */
export async function synthesizeVoiceOverAudio(args: {
	text: string;
	voiceName?: string;
	voiceId?: string;
	rateWpm?: number;
}): Promise<{ok: boolean; engine: string; audioUrl: string; filePath: string; durationSec: number}> {
	const cleanText = (args.text || '').replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
	if (!cleanText) throw new Error('Thiếu nội dung lời thoại Voice Over để tạo âm thanh.');

	const voDir = path.join(PATHS.data, 'voiceovers');
	fs.mkdirSync(voDir, {recursive: true});
	const id = `vo_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
	const outWav = path.join(voDir, `${id}.wav`);
	const vid = (args.voiceId || args.voiceName || 'vi-female-natural').trim();

	// 1. Try local VoiceStudio Pro CLI if user selected a custom VoiceStudio cloned voice
	const vsCli = path.resolve(PATHS.root, '..', 'voicestudio-studio', 'cli', 'voicestudio.mjs');
	const isBuiltin = ['vi-female-natural', 'vi-female-fast', 'vi-male-warm', 'vi-male-deep', 'macos-linh', ''].includes(vid);
	if (!isBuiltin && fs.existsSync(vsCli)) {
		try {
			await execFileAsync(process.execPath, [vsCli, 'tts', '--voice', vid, '--text', cleanText, '--auto-emotion', '--out', outWav], {
				timeout: 90_000,
				env: {...process.env, VOICESTUDIO_APP_URL: process.env.VOICESTUDIO_APP_URL || 'http://localhost:3090'},
			});
			if (fs.existsSync(outWav) && fs.statSync(outWav).size > 2000) {
				const dur = await getAudioDuration(outWav);
				return {ok: true, engine: `VoiceStudio Pro (${vid})`, audioUrl: `/voiceovers/${id}.wav`, filePath: outWav, durationSec: dur};
			}
		} catch {}
	}

	// 2. Built-in Vietnamese TTS (Nữ / Nam presets via macOS `say` + FFmpeg formant/pitch shaping)
	const rawWav = path.join(voDir, `${id}.raw.wav`);
	const isMale = vid === 'vi-male-warm' || vid === 'vi-male-deep';
	const isFast = vid === 'vi-female-fast' || vid === 'vi-male-deep';
	const rate = Math.min(260, Math.max(140, Number(args.rateWpm) || (isFast ? 212 : isMale ? 188 : 196)));
	const sayArgs = ['--file-format=WAVE', '--data-format=LEI16@44100', '-r', String(rate), '-o', rawWav, cleanText];
	try {
		await execFileAsync('say', ['-v', 'Linh', ...sayArgs], {timeout: 30_000});
	} catch {
		await execFileAsync('say', sayArgs, {timeout: 30_000});
	}

	// Shape pitch cleanly for Male vs Female voices using FFmpeg asetrate + aresample + atempo
	const pitchFactor = vid === 'vi-male-deep' ? 0.78 : vid === 'vi-male-warm' ? 0.84 : vid === 'vi-female-fast' ? 1.04 : 1.0;
	const filterChain =
		pitchFactor !== 1.0
			? `asetrate=${Math.round(44100 * pitchFactor)},aresample=44100,atempo=${(1 / pitchFactor).toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11`
			: 'loudnorm=I=-16:TP=-1.5:LRA=11';

	const labelMap: Record<string, string> = {
		'vi-female-natural': '👩 Nữ Tự nhiên (VI)',
		'vi-female-fast': '👩 Nữ Năng lượng (VI)',
		'vi-male-warm': '👨 Nam Trầm ấm (VI)',
		'vi-male-deep': '👨 Nam Chốt đơn (VI)',
	};

	try {
		await runFf('ffmpeg', ['-y', '-i', rawWav, '-af', filterChain, '-ar', '44100', '-ac', '2', outWav]);
		fs.rmSync(rawWav, {force: true});
	} catch {
		fs.renameSync(rawWav, outWav);
	}

	const dur = await getAudioDuration(outWav);
	return {ok: true, engine: labelMap[vid] || '👩 Nữ Tự nhiên (VI)', audioUrl: `/voiceovers/${id}.wav`, filePath: outWav, durationSec: dur};
}

async function getAudioDuration(filePath: string): Promise<number> {
	try {
		const {stdout} = await runFf('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
		const d = Number(stdout.trim());
		return Number.isFinite(d) ? Number(d.toFixed(2)) : 0;
	} catch {
		return 0;
	}
}
