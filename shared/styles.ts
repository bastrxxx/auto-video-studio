// Style presets, adapted from ghost-editor's styles/*.json (clean, meme, editorial, cinematic, pop, kinetic)
// plus Caption News and a Hormozi preset. Each preset sets the caption look, the film look,
// the sound density and the music mood.
import type {CaptionLook, CaptionStyleId, Look} from './types';

export type StylePreset = {
	id: CaptionStyleId;
	name: string;
	about: string;
	accent: string;
	ink: string;
	caption: Omit<CaptionLook, 'style'>;
	look: Look;
	sfx: 'restrained' | 'standard' | 'rich';
	musicMood: string[];
	zoomBias: number; // multiplies the zoom intensity
	emojiDensity: number; // max emoji per minute
};

const base: Omit<CaptionLook, 'style'> = {
	font: 'Montserrat',
	weight: 800,
	size: 64,
	upper: false,
	lower: false,
	color: '#FFFFFF',
	activeColor: null,
	keywordColor: '#FFD23F',
	keywordMode: 'color',
	stroke: 0,
	strokeColor: '#000000',
	shadow: true,
	anim: 'pop',
	bg: 'none',
	maxWidth: 0.82,
};

export const STYLES: Record<CaptionStyleId, StylePreset> = {
	clean: {
		id: 'clean',
		name: 'Clean (Hormozi nhẹ)',
		about: 'Phụ đề đậm chữ thường, từ đang nói đổi màu, zoom cắt nhanh, ít hiệu ứng. Hợp video business/talking head.',
		accent: '#FFD23F',
		ink: '#111111',
		caption: {...base, activeColor: '#FFD23F'},
		look: {},
		sfx: 'restrained',
		musicMood: ['chill', 'subtle'],
		zoomBias: 1,
		emojiDensity: 2,
	},
	hormozi: {
		id: 'hormozi',
		name: 'Hormozi (viral)',
		about: 'Chữ IN HOA to, viền đen dày, từ đang nói xanh/vàng nảy lên. Nhịp nhanh, zoom mạnh.',
		accent: '#3CFF6B',
		ink: '#111111',
		caption: {
			...base,
			font: 'Anton',
			weight: 400,
			size: 82,
			upper: true,
			activeColor: '#3CFF6B',
			keywordColor: '#FFE14D',
			stroke: 7,
			anim: 'bounce',
		},
		look: {grade: 'contrast(1.05) saturate(1.08)'},
		sfx: 'standard',
		musicMood: ['upbeat', 'electronic'],
		zoomBias: 1.3,
		emojiDensity: 4,
	},
	meme: {
		id: 'meme',
		name: 'Meme (vui nhộn)',
		about: 'Chữ viền đen, emoji bật cạnh đầu, thẻ số lớn, âm thanh “phản ứng” nhiều.',
		accent: '#FFD166',
		ink: '#111111',
		caption: {...base, font: 'Bangers', weight: 400, size: 80, upper: true, stroke: 6, keywordColor: '#FFD166', anim: 'bounce'},
		look: {grade: 'saturate(1.12)'},
		sfx: 'rich',
		musicMood: ['quirky', 'fun'],
		zoomBias: 1.25,
		emojiDensity: 6,
	},
	editorial: {
		id: 'editorial',
		name: 'Editorial (Gen Z)',
		about: 'Phụ đề chữ thường hiện mờ dần, từ khóa trong thẻ màu nghiêng, nhạc nền tối giản.',
		accent: '#D13F34',
		ink: '#262626',
		caption: {...base, weight: 700, size: 60, lower: true, keywordMode: 'box', keywordColor: '#D13F34', anim: 'blur', shadow: true},
		look: {grade: 'contrast(1.03) saturate(0.95)'},
		sfx: 'standard',
		musicMood: ['tech', 'ambient', 'minimal'],
		zoomBias: 0.9,
		emojiDensity: 1,
	},
	cinematic: {
		id: 'cinematic',
		name: 'Cinematic (phim tài liệu)',
		about: 'Màu phim, hạt nhiễu, viền tối; từ khóa thành chữ serif nghiêng phát sáng.',
		accent: '#E7C27A',
		ink: '#EDE6DA',
		caption: {
			...base,
			weight: 600,
			size: 58,
			keywordMode: 'serif',
			serifFont: 'Playfair Display',
			keywordColor: '#E7C27A',
			anim: 'blur',
		},
		look: {grade: 'contrast(1.06) saturate(0.82) brightness(0.97)', grain: 0.07, vignette: 0.45},
		sfx: 'restrained',
		musicMood: ['cinematic', 'ambient', 'reflective'],
		zoomBias: 0.7,
		emojiDensity: 0,
	},
	news: {
		id: 'news',
		name: 'Caption News',
		about: 'Phụ đề khối lớn IN HOA, từ khóa trên nền vàng như bản tin.',
		accent: '#FFE14D',
		ink: '#111111',
		caption: {
			...base,
			font: 'Oswald',
			weight: 700,
			size: 74,
			upper: true,
			keywordMode: 'box',
			keywordColor: '#FFE14D',
			anim: 'none',
			stroke: 0,
		},
		look: {grade: 'contrast(1.04)'},
		sfx: 'restrained',
		musicMood: ['tech', 'minimal'],
		zoomBias: 0.8,
		emojiDensity: 0,
	},
	pop: {
		id: 'pop',
		name: 'Pop magazine',
		about: 'Chữ IN HOA, từ khóa trên khối hồng nóng, màu sắc rực, nhạc pop.',
		accent: '#FF2E88',
		ink: '#111111',
		caption: {...base, font: 'Unbounded', weight: 800, size: 58, upper: true, keywordMode: 'box', keywordColor: '#FF2E88', anim: 'pop'},
		look: {grade: 'saturate(1.18) contrast(1.05)'},
		sfx: 'standard',
		musicMood: ['upbeat', 'pop', 'happy'],
		zoomBias: 1.1,
		emojiDensity: 3,
	},
	minimal: {
		id: 'minimal',
		name: 'Minimal (chỉ phụ đề)',
		about: 'Phụ đề nhỏ gọn kiểu karaoke, không hiệu ứng, không âm thanh. Hợp vlog/hướng dẫn.',
		accent: '#7CC4FF',
		ink: '#111111',
		caption: {...base, font: 'Be Vietnam Pro', weight: 600, size: 52, activeColor: '#7CC4FF', anim: 'karaoke', bg: 'pill', shadow: false},
		look: {},
		sfx: 'restrained',
		musicMood: ['chill', 'lo-fi'],
		zoomBias: 0.5,
		emojiDensity: 0,
	},
};

export const FONT_LIST = ['Montserrat', 'Anton', 'Bangers', 'Oswald', 'Unbounded', 'Be Vietnam Pro', 'Playfair Display'];
