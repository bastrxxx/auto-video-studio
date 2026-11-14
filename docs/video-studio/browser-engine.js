// Browser-side fallback engine for GitHub Pages (https://bastrxxx.github.io/auto-video-studio/)
// When the Mac backend server (localhost:8790 or Cloudflare Tunnel) is unreachable, this engine
// runs 100% in the browser and persists all projects, timelines, settings, and video File blobs
// inside IndexedDB (AutoVideoStudioDB).

const AUTH_USER = 'sts';
const AUTH_PASS = '1111';
const IDB_NAME = 'AutoVideoStudioDB';
const IDB_VERSION = 1;

const store = {
	jobs: new Map(),
	timelines: new Map(),
	files: new Map(), // `${jobId}:${clipId}` -> File | Blob
	settings: new Map(),
};

let idbPromise = null;
let hydratedPromise = null;

function openIdb() {
	if (idbPromise) return idbPromise;
	idbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(IDB_NAME, IDB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', {keyPath: 'id'});
			if (!db.objectStoreNames.contains('timelines')) db.createObjectStore('timelines', {keyPath: 'jobId'});
			if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', {keyPath: 'key'});
			if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', {keyPath: 'key'});
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return idbPromise;
}

async function idbGetAll(storeName) {
	try {
		const db = await openIdb();
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, 'readonly');
			const req = tx.objectStore(storeName).getAll();
			req.onsuccess = () => resolve(req.result || []);
			req.onerror = () => reject(req.error);
		});
	} catch {
		return [];
	}
}

async function idbPut(storeName, val) {
	try {
		const db = await openIdb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, 'readwrite');
			tx.objectStore(storeName).put(val);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		if (storeName === 'jobs' && val?.id && window.STS_DB) {
			window.STS_DB.put('auto-video-studio', 'jobs', val.id, {id: val.id, name: val.name, status: val.status, createdAt: val.createdAt}).catch(() => {});
		}
	} catch {}
}

async function idbDelete(storeName, key) {
	try {
		const db = await openIdb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, 'readwrite');
			tx.objectStore(storeName).delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		if (storeName === 'jobs' && window.STS_DB) {
			window.STS_DB.delete('auto-video-studio', 'jobs', key).catch(() => {});
		}
	} catch {}
}

async function idbClear(storeName) {
	try {
		const db = await openIdb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, 'readwrite');
			tx.objectStore(storeName).clear();
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		if (storeName === 'jobs' && window.STS_DB) {
			window.STS_DB.clear('auto-video-studio', 'jobs').catch(() => {});
		}
	} catch {}
}

async function ensureHydrated() {
	if (hydratedPromise) return hydratedPromise;
	hydratedPromise = (async () => {
		const [files, timelines, jobs, settings] = await Promise.all([
			idbGetAll('files'),
			idbGetAll('timelines'),
			idbGetAll('jobs'),
			idbGetAll('settings'),
		]);
		for (const f of files) {
			if (f?.key && f?.blob) store.files.set(f.key, f.blob);
		}
		for (const t of timelines) {
			if (t?.jobId && t?.timeline) store.timelines.set(t.jobId, t.timeline);
		}
		for (const s of settings) {
			if (s?.key) store.settings.set(s.key, s.value);
		}
		const AVS = window.AVS;
		for (const j of jobs) {
			if (!j?.id) continue;
			// Rebuild fresh object URLs for each clip from IndexedDB binary Blob
			for (const c of j.clips || []) {
				const blob = store.files.get(`${j.id}:${c.id}`);
				if (blob) c.url = URL.createObjectURL(blob);
			}
			if (j.state === 'running' || j.state === 'queued') {
				j.state = 'done';
				j.step = 'done';
				j.progress = 1;
			}
			const tl = store.timelines.get(j.id);
			if (tl && AVS?.compile) {
				try {
					const plan = AVS.compile(tl, buildCtxForJob(j));
					const srtBlob = new Blob([AVS.timelineToSrt(plan)], {type: 'text/plain;charset=utf-8'});
					const planBlob = new Blob([JSON.stringify(plan, null, 2)], {type: 'application/json'});
					j.result = {
						duration: plan.durationInFrames / plan.fps,
						original: (j.clips || []).reduce((a, c) => a + c.duration, 0),
						video: j.clips?.[0]?.url || '',
						srt: URL.createObjectURL(srtBlob),
						plan: URL.createObjectURL(planBlob),
						renderedAt: j.result?.renderedAt || Date.now(),
						renderSeconds: j.result?.renderSeconds || 1,
					};
				} catch {}
			}
			store.jobs.set(j.id, j);
		}
	})();
	return hydratedPromise;
}

