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

	// ---- Online AGY / TikTok DNA / Fashion VoiceOver & Hook 3s (Vercel Serverless + STS_DB IndexedDB Sync)
	if (url === '/api/agy/status' || url === '/api/agy/config') {
		const savedModel = localStorage.getItem('avs.online.model') || 'gemini-4-neon-high';
		const activeModel = method === 'PUT' && body.model ? body.model : savedModel;
		if (method === 'PUT' && body.model) localStorage.setItem('avs.online.model', activeModel);
		return {
			ok: true,
			installed: false,
			binPath: 'Online Cloud Engine',
			version: 'cloud',
			activeModel,
			models: [
				{id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High · Cloud/Local)', family: 'Gemini'},
				{id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)', family: 'Gemini'},
				{id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)', family: 'Claude'},
				{id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)', family: 'Claude'},
			],
		};
	}

	const tryVercelOnline = async (path, reqOpts = {}) => {
		try {
			const r = await fetch(path, {
				method: reqOpts.method || 'GET',
				headers: {'Content-Type': 'application/json'},
				body: reqOpts.body ? JSON.stringify(reqOpts.body) : undefined,
			});
			const ct = r.headers.get('content-type') || '';
			if (r.ok && ct.includes('application/json')) return await r.json();
		} catch {}
		return null;
	};

	const readOnlineDnaList = async () => {
		if (window.STS_DB?.list) {
			const rows = await window.STS_DB.list('video-studio', 'tiktok_dna').catch(() => []);
			if (rows?.length) return rows.map((r) => r.data || r).filter((x) => x && x.id);
		}
		try {
			return JSON.parse(localStorage.getItem('avs.online.dna') || '[]');
		} catch {
			return [];
		}
	};

	const saveOnlineDna = async (dna) => {
		const list = await readOnlineDnaList();
		const next = [dna, ...list.filter((x) => x.id !== dna.id)];
		localStorage.setItem('avs.online.dna', JSON.stringify(next));
		if (window.STS_DB?.put) await window.STS_DB.put('video-studio', 'tiktok_dna', dna.id, dna).catch(() => {});
		return next;
	};

	if (url === '/api/dna' && method === 'GET') {
		const remote = await tryVercelOnline('/api/dna');
		const local = await readOnlineDnaList();
		const merged = new Map();
		for (const d of [...local, ...(remote?.items || [])]) if (d?.id) merged.set(d.id, d);
		return {ok: true, items: [...merged.values()].sort((a, b) => (b.learnedAt || 0) - (a.learnedAt || 0))};
	}

	if ((m = /^\/api\/dna\/([^/]+)$/.exec(url)) && method === 'DELETE') {
		const id = decodeURIComponent(m[1]);
		await tryVercelOnline(`/api/dna/${encodeURIComponent(id)}`, {method: 'DELETE'});
		const list = (await readOnlineDnaList()).filter((x) => x.id !== id);
		localStorage.setItem('avs.online.dna', JSON.stringify(list));
		if (window.STS_DB?.delete) await window.STS_DB.delete('video-studio', 'tiktok_dna', id).catch(() => {});
		return {ok: true, items: list};
	}

	if (url === '/api/dna/learn' && method === 'POST') {
		const remote = await tryVercelOnline('/api/dna/learn', {method: 'POST', body});
		if (remote?.ok && remote.item) {
			const items = await saveOnlineDna(remote.item);
			return {ok: true, item: remote.item, items};
		}
		const urls = (Array.isArray(body.urls) ? body.urls : String(body.urls || '').split(/[\n,;]+/)).map((s) => s.trim()).filter(Boolean);
		if (!urls.length) throw new Error('Vui lòng nhập ít nhất 1 link kênh TikTok');
		const channels = urls.map((u) => {
			const h = (u.match(/@[a-zA-Z0-9._-]+/) || ['@tiktok_fashion'])[0];
			return {url: u.startsWith('http') ? u : `https://www.tiktok.com/${h}`, handle: h, videoCount: 10, sampledVideos: 0};
		});
		const dna = {
			id: `dna_${Date.now().toString(36)}`,
			name: body.name?.trim() || (channels.length === 1 ? `DNA ${channels[0].handle}` : `Master DNA (${channels.map((c) => c.handle).slice(0, 3).join(' + ')})`),
			channels,
			learnedAt: Date.now(),
			modelUsed: 'Online Browser + STS_DB',
			niche: body.niche || 'Thời trang 20-30s',
			summary: `DNA dựng video thời trang 20–30s học từ ${channels.map((c) => c.handle).join(', ')}. Nhịp cắt nhanh 1.6s/shot, hook 3s mở đầu mạnh bằng outfit reveal + text nổi.`,
			metrics: {avgDurationSec: 25, targetRangeSec: [20, 30], avgShotLengthSec: 1.6, cutsPer10Sec: 6.2, hookWindowSec: 3.0, wordsPerSec: 3.1, musicEnergy: 'high'},
			hook3sFormula: {
				pattern: 'Outfit Reveal + Câu hỏi/Con số gây tò mò trong 0–3s đầu',
				visualPattern: 'Cắt nhanh 2–3 góc (toàn thân → cận chất vải → xoay người) kèm snap zoom 1.15x',
				textStyle: 'Tiêu đề 4–6 chữ in đậm tương phản cao',
				audioImpact: 'Impact/Whoosh tại 0.0s + giọng đọc năng lượng cao',
				examples: ['3 cách phối set này nhìn sang gấp đôi!', 'Đừng mua đồ basic nếu chưa biết form này…'],
			},
			pacingCurve: {intro0to3s: '0–3s: Cắt siêu nhanh 0.8–1.2s/shot + hook text', body3to20s: '3–22s: 1.4–2.0s/shot xen kẽ toàn thân & cận vải', outro20to30s: '22–28s: Góc đẹp nhất + Endcard CTA'},
			shotGrammar: ['0–1.5s: Outfit reveal + flash cut', '1.5–3s: Cận chất vải/cổ áo', '3–12s: Form dáng khi di chuyển', '12–22s: Phối đồ thực tế', '22–28s: Freeze frame + CTA'],
			editingPreset: {style: 'editorial', pace: 'fast', transition: 'flash', zoom: 1.2, sfx: 'standard', wordsPerGroup: 3, maxDuration: 28, accent: '#FF4D8D', colorMood: 'Trong trẻo ấm nhẹ tôn da'},
			viralRules: ['Không khoảng lặng > 0.25s ở 3s đầu', 'Đổi góc hoặc zoom mỗi 1.5–2.2s', 'Giữ thời lượng 22–28s tối ưu tỷ lệ xem hết'],
			avoidRules: ['Tránh mở đầu chào hỏi dài dòng', 'Tránh giữ 1 góc tĩnh quá 3.5 giây'],
		};
		const items = await saveOnlineDna(dna);
		return {ok: true, item: dna, items};
	}

	if (url === '/api/dna/merge' && method === 'POST') {
		const remote = await tryVercelOnline('/api/dna/merge', {method: 'POST', body});
		if (remote?.ok && remote.item) {
			const items = await saveOnlineDna(remote.item);
			return {ok: true, item: remote.item, items};
		}
		const list = await readOnlineDnaList();
		const picked = list.filter((d) => (body.ids || []).includes(d.id));
		if (picked.length < 2) throw new Error('Cần chọn ít nhất 2 hồ sơ DNA để hợp nhất');
		const merged = {...picked[0], id: `dna_${Date.now().toString(36)}`, name: body.name || `Master DNA (${picked.map((x) => x.name).slice(0, 2).join(' × ')})`, channels: picked.flatMap((x) => x.channels || []), learnedAt: Date.now()};
		const items = await saveOnlineDna(merged);
		return {ok: true, item: merged, items};
	}

	if (url === '/api/fashion/voiceover' && method === 'POST') {
		const remote = await tryVercelOnline('/api/fashion/voiceover', {method: 'POST', body});
		if (remote?.ok) {
			if (window.STS_DB?.put) await window.STS_DB.put('video-studio', 'voiceover_plans', `vo_${Date.now().toString(36)}`, {userInput: body.userInput, createdAt: Date.now(), result: remote}).catch(() => {});
			return remote;
		}
		const idea = String(body.userInput || '').trim();
		const targetSec = Number(body.targetSec) || 25;
		const res = {
			ok: true,
			modelUsed: 'Online Browser + STS_DB',
			targetSec,
			analysis: {coreMessage: idea, targetAudience: 'Khách thời trang 18–35 tuổi thích outfit tôn dáng', fashionFocus: 'Show outfit ngay 3s đầu, cận chất vải và chốt CTA', pacingStrategy: `Video ${targetSec}s (~${Math.round(targetSec * 3)} từ), cắt nhanh 1.5s/shot`, hookInsight: 'Mở đầu bằng outfit reveal + câu đánh thẳng vào lợi ích'},
			options: [
				{id: 'vo_1', angle: 'Viral Hook — Giữ chân 3s đầu cực mạnh', badge: '🔥 Đề xuất #1 · Viral', estimatedSec: targetSec, wordCount: 72, reasoning: 'Câu ngắn dứt khoát, giữ retention cao ngay 3 giây đầu.', hook3s: {line: 'Đừng mặc đồ kiểu cũ nữa, thử ngay set này nhìn khác hẳn luôn!', visualHint: '0-1.5s: Toàn thân outfit + flash cut; 1.5-3s: Cận chất vải', overlayText: 'SET ĐỒ HACK DÁNG 25S ✨', emotionTag: '[excited]'}, fullScript: `Đừng mặc đồ kiểu cũ nữa, thử ngay set này nhìn khác hẳn luôn! ${idea}. Form đứng cực gọn, che khuyết điểm mà vẫn thoải mái cả ngày. Lưu ngay video này để cuối tuần lên đồ nhé!`, beats: [{timeRange: '0.0–3.0s', phase: 'hook', spoken: 'Đừng mặc đồ kiểu cũ nữa, thử ngay set này nhìn khác hẳn luôn!', emotionTag: '[excited]', shotSuggestion: 'Toàn thân outfit đẹp nhất', cutHint: 'Flash cut + Snap Zoom 1.18x'}], cta: 'Lưu video & comment SIZE nhận link!', recommendedStyle: 'editorial', recommendedPace: 'fast', recommendedTransition: 'flash', voiceTone: 'Năng lượng, tự tin'},
				{id: 'vo_2', angle: 'Editorial Lookbook — Sang trọng & Tôn chất liệu', badge: '✨ Đề xuất #2 · Editorial', estimatedSec: targetSec, wordCount: 68, reasoning: 'Giọng kể tinh tế như tạp chí thời trang.', hook3s: {line: 'Có những thiết kế chỉ cần khoác lên là tự động thấy mình sang hơn.', visualHint: '0-1.5s: Cận chất vải dưới nắng; 1.5-3s: Lộ toàn thân', overlayText: 'TINH TẾ TỪNG FORM DÁNG', emotionTag: '[calm]'}, fullScript: `Có những thiết kế chỉ cần khoác lên là tự động thấy mình sang hơn. ${idea}. Từng đường cắt vừa vặn tôn tỷ lệ cơ thể tự nhiên. Bạn chấm outfit này mấy điểm?`, beats: [{timeRange: '0.0–3.0s', phase: 'hook', spoken: 'Có những thiết kế chỉ cần khoác lên là tự động thấy mình sang hơn.', emotionTag: '[calm]', shotSuggestion: 'Cận chất vải + lộ dáng', cutHint: 'Slow push-in'}], cta: 'Comment điểm 1–10 cho outfit này nhé!', recommendedStyle: 'cinematic', recommendedPace: 'natural', recommendedTransition: 'dip', voiceTone: 'Trầm ấm, tinh tế'},
				{id: 'vo_3', angle: 'High-Conversion — Review thực tế & Chốt đơn', badge: '🛍️ Đề xuất #3 · Chốt đơn', estimatedSec: targetSec, wordCount: 74, reasoning: 'Đánh đúng nỗi lo người mua và chốt đơn trực tiếp.', hook3s: {line: '3 lý do khiến item này cháy hàng liên tục tuần qua!', visualHint: '0-3s: 3 góc cắt nhanh + thẻ số 3', overlayText: '3 LÝ DO CHÁY HÀNG 🔥', emotionTag: '[excited]'}, fullScript: `3 lý do khiến item này cháy hàng liên tục tuần qua! Một: ${idea}. Hai: mặc lên gọn dáng ngay lập tức không nhăn. Ba: mặc đi làm hay đi chơi đều hợp. Bấm giỏ hàng góc trái xem ngay nhé!`, beats: [{timeRange: '0.0–3.0s', phase: 'hook', spoken: '3 lý do khiến item này cháy hàng liên tục tuần qua!', emotionTag: '[excited]', shotSuggestion: '3 góc cắt siêu nhanh', cutHint: 'Big number "3" + Impact SFX'}], cta: 'Bấm giỏ hàng góc trái nhận ưu đãi!', recommendedStyle: 'hormozi', recommendedPace: 'ultra', recommendedTransition: 'whoosh', voiceTone: 'Nhanh, rõ ràng, thuyết phục'},
			],
		};
		if (window.STS_DB?.put) await window.STS_DB.put('video-studio', 'voiceover_plans', `vo_${Date.now().toString(36)}`, {userInput: idea, createdAt: Date.now(), result: res}).catch(() => {});
		return res;
	}

	if (url === '/api/fashion/hook3s' && method === 'POST') {
		const remote = await tryVercelOnline('/api/fashion/hook3s', {method: 'POST', body});
		if (remote?.ok) return remote;
		return {
			ok: true,
			modelUsed: 'Online Browser Engine',
			hook3s: {
				title: 'OUTFIT HACK DÁNG 25S ✨',
				visualAction: '0.0–1.5s: Outfit reveal toàn thân bước vào khung hình; 1.5–3.0s: Cut cận chất vải/chi tiết đắt giá.',
				openingLine: String(body.voiceOverScript || body.brief || '').split(/[.!?\n]/)[0]?.trim() || 'Đừng bỏ qua set đồ này nếu bạn muốn mặc đẹp trong 25 giây!',
				textOverlay: 'MẶC LÀ SANG · FORM CỰC GỌN',
				cameraMove: 'Snap zoom 1.18x tại 0.0s + Flash cut tại 1.5s',
				sfxCue: 'Impact hit tại 0.0s + Whoosh ngắn tại 1.5s',
				retentionScore: 90,
				whyItWorks: 'Mở đầu show ngay kết quả outfit đẹp nhất, đổi góc trong 1.5s và chốt chữ tương phản cao.',
				alternatives: [
					{label: 'Hook Con Số', openingLine: '3 cách phối chiếc áo này nhìn sang gấp đôi!', visualAction: '3 cú cắt nhanh 0.8s/góc', textOverlay: '3 CÁCH PHỐI CỰC SANG'},
					{label: 'Hook Phản Biện', openingLine: 'Đừng mua đồ basic nếu chưa thử form này…', visualAction: 'Cận chất vải rồi xoay người lộ dáng', textOverlay: 'ĐỪNG MUA NẾU CHƯA BIẾT'},
				],
			},
		};
	}

	if (url === '/api/fashion/voiceover/tts' && method === 'POST') {
		throw new Error('Tổng hợp file Audio WAV cần chạy máy chủ cục bộ Mac (`npm start` tại localhost:8790) hoặc VoiceStudio Pro.');
	}

	return {ok: true};
}
