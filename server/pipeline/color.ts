// Auto color: sample a few frames of a clip, measure them, derive a gentle correction (shared/color.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {run} from '../ff.js';
import {autoAdjust, statsOf, type ColorAdjust} from '../../shared/color.js';

const W = 64;

export const analyzeClipColor = async (video: string, duration: number, width: number, height: number): Promise<Partial<ColorAdjust> | null> => {
	const H = Math.max(2, Math.round((W * height) / Math.max(1, width) / 2) * 2);
	const n = Math.max(3, Math.min(10, Math.round(duration / 4)));
	const frames: Uint8Array[] = [];
	const tmp = path.join(os.tmpdir(), `avs-color-${process.pid}-${Date.now()}.raw`);
	for (let i = 0; i < n; i++) {
		const t = (duration * (i + 0.5)) / n;
		try {
			await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', video, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-pix_fmt', 'rgb24', '-c:v', 'rawvideo', '-f', 'image2', '-update', '1', tmp]);
			const buf = fs.readFileSync(tmp);
			if (buf.length >= W * H * 3) frames.push(new Uint8Array(buf.buffer, buf.byteOffset, W * H * 3));
		} catch {
			// a frame that can't be decoded is skipped
		}
	}
	fs.rmSync(tmp, {force: true});
	const s = statsOf(frames);
	return s ? autoAdjust(s) : null;
};
