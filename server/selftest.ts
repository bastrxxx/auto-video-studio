/**
 * End-to-end check without the UI:  npm test -- <video> [--render] [--style hormozi] [--format 9:16]
 * Prints the transcript, every cut with its reason, and the plan summary.
 */
import fs from 'node:fs';
import path from 'node:path';
import {DEFAULT_OPTIONS, type JobOptions} from '../shared/types.js';
import {PATHS} from './config.js';
import {adaptiveSilences, makeProxy} from './pipeline/prep.js';
import {snapWordsToSilences, transcribeWords} from './pipeline/transcribe.js';
import {decideCuts, keptDuration} from './pipeline/edit.js';
import {buildPlan} from './pipeline/plan.js';
import {renderPlan} from './pipeline/render.js';
import express from 'express';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--')) || path.join(PATHS.root, 'data', 'test', 'test-talk.mp4');
const flag = (k: string) => {
	const i = args.indexOf(`--${k}`);
	return i >= 0 ? args[i + 1] : undefined;
};

const main = async () => {
	const opts: JobOptions = {
		...DEFAULT_OPTIONS,
		style: (flag('style') as JobOptions['style']) || 'hormozi',
		format: (flag('format') as JobOptions['format']) || '9:16',
		music: flag('music') ?? 'auto',
		title: flag('title') ?? '',
		cta: flag('cta') ?? 'Follow for part 2',
		quality: (flag('quality') as JobOptions['quality']) || 'draft',
		language: flag('lang') || 'auto',
	};
	const dir = path.join(PATHS.root, 'data', 'selftest');
	fs.mkdirSync(dir, {recursive: true});
	console.time('prep');
	const r = await makeProxy(input, dir, opts.format, () => undefined);
	console.timeEnd('prep');
	console.log('proxy', r.proxyInfo);
	const sil = await adaptiveSilences(r.wav, r.proxyInfo.duration, 0.25);
	console.log(`silence threshold ${sil.noise} dB, ${sil.sil.length} silences, share ${(sil.share * 100).toFixed(0)}%`);
	console.time('transcribe');
	const tr = await transcribeWords(r.wav, {model: opts.model, language: opts.language, onProgress: () => undefined});
	console.timeEnd('transcribe');
	const words = snapWordsToSilences(tr.words, sil.sil);
	console.log(`language ${tr.language}, ${words.length} words`);
	const cut = decideCuts({words, silences: sil.sil, duration: r.proxyInfo.duration, opts});
	for (const s of cut.sentences) {
		const line = words
			.slice(s.w0, s.w1 + 1)
			.map((w) => (cut.status[w.i].keep ? w.text : `~~${w.text}~~(${cut.status[w.i].reason})`))
			.join(' ');
		console.log(`  S${s.id} ${s.start.toFixed(2)}-${s.end.toFixed(2)}: ${line}`);
	}
	console.log('takes', cut.takes.map((t) => `${t.a.toFixed(2)}-${t.b.toFixed(2)}`).join(' '));
	console.log(`kept ${keptDuration(cut.takes).toFixed(1)}s of ${r.proxyInfo.duration.toFixed(1)}s`, cut.stats);

	// serve the proxy + library for the renderer
	const app = express();
	app.use('/files', express.static(dir));
	app.use('/sfx', express.static(PATHS.sfx));
	app.use('/music', express.static(PATHS.music));
	const server = app.listen(8799, '127.0.0.1');
	const plan = buildPlan({
		words,
		status: cut.status,
		takes: cut.takes,
		opts,
		src: {width: r.proxyInfo.width, height: r.proxyInfo.height, url: 'http://127.0.0.1:8799/files/proxy.mp4'},
		face: null,
		baseUrl: 'http://127.0.0.1:8799',
	});
	fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 1));
	console.log(
		`plan ${plan.width}x${plan.height} ${(plan.durationInFrames / plan.fps).toFixed(1)}s, ${plan.captions.groups.length} caption groups, beats:`,
		plan.beats.map((b) => `${b.type}@${b.start.toFixed(1)}${b.text ? ':' + b.text : ''}${b.emoji || ''}`).join(', '),
		`| snaps ${plan.camera.snaps.length}, pushes ${plan.camera.pushes.length}, sfx ${plan.sfx.length}, music ${plan.music?.src.split('/').pop() || '-'}`,
	);
	if (args.includes('--render')) {
		console.time('render');
		let last = -1;
		await renderPlan(plan, path.join(dir, 'output.mp4'), opts.quality, (p, s) => {
			const k = Math.floor(p * 10);
			if (k !== last) {
				last = k;
				console.log(`  ${s} ${Math.round(p * 100)}%`);
			}
		});
		console.timeEnd('render');
		console.log('->', path.join(dir, 'output.mp4'));
	}
	server.close();
};

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
