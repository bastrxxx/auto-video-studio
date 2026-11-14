import {scanFaces} from './face.js';
import {openEditor, refreshEditor, editorDirty, closeEditor, pauseEditor, fitTimelineZoom} from './editor/editor.js';
import {handleBrowserApi, handleBrowserUpload} from './browser-engine.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let API_BASE = '';
let BROWSER_MODE = false;
window.AVS_BASE = '';

const resolveUrl = (u) => (u && u.startsWith('/') && API_BASE ? `${API_BASE}${u}` : u);

async function resolveBackend() {
	const candidates = [''];
	try {
		const cfg = await fetch('./online-config.json?t=' + Date.now()).then((r) => (r.ok ? r.json() : null)).catch(() => null);
		if (cfg?.backendUrl) candidates.push(cfg.backendUrl.replace(/\/+$/, ''));
	} catch {}
	const saved = localStorage.getItem('avs.backend');
	if (saved) candidates.push(saved.replace(/\/+$/, ''));
	if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
		candidates.push('http://localhost:8790');
	}
	for (const base of [...new Set(candidates)]) {
		try {
			const ctrl = new AbortController();
			const to = setTimeout(() => ctrl.abort(), 2200);
			const token = localStorage.getItem('avs.token') || '';
			const res = await fetch(`${base}/api/auth`, {
				headers: token ? {Authorization: `Bearer ${token}`} : {},
				credentials: 'include',
				signal: ctrl.signal,
			});
			clearTimeout(to);
			const ct = res.headers.get('content-type') || '';
			if (res.ok && ct.includes('application/json')) {
				API_BASE = base;
				window.AVS_BASE = base;
				BROWSER_MODE = false;
				return await res.json();
			}
		} catch {}
	}
	BROWSER_MODE = true;
	API_BASE = '';
	window.AVS_BASE = location.pathname.includes('/video-studio') ? '..' : '.';
	return handleBrowserApi('/api/auth');
}

const showLogin = (msg = '') => {
	stopPoll();
	pauseEditor();
	$('#appShell').classList.add('hidden');
	$('#loginScreen').classList.remove('hidden');
	const err = $('#loginErr');
	if (msg) {
		err.textContent = msg;
		err.classList.remove('hidden');
	} else {
		err.classList.add('hidden');
	}
	setTimeout(() => $('#loginUser')?.focus(), 50);
};

const api = async (url, opts = {}) => {
	if (BROWSER_MODE) return handleBrowserApi(url, opts);
	const token = localStorage.getItem('avs.token') || '';
	const headers = {'Content-Type': 'application/json', ...(opts.headers || {})};
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`${API_BASE}${url}`, {
		...opts,
		headers,
		credentials: 'include',
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	});
	const j = await res.json().catch(() => ({ok: false, error: res.statusText}));
	if (res.status === 401 || j.authRequired) {
		showLogin(j.error || 'Phiên đăng nhập đã hết hạn');
		throw new Error(j.error || 'Vui lòng đăng nhập');
	}
	if (!res.ok || j.ok === false) throw new Error(j.error || res.statusText);
	return j;
};
window.AVS_API = api;

