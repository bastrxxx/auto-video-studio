/**
 * One-time setup: builds whisper.cpp (via @remotion/install-whisper-cpp) and downloads a model.
 *   npm run setup:whisper            -> model from WHISPER_MODEL env or "small"
 *   npm run setup:whisper -- medium  -> a specific model
 */
import path from 'node:path';
import {downloadWhisperModel, installWhisperCpp, type WhisperModel} from '@remotion/install-whisper-cpp';
import {PATHS, WHISPER_VERSION} from './config.js';

const model = (process.argv[2] || process.env.WHISPER_MODEL || 'small') as WhisperModel;

const main = async () => {
	console.log(`[setup] whisper.cpp ${WHISPER_VERSION} -> ${PATHS.whisper}`);
	await installWhisperCpp({version: WHISPER_VERSION, to: PATHS.whisper, printOutput: true});
	console.log(`[setup] model "${model}"`);
	let last = -1;
	await downloadWhisperModel({
		model,
		folder: PATHS.whisper,
		printOutput: false,
		onProgress: (downloaded, total) => {
			const pct = Math.floor((downloaded / total) * 100);
			if (pct !== last && pct % 5 === 0) {
				last = pct;
				console.log(`[setup] ${model}: ${pct}%`);
			}
		},
	});
	console.log(`[setup] done. Model file in ${path.relative(process.cwd(), PATHS.whisper)}`);
};

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
