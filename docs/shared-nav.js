// STS Unified Studio — Shared Navigation Bar, Single Sign-On (sts / 1111), and Universal Database Engine (IndexedDB + SQLite)
(() => {
	const IDB_NAME = 'STSUnifiedStudioDB';
	const IDB_VER = 1;
	const STORES = ['records', 'blobs'];

	let dbPromise = null;
	function openUnifiedIdb() {
		if (dbPromise) return dbPromise;
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(IDB_NAME, IDB_VER);
			req.onupgradeneeded = () => {
				const db = req.result;
				for (const s of STORES) {
					if (!db.objectStoreNames.contains(s)) {
						db.createObjectStore(s, {keyPath: 'pk'});
					}
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		return dbPromise;
	}

	async function idbGet(storeName, pk) {
		try {
			const db = await openUnifiedIdb();
			return await new Promise((resolve) => {
				const tx = db.transaction(storeName, 'readonly');
				const req = tx.objectStore(storeName).get(pk);
				req.onsuccess = () => resolve(req.result || null);
				req.onerror = () => resolve(null);
			});
		} catch {
			return null;
		}
	}

	async function idbGetAllByPrefix(storeName, prefix) {
		try {
			const db = await openUnifiedIdb();
			return await new Promise((resolve) => {
				const tx = db.transaction(storeName, 'readonly');
				const req = tx.objectStore(storeName).getAll();
				req.onsuccess = () => {
					const all = req.result || [];
					resolve(prefix ? all.filter((x) => String(x.pk || '').startsWith(prefix)) : all);
				};
				req.onerror = () => resolve([]);
			});
		} catch {
			return [];
		}
	}

	async function idbPut(storeName, obj) {
		try {
			const db = await openUnifiedIdb();
			await new Promise((resolve) => {
				const tx = db.transaction(storeName, 'readwrite');
				tx.objectStore(storeName).put(obj);
				tx.oncomplete = () => resolve(true);
				tx.onerror = () => resolve(false);
			});
		} catch {}
	}

	async function idbDelete(storeName, pk) {
		try {
			const db = await openUnifiedIdb();
			await new Promise((resolve) => {
				const tx = db.transaction(storeName, 'readwrite');
				tx.objectStore(storeName).delete(pk);
				tx.oncomplete = () => resolve(true);
				tx.onerror = () => resolve(false);
			});
		} catch {}
	}

	// Optional sync to local SQLite backend (http://localhost:8790/api/hub/db/...)
	let sqliteBase = null;
	async function detectSqliteBackend() {
		if (sqliteBase !== null) return sqliteBase;
		const candidates = [];
		if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') candidates.push('');
		candidates.push('http://localhost:8790');
		for (const base of candidates) {
			try {
				const ctrl = new AbortController();
				const to = setTimeout(() => ctrl.abort(), 1200);
				const r = await fetch(`${base}/api/hub/stats`, {signal: ctrl.signal});
				clearTimeout(to);
				if (r.ok) {
					sqliteBase = base;
					return sqliteBase;
				}
			} catch {}
		}
		sqliteBase = false;
		return false;
	}

	const STS_DB = {
		async list(app, collection) {
			const prefix = `${app}:${collection}:`;
			const local = await idbGetAllByPrefix('records', prefix);
			const byId = new Map();
			for (const item of local) {
				byId.set(String(item.id), item);
			}
			const base = await detectSqliteBackend();
			if (base !== false) {
				try {
					const r = await fetch(`${base}/api/hub/db/${encodeURIComponent(app)}/${encodeURIComponent(collection)}`);
					if (r.ok) {
						const j = await r.json();
						for (const row of j.items || []) {
							const existing = byId.get(String(row.id));
							if (!existing || (row.updatedAt || 0) > (existing.updatedAt || 0)) {
								const rec = {
									pk: `${app}:${collection}:${row.id}`,
									app,
									collection,
									id: String(row.id),
									data: row.data,
									updatedAt: row.updatedAt || Date.now(),
								};
								byId.set(String(row.id), rec);
								await idbPut('records', rec);
							}
						}
					}
				} catch {}
			}
			return [...byId.values()]
				.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
				.map((x) => ({id: x.id, data: x.data, updatedAt: x.updatedAt}));
		},

		async get(app, collection, id) {
			const pk = `${app}:${collection}:${id}`;
			const local = await idbGet('records', pk);
			if (local) return local.data;
			const base = await detectSqliteBackend();
			if (base !== false) {
				try {
					const r = await fetch(`${base}/api/hub/db/${encodeURIComponent(app)}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
					if (r.ok) {
						const j = await r.json();
						if (j.item !== null && j.item !== undefined) {
							await idbPut('records', {pk, app, collection, id: String(id), data: j.item, updatedAt: Date.now()});
							return j.item;
						}
					}
				} catch {}
			}
			return null;
		},

		async put(app, collection, id, data) {
			const pk = `${app}:${collection}:${id}`;
			const updatedAt = Date.now();
			await idbPut('records', {pk, app, collection, id: String(id), data, updatedAt});
			const base = await detectSqliteBackend();
			if (base !== false) {
				fetch(`${base}/api/hub/db/${encodeURIComponent(app)}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, {
					method: 'PUT',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({data}),
				}).catch(() => {});
			}
			window.dispatchEvent(new CustomEvent('sts-db-updated', {detail: {app, collection, id}}));
			return data;
		},

		async delete(app, collection, id) {
			const pk = `${app}:${collection}:${id}`;
			await idbDelete('records', pk);
			await idbDelete('blobs', pk);
			const base = await detectSqliteBackend();
			if (base !== false) {
				fetch(`${base}/api/hub/db/${encodeURIComponent(app)}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, {
					method: 'DELETE',
				}).catch(() => {});
			}
			window.dispatchEvent(new CustomEvent('sts-db-updated', {detail: {app, collection, id}}));
		},

		async putBlob(app, collection, id, blob, meta = {}) {
			const pk = `${app}:${collection}:${id}`;
			await idbPut('blobs', {pk, app, collection, id: String(id), blob, meta, updatedAt: Date.now()});
		},

		async getBlob(app, collection, id) {
			const pk = `${app}:${collection}:${id}`;
			const row = await idbGet('blobs', pk);
			return row ? row.blob : null;
		},

		async stats() {
			const all = await idbGetAllByPrefix('records', '');
			const blobs = await idbGetAllByPrefix('blobs', '');
			const counts = {
				'script-studio': 0,
				'auto-video-studio': 0,
				'vlive-psd-studio': 0,
				'sts-voice-studio': 0,
			};
			for (const r of all) {
				if (counts[r.app] !== undefined) counts[r.app]++;
			}
			// Also count AutoVideoStudioDB jobs if present
			try {
				const avsJobs = await new Promise((resolve) => {
					const req = indexedDB.open('AutoVideoStudioDB', 1);
					req.onsuccess = () => {
						const db = req.result;
						if (!db.objectStoreNames.contains('jobs')) return resolve(0);
						const q = db.transaction('jobs', 'readonly').objectStore('jobs').count();
						q.onsuccess = () => resolve(q.result || 0);
						q.onerror = () => resolve(0);
					};
					req.onerror = () => resolve(0);
				});
				counts['auto-video-studio'] = Math.max(counts['auto-video-studio'], avsJobs);
			} catch {}
			const base = await detectSqliteBackend();
			let engine = 'IndexedDB (Browser Database)';
			if (base !== false) {
				try {
					const r = await fetch(`${base}/api/hub/stats`);
					if (r.ok) {
						const j = await r.json();
						engine = 'SQLite (data/studio.db) + IndexedDB';
						if (j.db?.jobs) counts['auto-video-studio'] = Math.max(counts['auto-video-studio'], j.db.jobs);
						for (const [k, v] of Object.entries(j.db?.apps || {})) {
							if (counts[k] !== undefined) counts[k] = Math.max(counts[k], Number(v) || 0);
						}
					}
				} catch {}
			}
			return {engine, counts, totalRecords: all.length, totalBlobs: blobs.length, sqliteConnected: base !== false};
		},
	};

	window.STS_DB = STS_DB;

	// ---- Single Sign-On Helper (user: sts, pass: 1111)
	const STS_VOICE_HASH = 'b0336d1da7a2cac035e27ee79276d3d5d5b2c784502de9de8860078bbc5db1a8';
	const PSD_TOKEN = '20f97d2f8acb1257cb22d5280ef2b2a43d82308325aef14566f369dc41d68e75';

	function syncSsoTokens() {
		if (
			localStorage.getItem('sts_hub_auth') === '1' ||
			localStorage.getItem('avs.browser_auth') === '1' ||
			localStorage.getItem('auth') === STS_VOICE_HASH ||
			sessionStorage.getItem('auth') === STS_VOICE_HASH ||
			localStorage.getItem('ss_auth_token') ||
			localStorage.getItem('psdstudio-auth-token')
		) {
			localStorage.setItem('sts_hub_auth', '1');
			localStorage.setItem('avs.browser_auth', '1');
			localStorage.setItem('auth', STS_VOICE_HASH);
			sessionStorage.setItem('auth', STS_VOICE_HASH);
			if (!localStorage.getItem('ss_auth_token')) {
				localStorage.setItem('ss_auth_token', 'sts-admin-token');
			}
			const psdPayload = JSON.stringify({user: 'sts', token: PSD_TOKEN});
			localStorage.setItem('psdstudio-auth', psdPayload);
			sessionStorage.setItem('psdstudio-auth', psdPayload);
			localStorage.setItem('psdstudio-auth-token', psdPayload);
			sessionStorage.setItem('psdstudio-auth-token', psdPayload);
		}
	}
	syncSsoTokens();

	window.STS_SSO = {
		isAuthed() {
			return (
				localStorage.getItem('sts_hub_auth') === '1' ||
				localStorage.getItem('avs.browser_auth') === '1' ||
				Boolean(localStorage.getItem('ss_auth_token'))
			);
		},
		login(u, p) {
			if (String(u).trim() === 'sts' && String(p).trim() === '1111') {
				localStorage.setItem('sts_hub_auth', '1');
				syncSsoTokens();
				return true;
			}
			return false;
		},
		logout() {
			for (const k of ['sts_hub_auth', 'avs.browser_auth', 'auth', 'ss_auth_token', 'psdstudio-auth', 'psdstudio-auth-token']) {
				localStorage.removeItem(k);
				sessionStorage.removeItem(k);
			}
		},
	};

	// ---- Determine base path to Hub root
	function getHubRoot() {
		const p = location.pathname;
		for (const slug of ['/video-studio', '/script-studio', '/psd-studio', '/voice-studio']) {
			const idx = p.indexOf(slug);
			if (idx >= 0) {
				return p.slice(0, idx) || '/';
			}
		}
		return p.replace(/\/index\.html$/, '').replace(/\/+$/, '') || '/';
	}

	function detectCurrentApp() {
		const p = location.pathname;
		if (p.includes('/script-studio')) return 'script-studio';
		if (p.includes('/video-studio')) return 'auto-video-studio';
		if (p.includes('/psd-studio')) return 'vlive-psd-studio';
		if (p.includes('/voice-studio')) return 'sts-voice-studio';
		return 'hub';
	}

	// ---- Inject Top Studio Switcher Bar inside the 4 Studio apps
	function mountGlobalBar() {
		const cur = detectCurrentApp();
		if (cur === 'hub') return; // Hub has its own full header
		if (document.getElementById('sts-global-hub-bar')) return;

		const root = getHubRoot().replace(/\/+$/, '');
		const style = document.createElement('style');
		style.textContent = `
			#sts-global-hub-bar {
				position: sticky;
				top: 0;
				z-index: 99999;
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
				padding: 6px 14px;
				background: linear-gradient(90deg, #090d16 0%, #111827 50%, #090d16 100%);
				border-bottom: 1px solid rgba(99, 102, 241, 0.28);
				font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
				font-size: 12.5px;
				color: #e5e7eb;
				box-shadow: 0 2px 12px rgba(0,0,0,0.45);
			}
			#sts-global-hub-bar .sgh-left,
			#sts-global-hub-bar .sgh-center,
			#sts-global-hub-bar .sgh-right {
				display: flex;
				align-items: center;
				gap: 6px;
				flex-wrap: wrap;
			}
			#sts-global-hub-bar a.sgh-hub-btn {
				display: inline-flex;
				align-items: center;
				gap: 6px;
				padding: 4px 11px;
				border-radius: 999px;
				background: rgba(99, 102, 241, 0.18);
				border: 1px solid rgba(99, 102, 241, 0.45);
				color: #c7d2fe;
				font-weight: 600;
				text-decoration: none;
				transition: all 0.15s ease;
			}
			#sts-global-hub-bar a.sgh-hub-btn:hover {
				background: rgba(99, 102, 241, 0.32);
				color: #fff;
			}
			#sts-global-hub-bar a.sgh-app {
				display: inline-flex;
				align-items: center;
				gap: 5px;
				padding: 4px 10px;
				border-radius: 7px;
				color: #9ca3af;
				text-decoration: none;
				font-weight: 500;
				border: 1px solid transparent;
				transition: all 0.15s ease;
			}
			#sts-global-hub-bar a.sgh-app:hover {
				color: #f3f4f6;
				background: rgba(255,255,255,0.06);
			}
			#sts-global-hub-bar a.sgh-app.active {
				color: #ffffff;
				background: rgba(59, 130, 246, 0.22);
				border-color: rgba(59, 130, 246, 0.55);
				font-weight: 600;
			}
			#sts-global-hub-bar .sgh-db-pill {
				display: inline-flex;
				align-items: center;
				gap: 5px;
				padding: 3px 9px;
				border-radius: 999px;
				background: rgba(16, 185, 129, 0.14);
				border: 1px solid rgba(16, 185, 129, 0.4);
				color: #6ee7b7;
				font-size: 11.5px;
				font-weight: 600;
			}
		`;
		document.head.appendChild(style);

		const bar = document.createElement('div');
		bar.id = 'sts-global-hub-bar';
		bar.innerHTML = `
			<div class="sgh-left">
				<a class="sgh-hub-btn" href="${root}/" title="Quay về trang chủ chọn ứng dụng Studio">🏠 Chọn Dự Án (Studio Hub)</a>
			</div>
			<div class="sgh-center">
				<a class="sgh-app ${cur === 'script-studio' ? 'active' : ''}" href="${root}/script-studio/">📜 Script Studio</a>
				<a class="sgh-app ${cur === 'auto-video-studio' ? 'active' : ''}" href="${root}/video-studio/">🎬 Auto Video Studio</a>
				<a class="sgh-app ${cur === 'vlive-psd-studio' ? 'active' : ''}" href="${root}/psd-studio/">🎨 Vlive PSD Studio</a>
				<a class="sgh-app ${cur === 'sts-voice-studio' ? 'active' : ''}" href="${root}/voice-studio/">🎙️ STS Voice Studio</a>
			</div>
			<div class="sgh-right">
				<span class="sgh-db-pill" id="sghDbStatus">🗄 Database: Đang đồng bộ…</span>
			</div>
		`;
		document.body.prepend(bar);

		const refreshDbPill = async () => {
			const st = await STS_DB.stats();
			const el = document.getElementById('sghDbStatus');
			if (el) {
				const n = st.counts[cur] ?? 0;
				el.textContent = `🗄 ${st.sqliteConnected ? 'SQLite + IndexedDB' : 'IndexedDB'} · ${n} bản ghi`;
				el.title = `Engine: ${st.engine}`;
			}
		};
		refreshDbPill();
		window.addEventListener('sts-db-updated', refreshDbPill);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', mountGlobalBar);
	} else {
		mountGlobalBar();
	}
})();