const fmt = (s) => {
	s = Math.max(0, s || 0);
	const m = Math.floor(s / 60);
	return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const fmtDate = (t) => new Date(t).toLocaleString('vi-VN', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

const state = {
	booted: false,
	view: 'setup', // 'setup' | 'editor' | 'result'
	info: null,
	opts: null,
	jobId: null,
	job: null,
	clips: [],
	faces: {},
	pending: [],
	uploadChain: Promise.resolve(),
	poll: null,
	detail: null,
	manual: new Map(),
};

const PRESETS = {
	viral: {style: 'hormozi', format: '9:16', pace: 'fast', zoom: 1.3, sfx: 'standard', emoji: true, bigNumbers: true, music: 'auto', wordsPerGroup: 2, captions: true, removeSilence: true, removeRetakes: true, removeFillers: true, transition: 'flash'},
	business: {style: 'clean', format: '9:16', pace: 'fast', zoom: 1, sfx: 'restrained', emoji: false, bigNumbers: true, music: '', wordsPerGroup: 3, captions: true, removeSilence: true, removeRetakes: true, removeFillers: true, transition: 'cut'},
	vlog: {style: 'minimal', pace: 'natural', zoom: 0.4, sfx: 'off', emoji: false, bigNumbers: false, music: 'auto', wordsPerGroup: 5, captions: true, removeSilence: true, transition: 'dip', order: 'time'},
	youtube: {style: 'clean', format: '16:9', fit: 'fill', platform: 'none', pace: 'natural', zoom: 0.6, sfx: 'restrained', emoji: false, wordsPerGroup: 5, captionSize: 0.9, music: '', transition: 'dip'},
};

// ---------------------------------------------------------------- Auth & Boot
async function init() {
	bindAuth();
	const r = await resolveBackend();
	if (!r.authenticated) {
		showLogin();
		return;
	}
	await enterStudio(r.user || 'sts');
}

function bindAuth() {
	$('#loginForm').addEventListener('submit', async (e) => {
		e.preventDefault();
		const username = $('#loginUser').value.trim();
		const password = $('#loginPass').value.trim();
		const btn = $('#loginBtn');
		btn.disabled = true;
		$('#loginErr').classList.add('hidden');
		try {
			if (BROWSER_MODE) {
				const j = await handleBrowserApi('/api/login', {method: 'POST', body: {username, password}});
				$('#loginPass').value = '';
				await enterStudio(j.user || username);
				return;
			}
			const res = await fetch(`${API_BASE}/api/login`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				credentials: 'include',
				body: JSON.stringify({username, password}),
			});
			const j = await res.json().catch(() => ({}));
			if (!res.ok || !j.ok) {
				$('#loginErr').textContent = j.error || 'Sai tài khoản hoặc mật khẩu';
				$('#loginErr').classList.remove('hidden');
				return;
			}
			if (j.token) localStorage.setItem('avs.token', j.token);
			$('#loginPass').value = '';
			await enterStudio(j.user || username);
		} catch (err) {
			$('#loginErr').textContent = err.message;
			$('#loginErr').classList.remove('hidden');
		} finally {
			btn.disabled = false;
		}
	});

	$('#logoutBtn').addEventListener('click', async () => {
		localStorage.removeItem('avs.token');
		if (BROWSER_MODE) await handleBrowserApi('/api/logout', {method: 'POST'}).catch(() => undefined);
		else await fetch(`${API_BASE}/api/logout`, {method: 'POST', credentials: 'include'}).catch(() => undefined);
		showLogin();
	});
}

async function enterStudio(user) {
	$('#userBadge').textContent = `👤 ${user}`;
	$('#loginScreen').classList.add('hidden');
	$('#appShell').classList.remove('hidden');

	state.info = await api('/api/info');
	const dbSaved = state.info.savedOptions || {};
	const localSaved = JSON.parse(localStorage.getItem('avs.opts') || '{}');
	const saved = {...localSaved, ...dbSaved};
	state.opts = {...state.info.defaults, ...saved, manualOrder: []};
	state.opts.color = {...(state.info.defaults.color || {}), ...(localSaved.color || {}), ...(dbSaved.color || {})};
	if (!state.info.models.includes(state.opts.model)) state.opts.model = state.info.models[0] || 'small';
	$('#geminiKey').value = localStorage.getItem('avs.gemini') || saved.geminiKey || '';

	renderStatus();
	renderStyles();
	renderSelects();
	if (!state.booted) {
		state.booted = true;
		bindOptions();
		bindUpload();
		bindButtons();
	}
	syncOptions();
	await refreshHistory();
	const last = location.hash.slice(1);
	if (last) loadJob(last).catch(() => undefined);
}

// ---------------------------------------------------------------- View Switcher
function switchView(view) {
	state.view = view;
	$$('#viewTabs .view-tab').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
	$('#viewSetup').classList.toggle('hidden', view !== 'setup');
	$('#viewEditor').classList.toggle('hidden', view !== 'editor');
	$('#viewResult').classList.toggle('hidden', view !== 'result');
	if (view !== 'editor') pauseEditor();
	if (view !== 'result') $('#outVideo')?.pause();
	if (view === 'editor') {
		setTimeout(() => fitTimelineZoom(), 40);
	}
}

function renderStatus() {
	const i = state.info;
	const db = i?.db;
	if (BROWSER_MODE) {
		$('#status').innerHTML = [
			`<span class="pill ok" title="Dữ liệu được lưu vào IndexedDB (AutoVideoStudioDB)">🗄 IndexedDB · ${db?.jobs ?? 0} dự án</span>`,
			`<span class="pill ok">Remotion Player</span>`,
			`<span class="pill ok">Auto Color</span>`,
		].join('');
		return;
	}
	$('#status').innerHTML = [
		`<span class="pill ok" title="Cơ sở dữ liệu SQLite: ${escapeHtml(db?.file || 'data/studio.db')}">🗄 SQLite · ${db?.jobs ?? 0} dự án</span>`,
		`<span class="pill ${i.whisper ? 'ok' : 'bad'}">Whisper ${i.whisper ? i.models.join(', ') : 'chưa cài'}</span>`,
		`<span class="pill ok">Remotion</span>`,
		`<span class="pill ${i.sfx ? 'ok' : 'bad'}">${i.sfx} âm thanh</span>`,
		`<span class="pill ${i.music.length ? 'ok' : 'bad'}">${i.music.length} nhạc nền</span>`,
	].join('');
}

function renderStyles() {
	$('#styles').innerHTML = state.info.styles
		.map(
			(s) => `<button type="button" class="style" data-style="${s.id}">
		<div class="sample" style="font-family:'${s.font}',sans-serif"><span>Phụ đề <span style="color:${s.accent}">nổi bật</span></span></div>
		<b>${s.name}</b><small>${s.about}</small></button>`,
		)
		.join('');
	$$('#styles .style').forEach((b) => b.addEventListener('click', () => setOpt('style', b.dataset.style)));
}

const MODEL_INFO = {'large-v3': 'large-v3 · chuẩn nhất cho tiếng Việt (3 GB)', medium: 'medium · khá (1.5 GB)', small: 'small · nhanh, hay sai dấu (0.5 GB)', base: 'base'};
function renderSelects() {
	const ms = state.info.models.length ? state.info.models : ['small'];
	$('#modelSel').innerHTML = ms.map((m) => `<option value="${m}">${MODEL_INFO[m] || m}</option>`).join('');
	const dl = state.info.downloading;
	const missing = ['large-v3', 'medium'].filter((m) => !state.info.models.includes(m));
	$('#modelDl').innerHTML =
		dl && !dl.error && dl.progress < 1
			? `<span class="muted">Đang tải ${dl.model}: ${Math.round(dl.progress * 100)}%</span>`
			: missing.map((m) => `<button type="button" class="ghost sm" data-dl="${m}">⬇ Tải ${MODEL_INFO[m]}</button>`).join('') + (dl?.error ? `<span class="muted">Lỗi: ${escapeHtml(dl.error)}</span>` : '');
	$$('#modelDl [data-dl]').forEach((b) =>
		b.addEventListener('click', async (e) => {
			e.preventDefault();
			await api(`/api/models/${b.dataset.dl}/download`, {method: 'POST'}).catch((err) => alert(err.message));
			pollModels();
		}),
	);
	$('#musicSel').innerHTML =
		`<option value="">Không nhạc</option><option value="auto">Tự chọn theo phong cách</option>` +
		state.info.music.map((m) => `<option value="${m.id}">${m.id} · ${m.mood.slice(0, 2).join(', ')}</option>`).join('');
}

async function pollModels() {
	state.info = await api('/api/info');
	renderSelects();
	syncOptions();
	const dl = state.info.downloading;
	if (dl && !dl.error && dl.progress < 1) setTimeout(pollModels, 1500);
	else if (dl && dl.progress >= 1 && state.info.models.includes(dl.model)) setOpt('model', dl.model);
}

let saveSettingsTimer = null;
function setOpt(k, v, silent) {
	state.opts[k] = v;
	const clean = {...state.opts, geminiKey: '', manualOrder: []};
	localStorage.setItem('avs.opts', JSON.stringify(clean));
	clearTimeout(saveSettingsTimer);
	saveSettingsTimer = setTimeout(() => {
		api('/api/settings', {method: 'PUT', body: {options: clean}}).catch(() => undefined);
	}, 450);
	if (!silent) syncOptions();
	if (k === 'order') renderClips();
	refreshEditor();
}

function bindOptions() {
	$$('[data-opt]').forEach((el) => {
		const k = el.dataset.opt;
		if (el.classList.contains('seg')) {
			$$('button', el).forEach((b) =>
				b.addEventListener('click', (e) => {
					e.preventDefault();
					setOpt(k, b.dataset.v);
				}),
			);
			return;
		}
		const ev = el.type === 'range' || el.type === 'text' || el.type === 'color' || el.tagName === 'TEXTAREA' ? 'input' : 'change';
		el.addEventListener(ev, () => {
			let v = el.type === 'checkbox' ? el.checked : el.value;
			if (el.type === 'range' || k === 'maxDuration') v = Number(v);
			setOpt(k, v, el.type === 'text' || el.tagName === 'TEXTAREA');
			if (el.type === 'range') syncOptions();
		});
	});
	$('#resetAccent').addEventListener('click', (e) => {
		e.preventDefault();
		setOpt('accent', '');
	});
	$('#fixes').value = Object.entries(state.opts.fixes || {})
		.map(([a, b]) => `${a} = ${b}`)
		.join('\n');
	$('#fixes').addEventListener('input', () => {
		const fixes = {};
		for (const line of $('#fixes').value.split('\n')) {
			const [a, ...b] = line.split('=');
			if (a?.trim() && b.length) fixes[a.trim()] = b.join('=').trim();
		}
		setOpt('fixes', fixes, true);
	});
	$('#geminiKey').addEventListener('input', () => localStorage.setItem('avs.gemini', $('#geminiKey').value.trim()));
	$$('#quickColor button').forEach((b) =>
		b.addEventListener('click', () => setColorOpt({...(state.info.defaults.color || {}), ...(state.opts.color || {}), auto: b.dataset.v === 'auto'})),
	);
	$$('[data-preset]').forEach((b) =>
		b.addEventListener('click', () => {
			Object.assign(state.opts, PRESETS[b.dataset.preset]);
			setOpt('style', state.opts.style);
		}),
	);
}

function syncOptions() {
	const o = state.opts;
	$$('[data-opt]').forEach((el) => {
		const k = el.dataset.opt;
		if (el.classList.contains('seg')) $$('button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === String(o[k])));
		else if (el.type === 'checkbox') el.checked = !!o[k];
		else if (el.type === 'color') el.value = o.accent || (state.info.styles.find((s) => s.id === o.style)?.accent ?? '#ffd23f');
		else el.value = o[k] ?? '';
	});
	$$('[data-out]').forEach((el) => (el.textContent = o[el.dataset.out]));
	$$('#styles .style').forEach((b) => b.classList.toggle('on', b.dataset.style === o.style));
	syncQuickColor();
}

// ---------------------------------------------------------------- Clips & Upload
function bindUpload() {
	const drop = $('#drop');
	$('#file').addEventListener('change', (e) => {
		addFiles([...e.target.files]);
		e.target.value = '';
	});
	$('#fileMore').addEventListener('change', (e) => {
		addFiles([...e.target.files]);
		e.target.value = '';
	});
	['dragenter', 'dragover'].forEach((ev) =>
		drop.addEventListener(ev, (e) => {
			if (!e.dataTransfer?.types.includes('Files')) return;
			e.preventDefault();
			drop.classList.add('over');
		}),
	);
	['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
	drop.addEventListener('drop', (e) => {
		if (!e.dataTransfer?.files?.length) return;
		e.preventDefault();
		addFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('video/') || /\.(mov|mp4|mkv|webm|m4v|avi)$/i.test(f.name)));
	});
}

function resetWorkspace() {
	stopPoll();
	Object.assign(state, {
		jobId: null,
		job: null,
		clips: [],
		faces: {},
		pending: [],
		uploadChain: Promise.resolve(),
		detail: null,
		manual: new Map(),
	});
	state.opts.manualOrder = [];
	location.hash = '';
	closeEditor();
	$('#progressCard').classList.add('hidden');
	$('#tabEditor').disabled = true;
	$('#tabResult').disabled = true;
	$('#tabEditorSub').textContent = 'Chỉnh từng câu theo giây & kéo thả';
	$('#tabResultSub').textContent = 'Xem bản xuất cuối & thống kê';
	switchView('setup');
	$('#localPreview').classList.add('hidden');
	$('#localPreview').removeAttribute('src');
	$('#startBtn').disabled = true;
	$('#startHint').textContent = 'Chọn video để bắt đầu';
	$$('#history li').forEach((li) => li.classList.remove('active'));
	renderClips();
}

async function clearCurrentVideos() {
	if (!state.clips.length && !state.jobId) return;
	if (!confirm('Xoá tất cả video đang chọn để bắt đầu lại?')) return;
	const id = state.jobId;
	resetWorkspace();
	if (id) {
		await api(`/api/jobs/${id}`, {method: 'DELETE'}).catch(() => undefined);
		await refreshHistory();
	}
}

let keySeq = 0;
function addFiles(files) {
	if (!files.length) return;
	if (state.job && ['running', 'queued'].includes(state.job.state)) return alert('Dự án đang xử lý, đợi xong rồi thêm video.');
	for (const file of files) {
		const c = {key: `l${++keySeq}`, name: file.name, url: URL.createObjectURL(file), local: true, up: 0, face: 0, fileModified: file.lastModified, size: file.size};
		state.clips.push(c);
		const up = (state.uploadChain = state.uploadChain.then(() => uploadOne(c, file)));
		state.pending.push(up.catch(() => undefined));
		state.pending.push(
			up
				.then(() =>
					scanFaces(file, (p) => {
						c.face = p;
						updateClipMeters(c);
					}),
				)
				.then((samples) => {
					c.face = 1;
					c.faceCount = samples?.length || 0;
					if (c.id && samples?.length) state.faces[c.id] = samples;
					updateClipMeters(c);
				})
				.catch(() => {
					c.face = 1;
					c.faceCount = 0;
					updateClipMeters(c);
				}),
		);
	}
	renderClips();
	updateStart();
}

function uploadOne(c, file) {
	if (BROWSER_MODE) {
		return handleBrowserUpload([file], [{lastModified: file.lastModified}], state.jobId).then((j) => {
			state.jobId = j.id;
			location.hash = j.id;
			const info = j.job.clips.find((x) => x.id === j.added[0]);
			Object.assign(c, info, {url: c.url || resolveUrl(info?.url), up: 1, local: true});
			state.job = j.job;
			renderClips();
			updateStart();
			refreshHistory();
		});
	}
	return new Promise((resolve, reject) => {
		const fd = new FormData();
		fd.append('video', file);
		fd.append('meta', JSON.stringify([{lastModified: file.lastModified}]));
		if (state.jobId) fd.append('jobId', state.jobId);
		const xhr = new XMLHttpRequest();
		xhr.open('POST', `${API_BASE}/api/upload`);
		xhr.withCredentials = true;
		const token = localStorage.getItem('avs.token') || '';
		if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) {
				c.up = e.loaded / e.total;
				updateClipMeters(c);
			}
		};
		xhr.onload = () => {
			if (xhr.status === 401) {
				showLogin('Vui lòng đăng nhập để tải video lên');
				return reject(new Error('Unauthorized'));
			}
			let j = {};
			try {
				j = JSON.parse(xhr.responseText);
			} catch {}
			if (xhr.status !== 200 || !j.ok) {
				c.error = j.error || 'Tải lên thất bại';
				renderClips();
				return reject(new Error(c.error));
			}
			state.jobId = j.id;
			location.hash = j.id;
			const info = j.job.clips.find((x) => x.id === j.added[0]);
			Object.assign(c, info, {url: c.url || resolveUrl(info?.url), up: 1, local: true});
			state.job = j.job;
			renderClips();
			updateStart();
			refreshHistory();
			resolve();
		};
		xhr.onerror = () => {
			c.error = 'Mất kết nối';
			renderClips();
			reject(new Error(c.error));
		};
		xhr.send(fd);
	});
}

