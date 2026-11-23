import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {PATHS, PORT} from './config.js';
import {
	dbClearAppCollection,
	dbDeleteAppRecord,
	dbGetAppRecord,
	dbGetAppRecordWithMeta,
	dbGetSetting,
	dbListAppRecords,
	dbPutAppRecord,
	dbSetSetting,
	dbStats,
	dbSyncAllAppRecords,
	dbVerifyToken,
	dbVerifyUser,
} from './db.js';
import {addClips, cancelJob, clearAllJobs, createJob, deleteJob, getJob, getTimeline, jobDetail, listJobs, publicJob, removeClip, saveTimeline, startJob} from './jobs.js';
import {downloadWhisperModel, type WhisperModel} from '@remotion/install-whisper-cpp';
import {buildWebBundle} from './build-web.js';
import {getAgyStatus, runAgyPrompt, saveAgyConfig} from './agy-cli.js';
import {getCloudSyncState, scheduleCloudSync, startCloudSyncLoop, syncWithVercelCloud} from './cloud-sync.js';
import {analyzeHook3s, generateVoiceOverOptions, synthesizeVoiceOverAudio} from './fashion-director.js';
import {deleteDnaProfile, getDnaProfile, learnTikTokChannelsDNA, listDnaProfiles, mergeDnaProfiles} from './tiktok-dna.js';
import {availableModels, whisperReady} from './pipeline/transcribe.js';
import {listMusic, resetSfxCache} from './pipeline/plan.js';
import {getBundle, prepareBrowser} from './pipeline/render.js';
import {STYLES} from '../shared/styles.js';
import {DEFAULT_OPTIONS} from '../shared/types.js';

const app = express();
app.use(express.json({limit: '20mb'}));
app.use((req, res, next) => {
	const origin = req.headers.origin || '*';
	res.setHeader('Access-Control-Allow-Origin', origin);
	res.setHeader('Access-Control-Allow-Credentials', 'true');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	if (req.method === 'OPTIONS') {
		res.status(204).end();
		return;
	}
	next();
});

// ---- Auth (stored in SQLite table `users`, seeded with user: sts, pass: 1111)
const parseCookies = (cookieHeader?: string): Record<string, string> => {
	const out: Record<string, string> = {};
	if (!cookieHeader) return out;
	for (const part of cookieHeader.split(';')) {
		const idx = part.indexOf('=');
		if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
	}
	return out;
};

const getAuthedUser = (req: express.Request): string | null => {
	const cookies = parseCookies(req.headers.cookie);
	if (cookies.avs_token) {
		const c = dbVerifyToken(cookies.avs_token);
		if (c.ok && c.user) return c.user;
	}
	const authHeader = req.headers.authorization || '';
	if (authHeader.startsWith('Bearer ')) {
		const c = dbVerifyToken(authHeader.slice(7).trim());
		if (c.ok && c.user) return c.user;
	}
	return null;
};

app.get('/api/auth', (req, res) => {
	const user = getAuthedUser(req);
	res.json({ok: true, authenticated: Boolean(user), user});
});

