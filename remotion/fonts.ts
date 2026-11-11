// Google Fonts with the Vietnamese subset, loaded only when the plan uses them.
import {loadFont as anton} from '@remotion/google-fonts/Anton';
import {loadFont as bangers} from '@remotion/google-fonts/Bangers';
import {loadFont as beVietnam} from '@remotion/google-fonts/BeVietnamPro';
import {loadFont as montserrat} from '@remotion/google-fonts/Montserrat';
import {loadFont as oswald} from '@remotion/google-fonts/Oswald';
import {loadFont as playfair} from '@remotion/google-fonts/PlayfairDisplay';
import {loadFont as unbounded} from '@remotion/google-fonts/Unbounded';

const subsets: ('latin' | 'latin-ext' | 'vietnamese')[] = ['latin', 'latin-ext', 'vietnamese'];
const loaded = new Set<string>();

const LOADERS: Record<string, () => void> = {
	Montserrat: () => montserrat('normal', {weights: ['600', '700', '800', '900'], subsets}),
	Anton: () => anton('normal', {weights: ['400'], subsets}),
	Bangers: () => bangers('normal', {weights: ['400'], subsets}),
	Oswald: () => oswald('normal', {weights: ['600', '700'], subsets}),
	Unbounded: () => unbounded('normal', {weights: ['700', '800'], subsets}),
	'Be Vietnam Pro': () => beVietnam('normal', {weights: ['600', '800'], subsets}),
	'Playfair Display': () => {
		playfair('italic', {weights: ['700'], subsets});
	},
};

export const ensureFonts = (fonts: (string | undefined)[]) => {
	for (const f of ['Montserrat', ...fonts]) {
		if (!f || loaded.has(f) || !LOADERS[f]) continue;
		loaded.add(f);
		try {
			LOADERS[f]();
		} catch (e) {
			// offline: fall back to system fonts
			console.warn('font', f, e);
		}
	}
};

export const fontStack = (f: string) => `"${f}", "Be Vietnam Pro", "Montserrat", -apple-system, "Helvetica Neue", Arial, sans-serif`;