function updateStart() {
	const uploading = state.clips.some((c) => c.up < 1 && !c.error);
	const ready = state.jobId && state.clips.some((c) => c.id);
	$('#startBtn').disabled = !ready || uploading;
	$('#startHint').textContent = !state.clips.length ? 'Chọn video để bắt đầu' : uploading ? 'Đang tải video lên…' : 'Sẵn sàng! Chọn phong cách rồi bấm Tự động dựng video.';
}

function displayOrder() {
	const cs = [...state.clips];
	const mode = state.opts.order;
	if (mode === 'manual' && state.opts.manualOrder?.length) {
		const pos = (c) => {
			const i = state.opts.manualOrder.indexOf(c.id || c.key);
			return i < 0 ? 1e9 : i;
		};
		return cs.sort((a, b) => pos(a) - pos(b));
	}
	if (mode === 'name') return cs.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}));
	const srv = state.job?.order?.ids;
	if (mode === 'auto' && srv?.length && state.job.options?.order === 'auto') {
		const pos = (c) => {
			const i = srv.indexOf(c.id);
			return i < 0 ? 1e9 : i;
		};
		return cs.sort((a, b) => pos(a) - pos(b));
	}
	const t = (c) => c.recordedAt ?? c.fileModified ?? Infinity;
	return cs.sort((a, b) => t(a) - t(b) || a.name.localeCompare(b.name, undefined, {numeric: true}));
}

