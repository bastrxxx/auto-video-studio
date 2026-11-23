// Shared types: the server builds an EditPlan, the Remotion composition renders it.
// All "edit" times are seconds on the OUTPUT timeline; "orig" times are seconds in the uploaded recording.
import {DEFAULT_COLOR, type ColorSettings, type Grade} from './color';

export type Format = '9:16' | '16:9' | '1:1' | '4:5' | 'original';
export type Fit = 'fill' | 'blur';
export type Platform = 'tiktok' | 'instagram' | 'shorts' | 'all' | 'none';
export type CaptionStyleId = 'clean' | 'hormozi' | 'meme' | 'editorial' | 'cinematic' | 'news' | 'pop' | 'minimal';

/** One recognised word, in ORIGINAL seconds */
export type Word = {
	i: number;
	text: string;
	start: number;
	end: number;
	p: number;
};

/** A kept piece of the recording, ORIGINAL seconds */
export type Take = {a: number; b: number; reason?: string};

/** Face sample from the browser (normalised 0..1 in the displayed video frame) */
export type FaceSample = {
	t: number;
	x: number; // bbox left
	y: number; // bbox top (forehead)
	w: number;
	h: number;
	eye?: number; // eyes line y
	mouth?: number; // mouth y
	chin?: number; // chin y
};

export type PlanWord = {
	text: string;
	start: number; // edit seconds
	end: number;
	keyword?: boolean;
};

export type CaptionGroup = {
	start: number;
	end: number;
	words: PlanWord[];
	y: number; // top of the caption block, output px
	backing?: boolean; // dark backing (close-up fallback over the chest)
};

export type BeatType = 'big' | 'emoji' | 'title' | 'pill' | 'endcard' | 'strike' | 'flash' | 'dip';

export type Beat = {
	type: BeatType;
	start: number;
	end: number;
	text?: string;
	sub?: string;
	emoji?: string;
	count?: {from: number; to: number; prefix: string; suffix: string; decimals: number};
	x?: number; // output px (center)
	y?: number; // output px (center)
	size?: number;
};

export type SfxCue = {at: number; src: string; volume: number; maxDur?: number};

export type Push = {start: number; end: number; z: number; up: number; down: number};

export type Segment = {
	from: number; // output frame
	dur: number; // frames
	trimBefore: number; // source frame in the clip's proxy (CFR)
	clip?: number; // index into plan.clips (default 0)
	freeze?: boolean; // frozen frame (outro)
	grade?: number; // index into plan.grades (color correction)
};

/** one source video of a multi-clip project */
export type PlanClip = {src: string; width: number; height: number};

export type ClipOrderMode = 'auto' | 'time' | 'name' | 'manual';
export type ClipTransition = 'cut' | 'flash' | 'dip' | 'whoosh';

export type CaptionLook = {
	style: CaptionStyleId;
	font: string;
	weight: number;
	size: number; // px at the output resolution
	upper: boolean;
	lower: boolean;
	color: string;
	activeColor: string | null;
	keywordColor: string;
	keywordMode: 'color' | 'box' | 'serif' | 'none';
	serifFont?: string;
	stroke: number; // px outline
	strokeColor: string;
	shadow: boolean;
	anim: 'pop' | 'blur' | 'bounce' | 'none' | 'karaoke';
	bg: 'none' | 'pill';
	maxWidth: number; // fraction of the output width
};

export type Look = {
	grade?: string; // CSS filter
	grain?: number; // 0..0.2
	vignette?: number; // 0..1
};

export type VoiceOverTrack = {
	src: string;
	volume: number;
	muteOriginal: boolean;
	originalVolume: number;
	script?: string;
	voiceName?: string;
};

export type Hook3sBlueprint = {
	title: string;
	visualAction: string;
	openingLine: string;
	textOverlay: string;
	cameraMove: string;
	sfxCue: string;
	retentionScore: number;
	whyItWorks: string;
	alternatives?: {label: string; openingLine: string; visualAction: string; textOverlay: string}[];
};

export type TikTokChannelDNA = {
	id: string;
	name: string;
	channels: {url: string; handle: string; videoCount: number; sampledVideos: number}[];
	learnedAt: number;
	modelUsed: string;
	niche: string;
	summary: string;
	metrics: {
		avgDurationSec: number;
		targetRangeSec: [number, number];
		avgShotLengthSec: number;
		cutsPer10Sec: number;
		hookWindowSec: number;
		wordsPerSec: number;
		musicEnergy: 'chill' | 'medium' | 'high';
	};
	hook3sFormula: {
		pattern: string;
		visualPattern: string;
		textStyle: string;
		audioImpact: string;
		examples: string[];
	};
	pacingCurve: {
		intro0to3s: string;
		body3to20s: string;
		outro20to30s: string;
	};
	shotGrammar: string[];
	editingPreset: {
		style: CaptionStyleId;
		pace: 'natural' | 'fast' | 'ultra';
		transition: ClipTransition;
		zoom: number;
		sfx: 'off' | 'restrained' | 'standard' | 'rich';
		wordsPerGroup: number;
		maxDuration: number;
		accent: string;
		colorMood: string;
	};
	viralRules: string[];
	avoidRules: string[];
	rawVideos?: {
		id: string;
		handle: string;
		url: string;
		title: string;
		duration: number;
		views?: number;
		likes?: number;
		comments?: number;
		sceneCuts?: number;
		avgShotSec?: number;
	}[];
};