async function persistJob(job) {
	store.jobs.set(job.id, job);
	await idbPut('jobs', JSON.parse(JSON.stringify(job)));
}

async function persistTimeline(jobId, timeline) {
	store.timelines.set(jobId, timeline);
	await idbPut('timelines', {jobId, timeline: JSON.parse(JSON.stringify(timeline)), updatedAt: Date.now()});
}

function browserDbStats() {
	return {
		engine: 'IndexedDB (AutoVideoStudioDB)',
		file: 'IndexedDB://AutoVideoStudioDB',
		jobs: store.jobs.size,
		docs: store.timelines.size,
		files: store.files.size,
	};
}

const probeVideoFile = (file) =>
	new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const v = document.createElement('video');
		v.preload = 'metadata';
		v.muted = true;
		v.playsInline = true;
		v.onloadedmetadata = () => {
			resolve({
				url,
				duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 10,
				width: v.videoWidth || 1080,
				height: v.videoHeight || 1920,
				hasAudio: true,
			});
		};
		v.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error(`Không đọc được video “${file.name}”`));
		};
		v.src = url;
	});

/** Measure auto-color directly in the browser using <canvas> on 5 frames of the video */
const analyzeBrowserColor = async (url, duration, width, height) => {
	const AVS = window.AVS;
	if (!AVS?.color?.statsOf) return null;
	const v = document.createElement('video');
	v.muted = true;
	v.playsInline = true;
	v.crossOrigin = 'anonymous';
	v.src = url;
	await new Promise((res) => {
		v.onloadeddata = res;
		v.onerror = res;
	});
	const W = 64;
	const H = Math.max(2, Math.round((W * height) / Math.max(1, width)));
	const c = document.createElement('canvas');
	c.width = W;
	c.height = H;
	const ctx = c.getContext('2d', {willReadFrequently: true});
	const frames = [];
	const n = 5;
	for (let i = 0; i < n; i++) {
		const t = (duration * (i + 0.5)) / n;
		await new Promise((res) => {
			const to = setTimeout(res, 1500);
			v.onseeked = () => {
				clearTimeout(to);
				res();
			};
			v.currentTime = Math.min(duration - 0.05, Math.max(0, t));
		});
		try {
			ctx.drawImage(v, 0, 0, W, H);
			const rgba = ctx.getImageData(0, 0, W, H).data;
			const rgb = new Uint8Array((rgba.length / 4) * 3);
			for (let p = 0, q = 0; p < rgba.length; p += 4) {
				rgb[q++] = rgba[p];
				rgb[q++] = rgba[p + 1];
				rgb[q++] = rgba[p + 2];
			}
			frames.push(rgb);
		} catch {}
	}
	const s = AVS.color.statsOf(frames);
	return s ? AVS.color.autoAdjust(s) : null;
};

/** Detect silences using Web Audio API */
const detectBrowserSilences = async (file, duration) => {
	try {
		const ab = await file.arrayBuffer();
		const ac = new (window.AudioContext || window.webkitAudioContext)();
		const audio = await ac.decodeAudioData(ab);
		const ch = audio.getChannelData(0);
		const sr = audio.sampleRate;
		const win = Math.max(1, Math.floor(sr * 0.05)); // 50ms windows
		const db = [];
		for (let i = 0; i < ch.length; i += win) {
			let sum = 0;
			const end = Math.min(ch.length, i + win);
			for (let j = i; j < end; j++) sum += ch[j] * ch[j];
			const rms = Math.sqrt(sum / Math.max(1, end - i));
			db.push(20 * Math.log10(Math.max(1e-5, rms)));
		}
		await ac.close().catch(() => {});
		const thresh = -34;
		const silences = [];
		let s0 = null;
		for (let i = 0; i < db.length; i++) {
			const t = i * 0.05;
			if (db[i] < thresh) {
				if (s0 === null) s0 = t;
			} else if (s0 !== null) {
				if (t - s0 >= 0.28) silences.push([+s0.toFixed(2), +t.toFixed(2)]);
				s0 = null;
			}
		}
		if (s0 !== null && duration - s0 >= 0.28) silences.push([+s0.toFixed(2), +duration.toFixed(2)]);
		return silences;
	} catch {
		return [];
	}
};