function clipWhy(c) {
	const r = state.job?.order?.reasons?.[c.id];
	if (r && state.job.options?.order === state.opts.order) return r;
	if (state.opts.order === 'name') return 'theo tên file';
	if (state.opts.order === 'manual') return 'kéo thả để đổi thứ tự';
	return c.recordedAt ? `quay lúc ${fmtDate(c.recordedAt)}` : c.fileModified ? `file lúc ${fmtDate(c.fileModified)}` : '';
}

function renderClips() {
	const has = state.clips.length > 0;
	$('#clipBar').classList.toggle('hidden', !has);
	$('#drop').classList.toggle('compact', has);
	$('#addMore').hidden = !has;
	$('#clearVideosBtn').hidden = !has;
	$('#clipCount').textContent = state.clips.length ? `· ${state.clips.length} video` : '';
	const list = displayOrder();
	$('#clips').innerHTML = list
		.map(
			(c, k) => `<li class="clip" draggable="true" data-key="${c.id || c.key}">
		<video src="${c.url}#t=0.5" preload="metadata" muted playsinline></video>
		<span class="badge">${k + 1}</span>
		<button type="button" class="rm" title="Xoá clip này">✕</button>
		<div class="mini"><i data-up style="width:${(c.up ?? 1) * 100}%"></i></div>
		<div class="info"><b title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</b>
			<span>${c.duration ? fmt(c.duration) : '…'}${c.width ? ` · ${c.width}×${c.height}` : ''}${c.error ? ` · ❌ ${escapeHtml(c.error)}` : ''}</span>
			<span data-face>${faceTxt(c)}</span>
			<span class="why">${escapeHtml(clipWhy(c))}</span></div></li>`,
		)
		.join('');
	bindClipEvents();
}

