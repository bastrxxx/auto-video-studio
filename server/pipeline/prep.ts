// Step 1 (ghost-editor prep.sh): constant-frame-rate proxy for frame-exact cuts, voice levelled to -16 LUFS,
// a 16 kHz mono wav for whisper, and the pauses from the audio itself (silencedetect).
import path from 'node:path';
import {parseFfTime, probe, run, type Probe} from '../ff.js';
import type {Format} from '../../shared/types.js';

export const FPS = 30;

export const outputSize = (format: Format, src: {width: number; height: number}) => {
	switch (format) {
		case '9:16':
			return {width: 1080, height: 1920};
		case '16:9':
			return {width: 1920, height: 1080};
		case '1:1':
			return {width: 1080, height: 1080};
		case '4:5':
			return {width: 1080, height: 1350};
		default: {
			const k = Math.min(1, 1920 / Math.max(src.width, src.height));
			const even = (x: number) => Math.max(2, Math.round((x * k) / 2) * 2);
			return {width: even(src.width), height: even(src.height)};
		}
	}
};

export const makeProxy = async (
	input: string,
	dir: string,
	format: Format,
	onProgress: (p: number) => void,
): Promise<{proxy: string; wav: string; info: Probe; proxyInfo: Probe}> => {
	const info = await probe(input);
	const out = outputSize(format, info);
	// enough resolution for the crop (+15 % for punch-in zooms), never upscale, at least the output's short side
	const cover = Math.max(out.width / info.width, out.height / info.height) * 1.15;
	const minShort = Math.min(1080, Math.min(info.width, info.height));
	let k = Math.min(1, cover);
	if (Math.min(info.width, info.height) * k < minShort) k = minShort / Math.min(info.width, info.height);
	const pw = Math.max(2, Math.round((info.width * k) / 2) * 2);
	const ph = Math.max(2, Math.round((info.height * k) / 2) * 2);

	const proxy = path.join(dir, 'proxy.mp4');
	const wav = path.join(dir, 'audio16k.wav');
	const args = ['-y', '-hide_banner', '-i', input];
	if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
	args.push(
		'-map', '0:v:0',
		'-map', info.hasAudio ? '0:a:0' : '1:a:0',
		'-vf', `scale=${pw}:${ph}:flags=lanczos,format=yuv420p`,
		// Remotion's ffmpeg build has no fps filter: constant frame rate via the output options
		'-r', String(FPS), '-fps_mode', 'cfr',
		'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-g', String(FPS / 2), '-bf', '0',
		'-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
	);
	if (info.hasAudio) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000');
	else args.push('-shortest');
	args.push('-movflags', '+faststart', proxy);

	await run('ffmpeg', args, {
		onStderr: (s) => {
			const t = parseFfTime(s);
			if (t !== null && info.duration > 0) onProgress(Math.min(0.99, t / info.duration));
		},
	});
	await run('ffmpeg', ['-y', '-hide_banner', '-i', proxy, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
	const proxyInfo = await probe(proxy);
	onProgress(1);
	return {proxy, wav, info, proxyInfo};
};

/** silences longer than `min` seconds below `noise` dB, in seconds of the recording */
export const detectSilences = async (wav: string, noise = -35, min = 0.25): Promise<[number, number][]> => {
	const {stderr} = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', `silencedetect=noise=${noise}dB:d=${min}`, '-f', 'null', '-']);
	const starts = [...stderr.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Math.max(0, Number(m[1])));
	const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
	const dur = await probe(wav).then((p) => p.duration).catch(() => Infinity);
	return starts.map((s, i) => [s, ends[i] ?? dur] as [number, number]);
};

/**
 * Pick a silence threshold that fits THIS recording: ghost-editor found a fixed -38 dB glues a noisy
 * outdoor take into one island. We measure the speech level via astats-free approach: try a few
 * thresholds and keep the one where silences cover a plausible share of the recording (8-45 %).
 */
export const adaptiveSilences = async (wav: string, duration: number, min: number) => {
	const tries = [-35, -30, -40, -26, -45];
	let best: {noise: number; sil: [number, number][]; share: number; score: number} | null = null;
	for (const noise of tries) {
		const sil = await detectSilences(wav, noise, min);
		const share = sil.reduce((a, [s, e]) => a + (e - s), 0) / Math.max(1, duration);
		const score = share >= 0.06 && share <= 0.45 ? 0 : Math.min(Math.abs(share - 0.06), Math.abs(share - 0.45));
		if (!best || score < best.score) best = {noise, sil, share, score};
		if (score === 0) break;
	}
	return best!;
};
