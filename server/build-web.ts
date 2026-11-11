// Bundles the browser preview: Remotion <Player> + the same AutoEdit composition + the timeline compiler,
// so the editor shows exactly what will be rendered, live, while you edit.
import path from 'node:path';
import fs from 'node:fs';
import {PATHS} from './config.js';

export const buildWebBundle = async () => {
	const {build} = await import('esbuild');
	const out = path.join(PATHS.web, 'build', 'player.js');
	fs.mkdirSync(path.dirname(out), {recursive: true});
	await build({
		entryPoints: [path.join(PATHS.web, 'editor', 'player-entry.tsx')],
		bundle: true,
		format: 'esm',
		outfile: out,
		minify: true,
		sourcemap: false,
		jsx: 'automatic',
		target: ['chrome110', 'safari16'],
		define: {'process.env.NODE_ENV': '"production"'},
		logLevel: 'error',
	});
	return out;
};

if (process.argv[1] && process.argv[1].endsWith('build-web.ts')) {
	buildWebBundle().then((o) => console.log('built', o));
}