const faceTxt = (c) => (c.face === undefined ? '' : c.face >= 1 ? (c.faceCount ? `🙂 bám mặt ${c.faceCount} mẫu` : c.local ? 'không thấy mặt' : '') : `🙂 bám mặt ${Math.round(c.face * 100)}%`);

function updateClipMeters(c) {
	const li = $(`#clips li[data-key="${c.id || c.key}"]`);
	if (!li) return;
	$('[data-up]', li).style.width = `${(c.up ?? 1) * 100}%`;
	$('[data-face]', li).textContent = faceTxt(c);
}

function bindClipEvents() {
	let dragKey = null;
	$$('#clips .clip').forEach((li) => {
		const key = li.dataset.key;
		const clip = state.clips.find((c) => (c.id || c.key) === key);
		li.addEventListener('click', (e) => {
			if (e.target.closest('.rm')) return;
			const v = $('#localPreview');
			v.src = clip.url;
			v.classList.remove('hidden');
			v.play().catch(() => undefined);
		});
		$('.rm', li).addEventListener('click', async (e) => {
			e.stopPropagation();
			if (!confirm(`Xoá “${clip.name}” khỏi dự án?`)) return;
			if (clip.id && state.jobId) {
				try {
					await api(`/api/jobs/${state.jobId}/clips/${clip.id}`, {method: 'DELETE'});
				} catch (err) {
					return alert(err.message);
				}
			}
			state.clips = state.clips.filter((c) => c !== clip);
			delete state.faces[clip.id];
			if (!state.clips.length) {
				resetWorkspace();
				await refreshHistory();
				return;
			}
			renderClips();
			updateStart();
		});
		li.addEventListener('dragstart', (e) => {
			dragKey = key;
			li.classList.add('dragging');
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', key);
		});
		li.addEventListener('dragend', () => li.classList.remove('dragging'));
		li.addEventListener('dragover', (e) => {
			if (!dragKey) return;
			e.preventDefault();
			li.classList.add('over');
		});
		li.addEventListener('dragleave', () => li.classList.remove('over'));
		li.addEventListener('drop', (e) => {
			if (!dragKey) return;
			e.preventDefault();
			e.stopPropagation();
			li.classList.remove('over');
			const keys = displayOrder().map((c) => c.id || c.key);
			const from = keys.indexOf(dragKey);
			const to = keys.indexOf(key);
			if (from < 0 || to < 0 || from === to) return;
			keys.splice(to, 0, keys.splice(from, 1)[0]);
			state.opts.manualOrder = keys;
			dragKey = null;
			setOpt('order', 'manual');
		});
	});
}