export type VoiceOverOption = {
	id: string;
	angle: string;
	badge: string;
	estimatedSec: number;
	wordCount: number;
	reasoning: string;
	hook3s: {
		line: string;
		visualHint: string;
		overlayText: string;
		emotionTag: string;
	};
	fullScript: string;
	beats: {
		timeRange: string;
		phase: 'hook' | 'problem' | 'reveal' | 'detail' | 'cta';
		spoken: string;
		emotionTag: string;
		shotSuggestion: string;
		cutHint: string;
	}[];
	cta: string;
	recommendedStyle: CaptionStyleId;
	recommendedPace: 'natural' | 'fast' | 'ultra';
	recommendedTransition: ClipTransition;
	voiceTone: string;
};

export type EditPlan = {
	version: 1;
	fps: number;
	width: number;
	height: number;
	durationInFrames: number;
	src: string; // URL of the first clip's proxy (single-clip compatibility)
	srcWidth: number;
	srcHeight: number;
	clips?: PlanClip[]; // all source clips, segments point into it
	fit: Fit;
	segments: Segment[];
	camera: {
		snaps: [number, number][]; // [edit sec, zoom]
		pushes: Push[];
		// crop centre track in SOURCE normalised coords [edit sec, cx, cy]
		follow: [number, number, number][];
		// zoom origin track (face) in SOURCE normalised coords [edit sec, fx, fy]
		origin: [number, number, number][];
		ease: boolean;
	};
	captions: {enabled: boolean; look: CaptionLook; groups: CaptionGroup[]};
	beats: Beat[];
	sfx: SfxCue[];
	music: {src: string; volume: number; duckVolume: number; speech: [number, number][]} | null;
	voiceOver?: VoiceOverTrack | null;
	look: Look;
	grades?: (Grade | null)[]; // SVG color grades referenced by segments
	brand: {accent: string; ink: string; font: string};
	progressBar: {enabled: boolean; color: string};
	safe: {top: number; bottom: number; right: number};
};

export type JobOptions = {
	format: Format;
	fit: Fit;
	platform: Platform;
	style: CaptionStyleId;
	language: string; // 'auto' | 'vi' | 'en' ...
	model: string; // whisper model
	removeSilence: boolean;
	pace: 'natural' | 'fast' | 'ultra';
	removeFillers: boolean;
	removeRetakes: boolean;
	maxDuration: number; // 0 = no limit
	captions: boolean;
	wordsPerGroup: number;
	captionSize: number; // multiplier 0.7..1.4
	accent: string; // '' = style default
	zoom: number; // 0..2 intensity
	emoji: boolean;
	bigNumbers: boolean;
	sfx: 'off' | 'restrained' | 'standard' | 'rich';
	music: string; // '' | 'auto' | music id
	progressBar: boolean;
	title: string; // hook title; '' = AI / none
	cta: string; // end card text; '' = none
	quality: 'draft' | 'standard' | 'high';
	geminiKey: string;
	useAI: boolean;
	fixes: Record<string, string>;
	order: ClipOrderMode; // how clips of a project are ordered
	manualOrder: string[]; // clip ids, for order = 'manual'
	transition: ClipTransition; // between clips
	brief: string; // the idea of the video, in the user's words — guides the AI and whisper
	aiFixCaptions: boolean; // let Gemini correct the transcript (spelling, diacritics, names)
	color: ColorSettings; // auto color + manual adjustments / filter (CapCut-style)
	// Fashion 20-30s + Hook 3s + Voice Over + TikTok Channel DNA
	fashionMode: boolean; // chuyên sâu dựng video thời trang 20-30s
	targetDurationRange: '20-30' | '15-20' | '30-45' | 'auto';
	dnaProfileId: string; // ID của TikTok Channel DNA đang áp dụng
	hook3sDescription: string; // mô tả/chỉ đạo hook 3 giây đầu
	voiceOverScript: string; // kịch bản Voice Over đã chọn
	voiceOverAudioUrl: string; // đường dẫn file audio Voice Over (nếu có)
	voiceOverMuteOriginal: boolean; // tắt/hạ tiếng gốc khi chạy Voice Over
};

export const DEFAULT_OPTIONS: JobOptions = {
	format: '9:16',
	fit: 'fill',
	platform: 'tiktok',
	style: 'editorial',
	language: 'vi',
	model: 'large-v3',
	removeSilence: true,
	pace: 'fast',
	removeFillers: true,
	removeRetakes: true,
	maxDuration: 28,
	captions: true,
	wordsPerGroup: 3,
	captionSize: 1,
	accent: '',
	zoom: 1.15,
	emoji: true,
	bigNumbers: true,
	sfx: 'standard',
	music: '',
	progressBar: false,
	title: '',
	cta: '',
	quality: 'standard',
	geminiKey: '',
	useAI: true,
	fixes: {},
	order: 'auto',
	manualOrder: [],
	transition: 'flash',
	brief: '',
	aiFixCaptions: true,
	color: {...DEFAULT_COLOR},
	fashionMode: true,
	targetDurationRange: '20-30',
	dnaProfileId: '',
	hook3sDescription: '',
	voiceOverScript: '',
	voiceOverAudioUrl: '',
	voiceOverMuteOriginal: false,
};
