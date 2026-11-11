// A plan without a source video, so `npm run studio` opens on something meaningful.
import {STYLES} from '../shared/styles';
import type {EditPlan} from '../shared/types';

const words = 'Ba sai lầm khiến kênh của bạn không lên view và cách sửa trong 30 ngày'.split(' ');
const st = STYLES.clean;

export const demoPlan: EditPlan = {
	version: 1,
	fps: 30,
	width: 1080,
	height: 1920,
	durationInFrames: 150,
	src: '',
	srcWidth: 1080,
	srcHeight: 1920,
	fit: 'fill',
	segments: [{from: 0, dur: 150, trimBefore: 0}],
	camera: {snaps: [[0, 1], [2, 1.12]], pushes: [], follow: [], origin: [], ease: false},
	captions: {
		enabled: true,
		look: {style: 'clean', ...st.caption},
		groups: [0, 3, 6, 9, 12].map((k, g) => ({
			start: g,
			end: g + 1,
			y: 1150,
			words: words.slice(k, k + 3).map((t, j) => ({text: t, start: g + j * 0.33, end: g + j * 0.33 + 0.3, keyword: t === 'lầm' || t === '30'})),
		})),
	},
	beats: [
		{type: 'title', start: 0, end: 2, text: '3 sai lầm', y: 380},
		{type: 'big', start: 3.2, end: 4.9, text: '30 ngày', sub: 'ĐỂ SỬA', count: {from: 0, to: 30, prefix: '', suffix: ' ngày', decimals: 0}, x: 540, y: 1250},
		{type: 'emoji', start: 1, end: 2.6, emoji: '🔥', x: 820, y: 600, size: 190},
	],
	sfx: [],
	music: null,
	look: {},
	brand: {accent: st.accent, ink: st.ink, font: st.caption.font},
	progressBar: {enabled: true, color: st.accent},
	safe: {top: 220, bottom: 480, right: 150},
};