// ---------------------------------------------------------------- Run & Actions
function bindButtons() {
	$('#startBtn').addEventListener('click', () => start());
	$('#cancelBtn').addEventListener('click', async () => {
		if (state.jobId) await api(`/api/jobs/${state.jobId}/cancel`, {method: 'POST'}).catch(() => undefined);
	});
	$('#newBtn').addEventListener('click', () => {
		resetWorkspace();
		window.scrollTo({top: 0, behavior: 'smooth'});
	});
	$('#clearVideosBtn').addEventListener('click', clearCurrentVideos);
	$('#clearVideosBtn2').addEventListener('click', clearCurrentVideos);
	$('#clearAllJobsBtn').addEventListener('click', async () => {
		if (!confirm('Xoá toàn bộ dự án và video đã lưu trên hệ thống?')) return;
		await api('/api/jobs', {method: 'DELETE'}).catch((e) => alert(e.message));
		resetWorkspace();
		await refreshHistory();
	});
	$$('#viewTabs .view-tab').forEach((b) =>
		b.addEventListener('click', () => {
			if (!b.disabled) switchView(b.dataset.view);
		}),
	);
	$('#backToEditorBtn')?.addEventListener('click', () => switchView('editor'));
}

const optionsPayload = () => {
	const manualOrder = state.opts.order === 'manual' ? displayOrder().map((c) => c.id).filter(Boolean) : [];
	return {...state.opts, manualOrder, geminiKey: $('#geminiKey').value.trim() || ''};
};

async function start() {
	if (!state.jobId) return;
	if (state.job?.result && editorDirty() && !confirm('Dựng lại tự động sẽ tạo timeline mới và thay thế các chỉnh sửa tay trên timeline. Tiếp tục?')) return;
	$('#startBtn').disabled = true;
	if (state.pending.length) {
		$('#startHint').textContent = 'Chờ tải lên & bám khuôn mặt xong…';
		await Promise.all(state.pending);
		state.pending = [];
	}
	const overrides = {cut: [], keep: []};
	for (const [k, keep] of state.manual) (keep ? overrides.keep : overrides.cut).push(k);
	const face = Object.keys(state.faces).length ? state.faces : null;
	try {
		await api(`/api/jobs/${state.jobId}/start`, {method: 'POST', body: {options: optionsPayload(), face, overrides}});
		state.faces = {};
	} catch (e) {
		alert(e.message);
		$('#startBtn').disabled = false;
		return;
	}
	$('#startHint').textContent = '';
	closeEditor();
	$('#progressCard').classList.remove('hidden');
	$('#progressCard').scrollIntoView({behavior: 'smooth', block: 'start'});
	startPoll();
}

