import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

export const WHISPER_VERSION = '1.5.5';

export const PATHS = {
	root: ROOT,
	web: path.join(ROOT, 'web'),
	public: path.join(ROOT, 'public'),
	sfx: path.join(ROOT, 'public', 'sfx'),
	music: path.join(ROOT, 'public', 'music'),
	jobs: path.join(ROOT, 'data', 'jobs'),
	whisper: path.join(ROOT, 'data', 'whisper.cpp'),
	remotionEntry: path.join(ROOT, 'remotion', 'index.ts'),
	compositorDir: path.join(ROOT, 'node_modules', '@remotion', `compositor-${process.platform}-${process.arch}`),
};

for (const p of [PATHS.jobs, PATHS.music]) fs.mkdirSync(p, {recursive: true});

export const PORT = Number(process.env.PORT || 8790);
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
