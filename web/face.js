// Face scan in the browser (MediaPipe Face Landmarker, the model ghost-editor bundles).
// Samples the local file a few times per second and returns normalised face boxes + eyes/mouth/chin lines.
let landmarkerPromise = null;

const getLandmarker = async () => {
	if (!landmarkerPromise) {
		landmarkerPromise = (async () => {
			const base = window.AVS_BASE || '.';
			let mod;
			let wasmPath = `${base}/vendor/mediapipe/wasm`;
			try {
				mod = await import(`${base}/vendor/mediapipe/vision_bundle.mjs`);
			} catch {
				mod = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs');
				wasmPath = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
			}
			const {FilesetResolver, FaceLandmarker} = mod;
			const fileset = await FilesetResolver.forVisionTasks(wasmPath);
			const make = (delegate) =>
				FaceLandmarker.createFromOptions(fileset, {
					baseOptions: {modelAssetPath: `${base}/models/face_landmarker.task`, delegate},
					runningMode: 'IMAGE',
					numFaces: 1,
				});
			try {
				return await make('GPU');
			} catch {
				return await make('CPU');
			}
		})().catch((e) => {
			landmarkerPromise = null;
			throw e;
		});
	}
	return landmarkerPromise;
};

const seek = (video, t) =>
	new Promise((resolve, reject) => {
		const to = setTimeout(() => reject(new Error('seek timeout')), 8000);
		video.addEventListener(
			'seeked',
			() => {
				clearTimeout(to);
				resolve();
			},
			{once: true},
		);
		video.currentTime = t;
	});

export async function scanFaces(file, onProgress, signal) {
	const lm = await getLandmarker();
	const url = URL.createObjectURL(file);
	const video = document.createElement('video');
	video.muted = true;
	video.playsInline = true;
	video.preload = 'auto';
	video.src = url;
	try {
		await new Promise((resolve, reject) => {
			video.onloadeddata = resolve;
			video.onerror = () => reject(new Error('Trình duyệt không giải mã được video này (bỏ qua bám mặt)'));
		});
		const dur = video.duration || 0;
		const step = dur <= 60 ? 0.25 : Math.max(0.33, dur / 420);
		const W = 480;
		const H = Math.round((W * video.videoHeight) / Math.max(1, video.videoWidth));
		const canvas = document.createElement('canvas');
		canvas.width = W;
		canvas.height = H;
		const ctx = canvas.getContext('2d', {willReadFrequently: true});
		const out = [];
		for (let t = 0; t < dur; t += step) {
			if (signal?.aborted) throw new Error('aborted');
			await seek(video, Math.min(t, dur - 0.05));
			ctx.drawImage(video, 0, 0, W, H);
			const r = lm.detect(canvas);
			const pts = r.faceLandmarks?.[0];
			if (pts && pts.length > 400) {
				let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
				for (const p of pts) {
					if (p.x < x0) x0 = p.x;
					if (p.y < y0) y0 = p.y;
					if (p.x > x1) x1 = p.x;
					if (p.y > y1) y1 = p.y;
				}
				// the mesh top is the forehead line: extend up ~18 % for the hair
				const h = y1 - y0;
				const top = Math.max(0, y0 - h * 0.18);
				out.push({
					t: +t.toFixed(3),
					x: +x0.toFixed(4),
					y: +top.toFixed(4),
					w: +(x1 - x0).toFixed(4),
					h: +(y1 - top).toFixed(4),
					eye: +((pts[159].y + pts[386].y) / 2).toFixed(4),
					mouth: +((pts[13].y + pts[14].y) / 2).toFixed(4),
					chin: +pts[152].y.toFixed(4),
				});
			}
			onProgress?.(Math.min(1, t / dur), out.length);
		}
		onProgress?.(1, out.length);
		return out;
	} finally {
		URL.revokeObjectURL(url);
	}
}
