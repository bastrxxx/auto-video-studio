// ffmpeg / ffprobe from Remotion's bundled compositor (no system ffmpeg needed).
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {PATHS} from './config.js';

const bin = (name: 'ffmpeg' | 'ffprobe') => {
	const local = path.join(PATHS.compositorDir, name);
	if (fs.existsSync(local)) return local;
	return name; // fall back to PATH
};

export const run = (
	name: 'ffmpeg' | 'ffprobe',
	args: string[],
	opts: {onStderr?: (chunk: string) => void; signal?: AbortSignal} = {},
): Promise<{stdout: string; stderr: string}> =>
	new Promise((resolve, reject) => {
		const p = spawn(bin(name), args, {
			cwd: PATHS.compositorDir,
			env: {...process.env, DYLD_LIBRARY_PATH: PATHS.compositorDir, LD_LIBRARY_PATH: PATHS.compositorDir},
			signal: opts.signal,
		});
		let stdout = '';
		let stderr = '';
		p.stdout.on('data', (d) => (stdout += d.toString()));
		p.stderr.on('data', (d) => {
			const s = d.toString();
			stderr += s;
			if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
			opts.onStderr?.(s);
		});
		p.on('error', reject);
		p.on('close', (code) => {
			if (code === 0) resolve({stdout, stderr});
			else reject(new Error(`${name} exited with ${code}: ${stderr.slice(-1500)}`));
		});
	});

export type Probe = {
	duration: number;
	width: number; // displayed (rotation applied)
	height: number;
	fps: number;
	hasAudio: boolean;
	rotation: number;
	createdAt: number | null; // recording time from the file's metadata (ms since epoch)
};

const parseDate = (v: unknown): number | null => {
	if (typeof v !== 'string' || !v.trim()) return null;
	const t = Date.parse(v.trim().replace(/^(\d{4}-\d\d-\d\d) /, '$1T').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
	if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1)) return null; // 1970 / 1904 placeholders
	return t;
};

export const probe = async (file: string): Promise<Probe> => {
	const {stdout} = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
	const j = JSON.parse(stdout);
	const v = (j.streams || []).find((s: any) => s.codec_type === 'video');
	const a = (j.streams || []).find((s: any) => s.codec_type === 'audio');
	if (!v) throw new Error('File không có luồng video');
	let rotation = 0;
	const sd = (v.side_data_list || []).find((x: any) => x.rotation !== undefined);
	if (sd) rotation = Number(sd.rotation) || 0;
	else if (v.tags?.rotate) rotation = Number(v.tags.rotate) || 0;
	const rot = Math.abs(rotation) % 180 === 90;
	const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
	const fps = d ? n / d : n || 30;
	const tags = {...(v.tags || {}), ...(a?.tags || {}), ...(j.format?.tags || {})} as Record<string, string>;
	const createdAt =
		parseDate(tags['com.apple.quicktime.creationdate']) ??
		parseDate(tags['creation_time']) ??
		parseDate(tags['date']) ??
		parseDate(v.tags?.creation_time);
	return {
		createdAt,
		duration: Number(j.format?.duration || v.duration || 0),
		width: rot ? v.height : v.width,
		height: rot ? v.width : v.height,
		fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
		hasAudio: Boolean(a),
		rotation,
	};
};

/** parse "time=00:01:02.34" progress lines from ffmpeg stderr */
export const parseFfTime = (s: string): number | null => {
	const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
	if (!m) return null;
	return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
};