app.post('/api/login', (req, res) => {
	const username = String(req.body?.username || '').trim();
	const password = String(req.body?.password || '').trim();
	const auth = dbVerifyUser(username, password);
	if (auth.ok && auth.token && auth.user) {
		res.setHeader('Set-Cookie', `avs_token=${auth.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
		res.json({ok: true, user: auth.user, token: auth.token});
		return;
	}
	res.status(401).json({ok: false, error: 'Sai tài khoản hoặc mật khẩu'});
});

app.post('/api/logout', (_req, res) => {
	res.setHeader('Set-Cookie', 'avs_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
	res.json({ok: true});
});

// ---- Multi-App SQLite Database Endpoints (/api/hub/db/:app/:collection)
app.get('/api/hub/stats', (_req, res) => {
	res.json({ok: true, db: dbStats(), cloudSync: getCloudSyncState(), serverTime: Date.now()});
});

app.post('/api/hub/cloud-sync-now', async (_req, res) => {
	const r = await syncWithVercelCloud();
	res.json({...r, db: dbStats(), cloudSync: getCloudSyncState()});
});

app.post('/api/hub/sync', (req, res) => {
	const incoming = Array.isArray(req.body?.records) ? req.body.records : [];
	const synced = dbSyncAllAppRecords(incoming);
	scheduleCloudSync(800);
	res.json({ok: true, ...synced, db: dbStats()});
});

app.get('/api/hub/db/:app/:collection', (req, res) => {
	const items = dbListAppRecords(req.params.app, req.params.collection);
	res.json({ok: true, items, db: dbStats()});
});

app.get('/api/hub/db/:app/:collection/:id', (req, res) => {
	const meta = dbGetAppRecordWithMeta(req.params.app, req.params.collection, req.params.id);
	res.json({ok: true, item: meta ? meta.item : null, updatedAt: meta ? meta.updatedAt : 0});
});

app.put('/api/hub/db/:app/:collection/:id', (req, res) => {
	const updatedAt = dbPutAppRecord(
		req.params.app,
		req.params.collection,
		req.params.id,
		req.body?.data !== undefined ? req.body.data : req.body,
		req.body?.updatedAt,
	);
	res.json({ok: true, updatedAt, db: dbStats()});
});

app.delete('/api/hub/db/:app/:collection/:id', (req, res) => {
	dbDeleteAppRecord(req.params.app, req.params.collection, req.params.id);
	res.json({ok: true, db: dbStats()});
});

app.delete('/api/hub/db/:app/:collection', (req, res) => {
	dbClearAppCollection(req.params.app, req.params.collection);
	res.json({ok: true, db: dbStats()});
});

// ---- Local Antigravity CLI (`agy`) AI Engine & Model Selector Endpoints
app.get('/api/agy/status', async (_req, res) => {
	try {
		res.json(await getAgyStatus());
	} catch (e) {
		res.status(500).json({ok: false, error: (e as Error).message});
	}
});

app.put('/api/agy/config', async (req, res) => {
	try {
		const config = saveAgyConfig(req.body || {});
		const status = await getAgyStatus();
		res.json({...status, config});
	} catch (e) {
		res.status(400).json({ok: false, error: (e as Error).message});
	}
});

app.post('/api/agy/run', async (req, res) => {
	try {
		const prompt = String(req.body?.prompt || '').trim();
		if (!prompt) {
			res.status(400).json({ok: false, error: 'Thiếu nội dung câu lệnh (prompt)'});
			return;
		}
		const model = typeof req.body?.model === 'string' ? req.body.model.trim() : undefined;
		const out = await runAgyPrompt(prompt, {model});
		res.json(out);
	} catch (e) {
		res.status(400).json({ok: false, error: (e as Error).message});
	}
});

app.use('/api', (req, res, next) => {
	if (getAuthedUser(req)) return next();
	res.status(401).json({ok: false, authRequired: true, error: 'Vui lòng đăng nhập để sử dụng'});
});

const upload = multer({
	dest: path.join(os.tmpdir(), 'auto-video-studio-uploads'),
	limits: {fileSize: 8 * 1024 * 1024 * 1024},
});

const wrap =
	(fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) =>
	async (req: express.Request, res: express.Response) => {
		try {
			const out = await fn(req, res);
			if (!res.headersSent) res.json(out ?? {ok: true});
		} catch (e) {
			res.status(400).json({ok: false, error: (e as Error).message});
		}
	};

app.get(
	'/api/info',
	wrap(() => ({
		ok: true,
		whisper: whisperReady(),
		models: availableModels(),
		downloading: modelDownload,
		music: listMusic().map((m) => ({id: m.id, mood: m.mood, styles: m.styles})),
		sfx: fs.existsSync(PATHS.sfx) ? fs.readdirSync(PATHS.sfx).length : 0,
		styles: Object.values(STYLES).map((s) => ({id: s.id, name: s.name, about: s.about, accent: s.accent, font: s.caption.font})),
		defaults: DEFAULT_OPTIONS,
		savedOptions: dbGetSetting('user_options'),
		db: dbStats(),
		serverGeminiKey: Boolean(process.env.GEMINI_API_KEY),
	})),
);

app.get('/api/db', wrap(() => ({ok: true, db: dbStats()})));

app.put(
	'/api/settings',
	wrap((req) => {
		if (req.body?.options && typeof req.body.options === 'object') {
			const {geminiKey, ...rest} = req.body.options;
			const prev = dbGetSetting<Record<string, unknown>>('user_options') || {};
			dbSetSetting('user_options', {...prev, ...rest, ...(geminiKey && geminiKey !== '••••' ? {geminiKey} : {})});
		}
		return {ok: true, db: dbStats()};
	}),
);

app.post(
	'/api/upload',
	upload.array('video', 100),
	wrap(async (req) => {
		const files = (req.files as Express.Multer.File[] | undefined) || [];
		if (!files.length) throw new Error('Thiếu file video');
		let meta: {lastModified?: number}[] = [];
		try {
			meta = JSON.parse(req.body?.meta || '[]');
		} catch {}
		const incoming = files.map((f, k) => ({
			path: f.path,
			name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
			lastModified: Number(meta[k]?.lastModified) || null,
		}));
		const jobId = req.body?.jobId;
		if (jobId) {
			const {job, added} = await addClips(jobId, incoming);
			return {ok: true, id: job.id, added: added.map((c) => c.id), job: publicJob(job)};
		}
		const job = await createJob(incoming);
		return {ok: true, id: job.id, added: job.clips.map((c) => c.id), job: publicJob(job)};
	}),
);

app.get('/api/jobs', wrap(() => ({ok: true, jobs: listJobs().map((j) => ({id: j.id, name: j.name, state: j.state, createdAt: j.createdAt, result: j.result, progress: j.progress, message: j.message}))})));

app.get(
	'/api/jobs/:id',
	wrap((req) => {
		const j = getJob(req.params.id);
		if (!j) throw new Error('Không tìm thấy job');
		return {ok: true, job: publicJob(j)};
	}),
);

app.get(
	'/api/jobs/:id/detail',
	wrap((req) => {
		const d = jobDetail(req.params.id);
		if (!d) throw new Error('Không tìm thấy job');
		return {ok: true, ...d};
	}),
);

app.post(
	'/api/jobs/:id/start',
	wrap((req) => {
		const {options = {}, face = null, overrides} = req.body || {};
		const prev = getJob(req.params.id);
		if (options.geminiKey === '••••' && prev) options.geminiKey = prev.options.geminiKey;
		if (!options.geminiKey && process.env.GEMINI_API_KEY) options.geminiKey = process.env.GEMINI_API_KEY;
		const job = startJob(req.params.id, options, face, overrides);
		return {ok: true, id: job.id};
	}),
);

// ---- timeline editor
app.get('/api/jobs/:id/timeline', wrap(async (req) => ({ok: true, ...(await getTimeline(req.params.id))})));
app.put('/api/jobs/:id/timeline', wrap((req) => saveTimeline(req.params.id, req.body?.timeline, req.body?.options)));
app.post(
	'/api/jobs/:id/render',
	wrap((req) => {
		const {options = {}, timeline} = req.body || {};
		const prev = getJob(req.params.id);
		if (options.geminiKey === '••••' && prev) options.geminiKey = prev.options.geminiKey;
		if (timeline) saveTimeline(req.params.id, timeline);
		startJob(req.params.id, options, null, undefined, 'timeline');
	}),
);

// ---- whisper models (Vietnamese needs large-v3 or medium)
let modelDownload: {model: string; progress: number; error?: string} | null = null;
app.post(
	'/api/models/:name/download',
	wrap((req) => {
		const model = req.params.name as WhisperModel;
		if (!['small', 'medium', 'large-v3', 'large-v2', 'base'].includes(model)) throw new Error('Model không hỗ trợ');
		if (modelDownload && !modelDownload.error && modelDownload.progress < 1) throw new Error('Đang tải model khác');
		modelDownload = {model, progress: 0};
		downloadWhisperModel({model, folder: PATHS.whisper, printOutput: false, onProgress: (d, t) => (modelDownload = {model, progress: d / t})})
			.then(() => (modelDownload = {model, progress: 1}))
			.catch((e) => (modelDownload = {model, progress: 0, error: e.message}));
	}),
);

app.delete('/api/jobs/:id/clips/:clipId', wrap((req) => removeClip(req.params.id, req.params.clipId)));
app.post('/api/jobs/:id/cancel', wrap((req) => cancelJob(req.params.id)));
app.delete('/api/jobs/:id', wrap((req) => deleteJob(req.params.id)));
app.delete('/api/jobs', wrap(() => clearAllJobs()));

// ---- TikTok Channel DNA Learner (1 or multiple channels + optional local reference videos)
app.get('/api/dna', wrap(() => ({ok: true, items: listDnaProfiles()})));

app.get(
	'/api/dna/:id',
	wrap((req) => {
		const item = getDnaProfile(req.params.id);
		if (!item) throw new Error('Không tìm thấy hồ sơ DNA');
		return {ok: true, item};
	}),
);

app.post(
	'/api/dna/learn',
	upload.array('referenceVideos', 8),
	wrap(async (req) => {
		const rawUrls = req.body?.urls;
		let urls: string[] = [];
		if (Array.isArray(rawUrls)) {
			urls = rawUrls.map(String);
		} else if (typeof rawUrls === 'string') {
			try {
				const parsed = JSON.parse(rawUrls);
				urls = Array.isArray(parsed) ? parsed.map(String) : rawUrls.split(/[\n,;]+/);
			} catch {
				urls = rawUrls.split(/[\n,;]+/);
			}
		}
		const files = (req.files as Express.Multer.File[] | undefined) || [];
		const localReferenceFiles = files.map((f) => ({
			path: f.path,
			name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
		}));
		try {
			const dna = await learnTikTokChannelsDNA({
				urls: urls.map((u) => u.trim()).filter(Boolean),
				name: typeof req.body?.name === 'string' ? req.body.name : undefined,
				niche: typeof req.body?.niche === 'string' ? req.body.niche : undefined,
				notes: typeof req.body?.notes === 'string' ? req.body.notes : undefined,
				model: typeof req.body?.model === 'string' ? req.body.model : undefined,
				maxVideosPerChannel: Number(req.body?.maxVideosPerChannel) || 12,
				localReferenceFiles,
			});
			scheduleCloudSync(600);
			return {ok: true, item: dna, items: listDnaProfiles()};
		} finally {
			for (const f of files) fs.rmSync(f.path, {force: true});
		}
	}),
);

app.post(
	'/api/dna/merge',
	wrap(async (req) => {
		const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
		const dna = await mergeDnaProfiles(ids, req.body?.name, req.body?.model);
		scheduleCloudSync(600);
		return {ok: true, item: dna, items: listDnaProfiles()};
	}),
);

app.delete(
	'/api/dna/:id',
	wrap((req) => {
		deleteDnaProfile(req.params.id);
		scheduleCloudSync(600);
		return {ok: true, items: listDnaProfiles()};
	}),
);

// ---- Fashion 20-30s Voice Over Reasoner & 3-Second Hook Analyzer (AGY CLI)
app.post(
	'/api/fashion/voiceover',
	wrap(async (req) => {
		const out = await generateVoiceOverOptions({
			userInput: String(req.body?.userInput || ''),
			targetSec: Number(req.body?.targetSec) || 25,
			dnaProfileId: typeof req.body?.dnaProfileId === 'string' ? req.body.dnaProfileId : undefined,
			brandStyle: typeof req.body?.brandStyle === 'string' ? req.body.brandStyle : undefined,
			model: typeof req.body?.model === 'string' ? req.body.model : undefined,
		});
		scheduleCloudSync(600);
		return out;
	}),
);

app.post(
	'/api/fashion/voiceover/tts',
	wrap(async (req) => {
		return await synthesizeVoiceOverAudio({
			text: String(req.body?.text || ''),
			voiceName: typeof req.body?.voiceName === 'string' ? req.body.voiceName : undefined,
			rateWpm: Number(req.body?.rateWpm) || 195,
		});
	}),
);

app.post(
	'/api/fashion/hook3s',
	wrap(async (req) => {
		return await analyzeHook3s({
			brief: typeof req.body?.brief === 'string' ? req.body.brief : undefined,
			transcript: typeof req.body?.transcript === 'string' ? req.body.transcript : undefined,
			voiceOverScript: typeof req.body?.voiceOverScript === 'string' ? req.body.voiceOverScript : undefined,
			dnaProfileId: typeof req.body?.dnaProfileId === 'string' ? req.body.dnaProfileId : undefined,
			model: typeof req.body?.model === 'string' ? req.body.model : undefined,
		});
	}),
);

app.use('/voiceovers', express.static(path.join(PATHS.data, 'voiceovers')));
app.use('/files', express.static(PATHS.jobs, {fallthrough: false}));
app.use('/sfx', express.static(PATHS.sfx));
app.use('/music', express.static(PATHS.music));
app.use('/vendor/mediapipe', express.static(path.join(PATHS.root, 'node_modules', '@mediapipe', 'tasks-vision')));
app.use('/models', express.static(path.join(PATHS.public, 'models')));
app.use('/', express.static(PATHS.web));
app.get('/script-studio/*', (_req, res) => {
	const f = path.join(PATHS.web, 'script-studio', 'index.html');
	if (fs.existsSync(f)) res.sendFile(f);
	else res.status(404).end();
});

app.listen(PORT, '127.0.0.1', () => {
	console.log(`\n  Auto Video Studio: http://localhost:${PORT}\n`);
	startCloudSyncLoop();
	if (!whisperReady()) console.log('  ! Chưa có Whisper. Chạy: npm run setup:whisper\n');
	resetSfxCache();
	buildWebBundle()
		.then(() => console.log('  Trình chỉnh sửa (preview) sẵn sàng.'))
		.catch((e) => console.error('  Build preview lỗi:', e.message));
	// warm up: download the headless browser and bundle the composition in the background
	prepareBrowser((s) => console.log('  ' + s))
		.then(() => getBundle((s) => console.log('  ' + s)))
		.then(() => console.log('  Remotion sẵn sàng.'))
		.catch((e) => console.error('  Remotion warm-up lỗi:', e.message));
});