/** Optional Gemini multimodal transcription in the browser when user provides Gemini API key */
const transcribeWithGeminiBrowser = async (file, duration, opts) => {
	if (!opts.geminiKey || file.size > 18 * 1024 * 1024) return null;
	const b64 = await new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result).split(',')[1]);
		r.onerror = reject;
		r.readAsDataURL(file);
	});
	const prompt = `Bạn là chuyên gia nhận dạng giọng nói tiếng Việt. Hãy chép lời chính xác từng câu ngắn (3-6 từ mỗi câu) kèm mốc thời gian bắt đầu (start) và kết thúc (end) tính bằng giây (từ 0 đến ${duration.toFixed(1)}).
${opts.brief ? `Ngữ cảnh / Ý tưởng video: ${opts.brief}` : ''}
Trả về đúng định dạng JSON: {"sentences":[{"start":0.2,"end":1.8,"text":"Xin chào các bạn","keyword":"chào"}]}`;
	const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(opts.geminiKey)}`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({
			contents: [{parts: [{inlineData: {mimeType: file.type || 'video/mp4', data: b64}}, {text: prompt}]}],
			generationConfig: {responseMimeType: 'application/json', temperature: 0.1},
		}),
	});
	if (!res.ok) return null;
	const j = await res.json();
	const txt = j.candidates?.[0]?.content?.parts?.[0]?.text;
	if (!txt) return null;
	return JSON.parse(txt).sentences || null;
};

const buildCtxForJob = (job) => ({
	opts: job.options,
	clips: job.clips.map((c) => ({
		id: c.id,
		url: c.url,
		width: c.width,
		height: c.height,
		duration: c.duration,
		color: c.color || null,
	})),
	faces: job.faces || {},
	sfx: {},
	music: [],
	seed: job.version || 1,
});

export async function handleBrowserUpload(files, meta, existingJobId) {
	await ensureHydrated();
	let job = existingJobId ? store.jobs.get(existingJobId) : null;
	if (!job) {
		const id = `web-${Date.now().toString(36)}`;
		const AVS = window.AVS;
		job = {
			id,
			name: files[0]?.name || 'video',
			createdAt: Date.now(),
			clips: [],
			faces: {},
			state: 'uploaded',
			step: 'upload',
			progress: 0,
			message: 'Đã lưu vào database trình duyệt (IndexedDB)',
			log: [],
			options: {...(AVS?.DEFAULT_OPTIONS || {})},
			version: 0,
		};
		store.jobs.set(id, job);
	}
	const added = [];
	for (let i = 0; i < files.length; i++) {
		const f = files[i];
		const pr = await probeVideoFile(f);
		let n = job.clips.length;
		let cid = `c${n}`;
		while (job.clips.some((c) => c.id === cid)) cid = `c${++n}`;
		const fKey = `${job.id}:${cid}`;
		store.files.set(fKey, f);
		await idbPut('files', {key: fKey, jobId: job.id, clipId: cid, name: f.name, blob: f, updatedAt: Date.now()});
		const clip = {
			id: cid,
			name: f.name,
			url: pr.url,
			duration: pr.duration,
			width: pr.width,
			height: pr.height,
			recordedAt: meta[i]?.lastModified || f.lastModified || null,
			fileModified: meta[i]?.lastModified || f.lastModified || null,
			hasAudio: pr.hasAudio,
			color: null,
		};
		job.clips.push(clip);
		added.push(cid);
	}
	job.name = job.clips.length > 1 ? `${job.clips[0].name} +${job.clips.length - 1}` : job.clips[0]?.name || job.name;
	await persistJob(job);
	return {ok: true, id: job.id, added, job};
}

async function runBrowserPipeline(job, mode = 'auto') {
	const AVS = window.AVS;
	const log = (s) => {
		job.log.push(`[${new Date().toLocaleTimeString('vi-VN')}] ${s}`);
		job.message = s;
	};
	try {
		job.state = 'running';
		job.version++;
		await persistJob(job);
		if (mode === 'timeline' && store.timelines.has(job.id)) {
			job.step = 'plan';
			job.progress = 0.7;
			log('Biên dịch timeline & cập nhật vào IndexedDB...');
			const tl = store.timelines.get(job.id);
			const plan = AVS.compile(tl, buildCtxForJob(job));
			const srtBlob = new Blob([AVS.timelineToSrt(plan)], {type: 'text/plain;charset=utf-8'});
			const planBlob = new Blob([JSON.stringify(plan, null, 2)], {type: 'application/json'});
			job.result = {
				duration: plan.durationInFrames / plan.fps,
				original: job.clips.reduce((a, c) => a + c.duration, 0),
				video: job.clips[0]?.url || '',
				srt: URL.createObjectURL(srtBlob),
				plan: URL.createObjectURL(planBlob),
				renderedAt: Date.now(),
				renderSeconds: 1,
			};
			job.state = 'done';
			job.step = 'done';
			job.progress = 1;
			log('Hoàn tất cập nhật timeline & lưu vào database!');
			await persistJob(job);
			return;
		}

		// 1. Prep + Auto Color
		job.step = 'prep';
		job.progress = 0.15;
		log('Đo màu tự động & phân tích khung hình từng clip...');
		for (const c of job.clips) {
			if (!c.color) c.color = await analyzeBrowserColor(c.url, c.duration, c.width, c.height);
		}

		// 2. Order clips
		job.step = 'order';
		job.progress = 0.3;
		const ordered = [...job.clips];
		if (job.options.order === 'name') ordered.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
		else if (job.options.order === 'manual' && job.options.manualOrder?.length) {
			ordered.sort((a, b) => job.options.manualOrder.indexOf(a.id) - job.options.manualOrder.indexOf(b.id));
		} else {
			ordered.sort((a, b) => (a.recordedAt || Infinity) - (b.recordedAt || Infinity));
		}
		job.order = {ids: ordered.map((c) => c.id), reasons: {}, method: 'trình duyệt'};

		// 3. Silences & Transcription
		job.step = 'transcribe';
		job.progress = 0.55;
		const segments = [];
		const captions = [];
		for (const c of ordered) {
			const file = store.files.get(`${job.id}:${c.id}`);
			log(`Phân tích âm thanh & khoảng lặng: ${c.name}...`);
			const silences = file ? await detectBrowserSilences(file, c.duration) : [];
			let cur = 0;
			const takes = [];
			if (job.options.removeSilence && silences.length) {
				for (const [s, e] of silences) {
					if (s - cur >= 0.25) takes.push([Math.max(0, cur - 0.06), Math.min(c.duration, s + 0.08)]);
					cur = e;
				}
				if (c.duration - cur >= 0.25) takes.push([Math.max(0, cur - 0.06), c.duration]);
			}
			if (!takes.length) takes.push([0, c.duration]);
			for (const [a, b] of takes) segments.push({id: AVS.tlId(), clip: c.id, a: +a.toFixed(2), b: +b.toFixed(2)});

			let sentences = null;
			if (file && job.options.geminiKey) {
				log(`Nhận dạng tiếng Việt bằng Gemini AI: ${c.name}...`);
				sentences = await transcribeWithGeminiBrowser(file, c.duration, job.options).catch(() => null);
			}
			if (sentences?.length) {
				for (const s of sentences) {
					const cap = AVS.retimeCaption({id: AVS.tlId(), clip: c.id, words: []}, s.text, s.start, s.end);
					if (s.keyword) {
						for (const w of cap.words) if (w.text.toLowerCase().includes(s.keyword.toLowerCase())) w.keyword = true;
					}
					captions.push(cap);
				}
			} else {
				takes.forEach(([a, b]) => {
					const dur = b - a;
					const step = Math.min(3.0, Math.max(1.5, dur));
					for (let t = a; t < b - 0.2; t += step) {
						const end = Math.min(b, t + step);
						captions.push(AVS.retimeCaption({id: AVS.tlId(), clip: c.id, words: []}, `Câu phụ đề #${captions.length + 1} (bấm để sửa chữ)`, +t.toFixed(2), +end.toFixed(2)));
					}
				});
			}
		}

		// 4. Build Timeline & EditPlan
		job.step = 'plan';
		job.progress = 0.85;
		const tl = {
			version: 1,
			segments,
			captions,
			beats: [],
			title: job.options.title ? {text: job.options.title, dur: 2.6} : null,
			cta: job.options.cta ? {text: job.options.cta, dur: 2.6} : null,
		};
		await persistTimeline(job.id, tl);
		const plan = AVS.compile(tl, buildCtxForJob(job));
		const srtBlob = new Blob([AVS.timelineToSrt(plan)], {type: 'text/plain;charset=utf-8'});
		const planBlob = new Blob([JSON.stringify(plan, null, 2)], {type: 'application/json'});
		const origDur = job.clips.reduce((a, c) => a + c.duration, 0);
		const outDur = plan.durationInFrames / plan.fps;
		job.stats = {silence: Math.max(0, Math.round((origDur - outDur) * 3))};
		job.result = {
			duration: outDur,
			original: origDur,
			video: ordered[0]?.url || '',
			srt: URL.createObjectURL(srtBlob),
			plan: URL.createObjectURL(planBlob),
			renderedAt: Date.now(),
			renderSeconds: 1,
		};
		job.state = 'done';
		job.step = 'done';
		job.progress = 1;
		log(`Hoàn tất! Đã tạo ${segments.length} đoạn cắt, ${captions.length} câu phụ đề & lưu vào IndexedDB.`);
		await persistJob(job);
	} catch (e) {
		job.state = 'error';
		job.error = e.message;
		log(`LỖI: ${e.message}`);
		await persistJob(job);
	}
}