function stopPoll() {
	if (state.poll) clearInterval(state.poll);
	state.poll = null;
}

function startPoll() {
	stopPoll();
	const tick = async () => {
		if (!state.jobId) return;
		const {job} = await api(`/api/jobs/${state.jobId}`).catch(() => ({job: null}));
		if (!job) return;
		state.job = job;
		renderProgress(job);
		if (['done', 'error', 'cancelled', 'uploaded'].includes(job.state)) {
			stopPoll();
			$('#startBtn').disabled = false;
			refreshHistory();
			renderClips();
			if (job.state === 'done') {
				$('#progressCard').classList.add('hidden');
				await showResult(job);
			}
		}
	};
	state.poll = setInterval(tick, 1000);
	tick();
}

const ORDER = ['prep', 'transcribe', 'order', 'analyze', 'ai', 'plan', 'render', 'done'];
function renderProgress(job) {
	const idx = ORDER.indexOf(job.step);
	$$('#steps li').forEach((li) => {
		const k = ORDER.indexOf(li.dataset.step);
		li.className = job.state === 'done' || k < idx ? 'ok' : k === idx && job.state === 'running' ? 'run' : '';
		if (li.dataset.step === 'order') li.classList.toggle('hidden', (job.clips || []).length < 2);
	});
	$('#mainBar').style.width = `${Math.round((job.progress || 0) * 100)}%`;
	$('#msg').textContent = job.state === 'error' ? `❌ ${job.error}` : job.state === 'cancelled' ? 'Đã huỷ' : `${Math.round((job.progress || 0) * 100)}% — ${job.message || ''}`;
	$('#log').textContent = (job.log || []).join('\n');
	$('#cancelBtn').classList.toggle('hidden', !['running', 'queued'].includes(job.state));
}

const REASONS = {retake: 'nói lại', 'retake-cue': 'câu “làm lại”', 'false-start': 'bắt đầu hỏng', stutter: 'nói vấp', filler: 'từ đệm', noise: 'tiếng ồn', ai: 'AI bỏ', trim: 'cắt cho đủ thời lượng', manual: 'cắt tay'};

async function showResult(job) {
	const r = job.result;
	if (!r) return;
	$('#tabEditor').disabled = false;
	$('#tabResult').disabled = false;
	$('#tabResultSub').textContent = `MP4 ${fmt(r.duration)} · sẵn sàng tải về`;

	const dlName = `${job.name.replace(/\.[^.]+$/, '').replace(/\s*\+\d+$/, '')}-edit.mp4`;
	const vUrl = resolveUrl(r.video);
	const srtUrl = resolveUrl(r.srt);
	const planUrl = resolveUrl(r.plan);
	$('#outVideo').src = vUrl.startsWith('blob:') ? vUrl : `${vUrl}?t=${r.renderedAt}`;
	$('#dlVideo').href = vUrl;
	$('#dlVideo').setAttribute('download', dlName);
	$('#dlSrt').href = srtUrl;
	$('#dlPlan').href = planUrl;

	// Quick download buttons inside Studio Editor header
	$('#edDlVideo').href = vUrl;
	$('#edDlVideo').setAttribute('download', dlName);
	$('#edDlSrt').href = srtUrl;

	const d = await api(`/api/jobs/${job.id}/detail`);
	state.detail = d;
	state.manual = new Map();
	for (const k of job.overrides?.cut || []) state.manual.set(k, false);
	for (const k of job.overrides?.keep || []) state.manual.set(k, true);
	const cutsHtml = Object.entries(job.stats || {})
		.map(([k, n]) => `<span>${REASONS[k] || k}: ${n} từ</span>`)
		.join('');
	const beats = d.planSummary?.beats || [];
	const orderHtml =
		(job.clips || []).length > 1 && job.order
			? `<div class="beats"><span>Thứ tự (${escapeHtml(job.order.method)}):</span>${job.order.ids
					.map((id, k) => `<span>${k + 1}. ${escapeHtml(job.clips.find((c) => c.id === id)?.name || id)}</span>`)
					.join('')}</div>`
			: '';
	$('#stats').innerHTML = `
		<div class="stat"><b>${fmt(r.original)} → ${fmt(r.duration)}</b><span>thời lượng gốc → sau dựng</span></div>
		<div class="stat"><b>${Math.max(0, Math.round((1 - r.duration / r.original) * 100))}%</b><span>đã lược bỏ</span></div>
		<div class="stat"><b>${(job.clips || []).length} → ${d.takes.length}</b><span>clip → đoạn được ghép</span></div>
		<div class="stat"><b>${d.planSummary?.groups ?? 0}</b><span>cụm phụ đề</span></div>
		<div class="stat"><b>${beats.length}</b><span>hiệu ứng</span></div>
		<div class="stat"><b>${r.renderSeconds}s</b><span>thời gian render</span></div>
		${orderHtml}
		<div class="beats">${cutsHtml}</div>
		<div class="beats">${beats.map((b) => `<span>${fmt(b.start)} · ${b.type}${b.text ? ': ' + escapeHtml(b.text) : ''}</span>`).join('')}</div>`;

	// Switch to Studio Editor view so user sees the clean editor immediately
	switchView('editor');
	await openEditor(job.id, {getOptions: editorOptions, onExport: exportTimeline, setColor: setColorOpt}).catch((e) => console.warn('editor', e));
}

