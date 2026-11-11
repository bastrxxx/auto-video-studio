// Step 6: render the plan with Remotion (headless Chrome + the bundled ffmpeg).
import {bundle} from '@remotion/bundler';
import {ensureBrowser, makeCancelSignal, renderMedia, selectComposition} from '@remotion/renderer';
import os from 'node:os';
import {PATHS} from '../config.js';
import type {EditPlan, JobOptions} from '../../shared/types.js';

let bundlePromise: Promise<string> | null = null;

export const getBundle = (log?: (s: string) => void) => {
	if (!bundlePromise) {
		log?.('Đang đóng gói Remotion (chỉ lần đầu)...');
		bundlePromise = bundle({
			entryPoint: PATHS.remotionEntry,
			publicDir: PATHS.public,
			onProgress: () => undefined,
		}).catch((e) => {
			bundlePromise = null;
			throw e;
		});
	}
	return bundlePromise;
};

let browserReady: Promise<unknown> | null = null;
export const prepareBrowser = (log?: (s: string) => void) => {
	if (!browserReady) {
		log?.('Kiểm tra Chrome Headless Shell cho Remotion (lần đầu sẽ tự tải)...');
		browserReady = ensureBrowser().catch((e) => {
			browserReady = null;
			throw e;
		});
	}
	return browserReady;
};

export const renderPlan = async (
	plan: EditPlan,
	out: string,
	quality: JobOptions['quality'],
	onProgress: (p: number, stage: string) => void,
	signal?: AbortSignal,
) => {
	await prepareBrowser((s) => onProgress(0, s));
	const serveUrl = await getBundle((s) => onProgress(0, s));
	const inputProps = {plan};
	const composition = await selectComposition({serveUrl, id: 'AutoEdit', inputProps});
	const {cancelSignal, cancel} = makeCancelSignal();
	if (signal) {
		if (signal.aborted) cancel();
		else signal.addEventListener('abort', () => cancel(), {once: true});
	}
	await renderMedia({
		composition,
		serveUrl,
		codec: 'h264',
		outputLocation: out,
		inputProps,
		crf: quality === 'high' ? 16 : quality === 'draft' ? 26 : 20,
		x264Preset: quality === 'high' ? 'medium' : quality === 'draft' ? 'ultrafast' : 'veryfast',
		scale: quality === 'draft' ? 0.5 : 1,
		jpegQuality: quality === 'draft' ? 70 : 92,
		audioBitrate: '192k',
		concurrency: Math.max(2, Math.min(8, os.cpus().length - 2)),
		imageFormat: 'jpeg',
		chromiumOptions: {gl: 'angle'},
		timeoutInMilliseconds: 120_000,
		offthreadVideoCacheSizeInBytes: 1024 * 1024 * 1024,
		cancelSignal,
		onProgress: ({progress, stitchStage}) => onProgress(progress, stitchStage === 'muxing' ? 'Ghép âm thanh' : 'Đang render'),
	});
};