export async function handleBrowserApi(url, opts = {}) {
	await ensureHydrated();
	const method = (opts.method || 'GET').toUpperCase();
	const body = opts.body || {};
	const AVS = window.AVS;

	if (url === '/api/auth') {
		const authed = localStorage.getItem('avs.browser_auth') === '1' || store.settings.get('auth') === AUTH_USER;
		return {ok: true, authenticated: authed, user: authed ? AUTH_USER : null, browserMode: true};
	}
	if (url === '/api/login') {
		if (String(body.username || '').trim() === AUTH_USER && String(body.password || '').trim() === AUTH_PASS) {
			localStorage.setItem('avs.browser_auth', '1');
			store.settings.set('auth', AUTH_USER);
			await idbPut('settings', {key: 'auth', value: AUTH_USER, updatedAt: Date.now()});
			return {ok: true, user: AUTH_USER, token: 'browser-token'};
		}
		throw new Error('Sai tài khoản hoặc mật khẩu');
	}
	if (url === '/api/logout') {
		localStorage.removeItem('avs.browser_auth');
		store.settings.delete('auth');
		await idbDelete('settings', 'auth');
		return {ok: true};
	}
	if (url === '/api/info') {
		const styles = Object.values(AVS?.STYLES || {}).map((s) => ({id: s.id, name: s.name, about: s.about, accent: s.accent, font: s.caption.font}));
		return {
			ok: true,
			browserMode: true,
			whisper: true,
			models: ['large-v3'],
			downloading: null,
			music: [],
			sfx: 10,
			styles,
			defaults: AVS?.DEFAULT_OPTIONS || {},
			savedOptions: store.settings.get('user_options') || null,
			db: browserDbStats(),
		};
	}
	if (url === '/api/db') {
		return {ok: true, db: browserDbStats()};
	}
	if (url === '/api/settings' && method === 'PUT') {
		if (body.options && typeof body.options === 'object') {
			const prev = store.settings.get('user_options') || {};
			const next = {...prev, ...body.options};
			store.settings.set('user_options', next);
			await idbPut('settings', {key: 'user_options', value: next, updatedAt: Date.now()});
		}
		return {ok: true, db: browserDbStats()};
	}
	if (url === '/api/jobs' && method === 'GET') {
		return {ok: true, jobs: [...store.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)};
	}
	if (url === '/api/jobs' && method === 'DELETE') {
		store.jobs.clear();
		store.timelines.clear();
		store.files.clear();
		await Promise.all([idbClear('jobs'), idbClear('timelines'), idbClear('files')]);
		return {ok: true};
	}
	let m;
	if ((m = /^\/api\/jobs\/([^/]+)$/.exec(url))) {
		const id = m[1];
		if (method === 'DELETE') {
			const job = store.jobs.get(id);
			if (job) {
				for (const c of job.clips || []) {
					store.files.delete(`${id}:${c.id}`);
					await idbDelete('files', `${id}:${c.id}`);
				}
			}
			store.jobs.delete(id);
			store.timelines.delete(id);
			await Promise.all([idbDelete('jobs', id), idbDelete('timelines', id)]);
			return {ok: true};
		}
		const job = store.jobs.get(id);
		if (!job) throw new Error('Không tìm thấy dự án');
		return {ok: true, job};
	}
	if ((m = /^\/api\/jobs\/([^/]+)\/clips\/([^/]+)$/.exec(url)) && method === 'DELETE') {
		const id = m[1];
		const cid = m[2];
		const job = store.jobs.get(id);
		if (job) {
			store.files.delete(`${id}:${cid}`);
			await idbDelete('files', `${id}:${cid}`);
			job.clips = job.clips.filter((c) => c.id !== cid);
			if (!job.clips.length) {
				store.jobs.delete(id);
				store.timelines.delete(id);
				await Promise.all([idbDelete('jobs', id), idbDelete('timelines', id)]);
			} else {
				await persistJob(job);
			}
		}
		return {ok: true};
	}
	if ((m = /^\/api\/jobs\/([^/]+)\/start$/.exec(url))) {
		const job = store.jobs.get(m[1]);
		if (!job) throw new Error('Không tìm thấy dự án');
		job.options = {...job.options, ...(body.options || {})};
		if (body.face) job.faces = {...job.faces, ...body.face};
		await persistJob(job);
		setTimeout(() => runBrowserPipeline(job, 'auto'), 50);
		return {ok: true, id: job.id};
	}
	if ((m = /^\/api\/jobs\/([^/]+)\/render$/.exec(url))) {
		const job = store.jobs.get(m[1]);
		if (!job) throw new Error('Không tìm thấy dự án');
		job.options = {...job.options, ...(body.options || {})};
		if (body.timeline) await persistTimeline(job.id, body.timeline);
		await persistJob(job);
		setTimeout(() => runBrowserPipeline(job, 'timeline'), 50);
		return {ok: true, id: job.id};
	}
	if ((m = /^\/api\/jobs\/([^/]+)\/detail$/.exec(url))) {
		const job = store.jobs.get(m[1]);
		if (!job) throw new Error('Không tìm thấy dự án');
		const tl = store.timelines.get(m[1]);
		return {
			ok: true,
			job,
			words: [],
			status: [],
			sentences: [],
			clipRanges: [],
			takes: tl ? tl.segments.map((s) => ({a: s.a, b: s.b})) : [],
			planSummary: tl ? {groups: tl.captions.length, beats: tl.beats, duration: job.result?.duration || 0} : null,
		};
	}
	if ((m = /^\/api\/jobs\/([^/]+)\/timeline$/.exec(url))) {
		const job = store.jobs.get(m[1]);
		if (!job) throw new Error('Không tìm thấy dự án');
		if (method === 'PUT') {
			await persistTimeline(job.id, body.timeline);
			if (body.options) {
				job.options = {...job.options, ...body.options};
				await persistJob(job);
			}
			return {ok: true};
		}
		const timeline = store.timelines.get(job.id);
		if (!timeline) throw new Error('Chưa có timeline');
		return {ok: true, timeline, ctx: buildCtxForJob(job), clips: job.clips};
	}
	return {ok: true};
}