function setColorOpt(color) {
	setOpt('color', color, true);
	syncQuickColor();
}

function syncQuickColor() {
	const auto = state.opts.color?.auto !== false;
	$$('#quickColor button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'auto') === auto));
}

function editorOptions() {
	const {geminiKey, manualOrder, ...o} = state.opts;
	return o;
}

async function exportTimeline() {
	if (!state.jobId) return;
	try {
		await api(`/api/jobs/${state.jobId}/render`, {method: 'POST', body: {options: optionsPayload()}});
	} catch (e) {
		return alert(e.message);
	}
	$('#progressCard').classList.remove('hidden');
	$('#progressCard').scrollIntoView({behavior: 'smooth', block: 'start'});
	startPoll();
}

// ---------------------------------------------------------------- History
async function refreshHistory() {
	const {jobs} = await api('/api/jobs');
	if (state.info?.db) {
		state.info.db.jobs = jobs.length;
		renderStatus();
	}
	$('#clearAllJobsBtn').disabled = !jobs.length;
	$('#history').innerHTML =
		jobs
			.map(
				(j) => `<li data-id="${j.id}" class="${j.id === state.jobId ? 'active' : ''}"><b title="${escapeHtml(j.name)}">${escapeHtml(j.name)}</b>
		<span><em>${j.state === 'done' ? '✓ ' + fmt(j.result?.duration) : j.state === 'running' ? Math.round(j.progress * 100) + '%' : j.state}</em><i class="x" data-del="${j.id}" title="Xoá dự án này">✕</i></span></li>`,
			)
			.join('') || '<li class="muted">Chưa có dự án</li>';
	$$('#history li[data-id]').forEach((li) =>
		li.addEventListener('click', (ev) => {
			if (ev.target.dataset.del) {
				ev.stopPropagation();
				if (confirm('Xoá dự án này?'))
					api(`/api/jobs/${ev.target.dataset.del}`, {method: 'DELETE'}).then(() => {
						if (state.jobId === ev.target.dataset.del) resetWorkspace();
						refreshHistory();
					});
				return;
			}
			loadJob(li.dataset.id);
		}),
	);
}

async function loadJob(id) {
	const {job} = await api(`/api/jobs/${id}`);
	resetWorkspace();
	state.jobId = id;
	state.job = job;
	location.hash = id;
	$$('#history li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
	const {geminiKey, ...opts} = job.options;
	state.opts = {...state.opts, ...opts};
	syncOptions();
	$('#fixes').value = Object.entries(state.opts.fixes || {})
		.map(([a, b]) => `${a} = ${b}`)
		.join('\n');
	state.clips = job.clips.map((c) => ({...c, url: resolveUrl(c.url), key: c.id, up: 1}));
	renderClips();
	updateStart();
	$('#startHint').textContent = 'Có thể dựng lại với tuỳ chọn mới, hoặc thêm video.';
	if (job.state === 'error' || job.state === 'cancelled' || ['running', 'queued'].includes(job.state)) {
		$('#progressCard').classList.remove('hidden');
		renderProgress(job);
	}
	if (['running', 'queued'].includes(job.state)) startPoll();
	if (job.state === 'done') {
		await showResult(job);
	} else {
		// If timeline already exists on disk (e.g. step 1-6 succeeded), enable the Editor tab immediately
		openEditor(job.id, {getOptions: editorOptions, onExport: exportTimeline, setColor: setColorOpt})
			.then(() => {
				$('#tabEditor').disabled = false;
			})
			.catch(() => undefined);
		if (job.result) {
			$('#tabResult').disabled = false;
		}
	}
}

init().catch((e) => {
	console.error(e);
});
