// Unified Studio Hub — Real-Time Auto-Sync Database (IndexedDB + Cloud API + SQLite) & Global App Switcher
(() => {
	const IDB_NAME = 'STSUnifiedStudioDB';
	const IDB_VER = 1;
	let dbPromise = null;

	const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('sts_studio_realtime_v1') : null;

	function openUnifiedIdb() {
		if (dbPromise) return dbPromise;
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(IDB_NAME, IDB_VER);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains('records')) {
					const st = db.createObjectStore('records', {keyPath: 'pk'});
					st.createIndex('by_app_col', ['app', 'collection'], {unique: false});
				}
				if (!db.objectStoreNames.contains('blobs')) {
					db.createObjectStore('blobs', {keyPath: 'pk'});
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		return dbPromise;
	}

	async function idbGetAll(storeName) {
		try {
			const db = await openUnifiedIdb();
			return await new Promise((resolve) => {
				const tx = db.transaction(storeName, 'readonly');
				const req = tx.objectStore(storeName).getAll();
				req.onsuccess = () => resolve(req.result || []);
				req.onerror = () => resolve([]);
			});
		} catch {
			return [];
		}
	}

	async function idbGetAllByPrefix(storeName, prefix) {
		const all = await idbGetAll(storeName);
		return prefix ? all.filter((r) => String(r.pk || '').startsWith(prefix)) : all;
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

	// Discover all active backend endpoints (Vercel Cloud API '' and/or Local SQLite 'http://localhost:8790')
	let backendsCache = null;
	let lastDetectAt = 0;

	async function detectBackends(force = false) {
		if (!force && backendsCache && Date.now() - lastDetectAt < 15000) return backendsCache;
		lastDetectAt = Date.now();
		const candidates = [''];
		const custom = localStorage.getItem('sts_hub_backend');
		if (custom) candidates.push(custom.replace(/\/+$/, ''));
		if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
			candidates.push('http://localhost:8790');
		}
		const active = [];
		for (const base of [...new Set(candidates)]) {
			try {
				const ctrl = new AbortController();
				const to = setTimeout(() => ctrl.abort(), 1400);
				const r = await fetch(`${base}/api/hub/stats`, {signal: ctrl.signal});
				clearTimeout(to);
				const ct = r.headers.get('content-type') || '';
				if (r.ok && ct.includes('application/json')) {
					active.push(base);
				}
			} catch {}
		}
		backendsCache = active;
		return active;
	}

	function unwrapRecord(rec) {
		const d = rec.data;
		if (d && typeof d === 'object' && !Array.isArray(d)) {
			return {...d, id: rec.id, data: d, updatedAt: rec.updatedAt};
		}
		return {id: rec.id, data: d, value: d, updatedAt: rec.updatedAt};
	}

	let lastSyncTime = Date.now();
	let isSyncing = false;

	const STS_DB = {
		getLastSyncTime() {
			return lastSyncTime;
		},

		async list(app, collection) {
			const prefix = `${app}:${collection}:`;
			const local = await idbGetAllByPrefix('records', prefix);
			const byId = new Map();
			for (const item of local) {
				byId.set(String(item.id), item);
			}
			const backends = await detectBackends();
			for (const base of backends) {
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
									_deleted: Boolean(row._deleted),
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
				.filter((x) => !x._deleted && x.data !== null && x.data !== undefined)
				.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
				.map(unwrapRecord);
		},

		async get(app, collection, id) {
			const pk = `${app}:${collection}:${id}`;
			let best = await idbGet('records', pk);
			const backends = await detectBackends();
			for (const base of backends) {
				try {
					const r = await fetch(`${base}/api/hub/db/${encodeURIComponent(app)}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
					if (r.ok) {
						const j = await r.json();
						if (j.item !== null && j.item !== undefined) {
							const remoteTs = Number(j.updatedAt) || Date.now();
							if (!best || remoteTs > (best.updatedAt || 0)) {
								best = {pk, app, collection, id: String(id), data: j.item, _deleted: false, updatedAt: remoteTs};
								await idbPut('records', best);
							}
						}
					}
				} catch {}
			}
			if (!best || best._deleted) return null;
			return best.data;
		},

		async getWithMeta(app, collection, id) {
			const pk = `${app}:${collection}:${id}`;
			const rec = await idbGet('records', pk);
			if (!rec || rec._deleted) return null;
			return {data: rec.data, updatedAt: rec.updatedAt || 0};
		},

		async put(app, collection, id, data) {
			const pk = `${app}:${collection}:${id}`;
			const updatedAt = Date.now();
			const rec = {pk, app, collection, id: String(id), data, _deleted: false, updatedAt};
			await idbPut('records', rec);
			lastSyncTime = updatedAt;
			const backends = await detectBackends();
			for (const base of backends) {
				fetch(`${base}/api/hub/db/${encodeURIComponent(app)}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, {
					method: 'PUT',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({data, updatedAt}),
				}).catch(() => {});
			}
			try {
				bc?.postMessage({type: 'put', app, collection, id: String(id), updatedAt});
			} catch {}
			window.dispatchEvent(new CustomEvent('sts-db-updated', {detail: {app, collection, id: String(id), updatedAt}}));
			return data;
		},

		async delete(app, collection, id) {
			const pk = `${app}:${collection}:${id}`;
			const updatedAt = Date.now();
			await idbPut('records', {pk, app, collection, id: String(id), data: null, _deleted: true, updatedAt});
			await idbDelete('blobs', pk);
			lastSyncTime = updatedAt;
			const backends = await detectBackends();
			for (const base of backends) {
				fetch(`${base}/api/hub/db/${encodeURIComponent(app)}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, {
					method: 'DELETE',
				}).catch(() => {});
			}
			try {
				bc?.postMessage({type: 'delete', app, collection, id: String(id), updatedAt});
			} catch {}
			window.dispatchEvent(new CustomEvent('sts-db-updated', {detail: {app, collection, id: String(id), updatedAt}}));
		},

		async clear(app, collection) {
			const prefix = `${app}:${collection}:`;
			const rows = await idbGetAllByPrefix('records', prefix);
			const updatedAt = Date.now();
			for (const r of rows) {
				await idbPut('records', {...r, data: null, _deleted: true, updatedAt});
			}
			const backends = await detectBackends();
			for (const base of backends) {
				fetch(`${base}/api/hub/db/${encodeURIComponent(app)}/${encodeURIComponent(collection)}`, {
					method: 'DELETE',
				}).catch(() => {});
			}
			try {
				bc?.postMessage({type: 'clear', app, collection, updatedAt});
			} catch {}
			window.dispatchEvent(new CustomEvent('sts-db-updated', {detail: {app, collection, updatedAt}}));
		},

		async syncNow() {
			if (isSyncing) return false;
			isSyncing = true;
			let anyChanged = false;
			const changedApps = new Set();
			try {
				const localAll = await idbGetAll('records');
				const backends = await detectBackends();
				for (const base of backends) {
					try {
						const r = await fetch(`${base}/api/hub/sync`, {
							method: 'POST',
							headers: {'Content-Type': 'application/json'},
							body: JSON.stringify({
								records: localAll.map((x) => ({
									app: x.app,
									collection: x.collection,
									id: x.id,
									data: x.data,
									_deleted: Boolean(x._deleted),
									updatedAt: x.updatedAt || 0,
								})),
							}),
						});
						if (!r.ok) continue;
						const j = await r.json();
						const localByPk = new Map(localAll.map((x) => [x.pk, x]));
						for (const srv of j.records || []) {
							const pk = `${srv.app}:${srv.collection}:${srv.id}`;
							const loc = localByPk.get(pk);
							if (!loc || (srv.updatedAt || 0) > (loc.updatedAt || 0)) {
								await idbPut('records', {
									pk,
									app: srv.app,
									collection: srv.collection,
									id: String(srv.id),
									data: srv.data,
									_deleted: Boolean(srv._deleted),
									updatedAt: srv.updatedAt || Date.now(),
								});
								anyChanged = true;
								changedApps.add(srv.app);
							}
						}
						lastSyncTime = Date.now();
					} catch {}
				}
			} finally {
				isSyncing = false;
			}
			if (anyChanged) {
				window.dispatchEvent(new CustomEvent('sts-db-remote-updated', {detail: {apps: [...changedApps]}}));
				window.dispatchEvent(new CustomEvent('sts-db-updated', {detail: {remote: true, apps: [...changedApps]}}));
			}
			return anyChanged;
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
			const all = (await idbGetAll('records')).filter((r) => !r._deleted && r.data !== null && r.data !== undefined);
			const blobs = await idbGetAll('blobs');
			const counts = {
				'script-studio': 0,
				'auto-video-studio': 0,
				'vlive-psd-studio': 0,
				'sts-voice-studio': 0,
			};
			for (const r of all) {
				if (counts[r.app] !== undefined) {
					// If script-studio stores its proyectos array inside store:main, count projects!
					if (r.app === 'script-studio' && r.collection === 'store' && r.id === 'main' && Array.isArray(r.data?.projects)) {
						counts['script-studio'] = Math.max(counts['script-studio'], r.data.projects.length);
					} else {
						counts[r.app]++;
					}
				}
			}
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

			const backends = await detectBackends();
			let engine = 'IndexedDB (Realtime Auto-Save)';
			let sqliteConnected = false;
			for (const base of backends) {
				try {
					const r = await fetch(`${base}/api/hub/stats`);
					if (r.ok) {
						const j = await r.json();
						sqliteConnected = true;
						engine = j.db?.engine ? `${j.db.engine} + IndexedDB` : 'Cloud SQLite + IndexedDB';
						if (j.db?.jobs) counts['auto-video-studio'] = Math.max(counts['auto-video-studio'], j.db.jobs);
						for (const [k, v] of Object.entries(j.db?.apps || {})) {
							if (counts[k] !== undefined) counts[k] = Math.max(counts[k], Number(v) || 0);
						}
					}
				} catch {}
			}
			return {
				engine,
				counts,
				totalRecords: all.length,
				totalBlobs: blobs.length,
				sqliteConnected,
				lastSyncTime,
			};
		},
	};

	window.STS_DB = STS_DB;

	// Listen for cross-tab changes via BroadcastChannel
	if (bc) {
		bc.onmessage = (ev) => {
			const msg = ev.data || {};
			if (msg.type === 'put' || msg.type === 'delete' || msg.type === 'clear') {
				window.dispatchEvent(new CustomEvent('sts-db-remote-updated', {detail: {apps: [msg.app], fromTab: true}}));
				window.dispatchEvent(new CustomEvent('sts-db-updated', {detail: {remote: true, apps: [msg.app]}}));
			}
		};
	}

	// Continuous background sync every 3.5 seconds + on tab focus/visibility
	setInterval(() => {
		if (document.visibilityState === 'visible') {
			STS_DB.syncNow().catch(() => {});
		}
	}, 3500);
	window.addEventListener('focus', () => STS_DB.syncNow().catch(() => {}));
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') STS_DB.syncNow().catch(() => {});
	});

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

	function mountGlobalBar() {
		const cur = detectCurrentApp();
		if (cur === 'hub') return;
		if (document.getElementById('sts-global-hub-bar')) return;

		const root = getHubRoot().replace(/\/+$/, '');

		// Ensure favicon uses the official app icon
		let fav = document.querySelector('link[rel="icon"]');
		if (!fav) {
			fav = document.createElement('link');
			fav.rel = 'icon';
			fav.type = 'image/png';
			document.head.appendChild(fav);
		}
		fav.href = `${root}/icon.png`;

		const style = document.createElement('style');
		style.textContent = `
			:root {
				--brand-primary: #2C368A;
				--brand-primary-light: #3E4CC0;
				--brand-glow: rgba(44, 54, 138, 0.45);
				--bg: #09090B !important;
				--bg2: #121215 !important;
				--card: rgba(24, 24, 28, 0.58) !important;
				--accent: #2C368A !important;
				--blue: #2C368A !important;
			}
			body {
				background:
					radial-gradient(600px circle at 15% 10%, rgba(44, 54, 138, 0.22), transparent 60%),
					radial-gradient(500px circle at 85% 15%, rgba(44, 54, 138, 0.14), transparent 58%),
					#09090B !important;
				color: #FAFAFA;
			}
			/* iOS 26 Liquid Glass surfaces across all 4 Studio apps */
			.card, .panel, .topbar, header.top, .sidebar, .login-card, .modal-card, .ed-side, .ed-tl, .view-tabs {
				background: linear-gradient(145deg, rgba(255, 255, 255, 0.07) 0%, rgba(22, 22, 26, 0.62) 48%, rgba(14, 14, 18, 0.76) 100%) !important;
				backdrop-filter: blur(28px) saturate(185%) !important;
				-webkit-backdrop-filter: blur(28px) saturate(185%) !important;
				border: 1px solid rgba(255, 255, 255, 0.11) !important;
				box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.18), 0 18px 42px -12px rgba(0, 0, 0, 0.6) !important;
			}
			button.primary, .btn.primary, .btn.blue, .tbtn.primary, .view-tab.on, .tab.active {
				background: linear-gradient(180deg, #3B49B8 0%, #2C368A 100%) !important;
				border-color: rgba(255, 255, 255, 0.22) !important;
				box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.3), 0 8px 22px -4px rgba(44, 54, 138, 0.65) !important;
				color: #FFFFFF !important;
			}
			#sts-global-hub-bar {
				position: sticky;
				top: 0;
				z-index: 99999;
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
				padding: 7px 16px;
				background: linear-gradient(180deg, rgba(28, 28, 34, 0.72) 0%, rgba(14, 14, 18, 0.82) 100%);
				backdrop-filter: blur(32px) saturate(190%);
				-webkit-backdrop-filter: blur(32px) saturate(190%);
				border-bottom: 1px solid rgba(255, 255, 255, 0.12);
				box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.18), 0 10px 30px rgba(0, 0, 0, 0.5);
				font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Segoe UI", Roboto, sans-serif;
				font-size: 12px;
				color: #FAFAFA;
			}
			#sts-global-hub-bar .sgh-left,
			#sts-global-hub-bar .sgh-center,
			#sts-global-hub-bar .sgh-right {
				display: flex;
				align-items: center;
				gap: 6px;
				flex-wrap: wrap;
			}
			#sts-global-hub-bar a {
				text-decoration: none;
				color: #D4D4D8;
				padding: 5px 12px;
				border-radius: 999px;
				font-weight: 600;
				transition: all 0.16s ease;
				display: inline-flex;
				align-items: center;
				gap: 6px;
				border: 1px solid transparent;
			}
			#sts-global-hub-bar a:hover {
				color: #FFFFFF;
				background: rgba(255, 255, 255, 0.08);
				border-color: rgba(255, 255, 255, 0.14);
			}
			#sts-global-hub-bar a.sgh-hub-btn {
				background: rgba(255, 255, 255, 0.06);
				border-color: rgba(255, 255, 255, 0.15);
				box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.16);
				color: #FAFAFA;
				padding: 4px 12px 4px 6px;
			}
			#sts-global-hub-bar .sgh-brand-icon {
				width: 22px;
				height: 22px;
				border-radius: 6px;
				object-fit: cover;
			}
			#sts-global-hub-bar .sgh-brand-logo {
				height: 15px;
				width: auto;
				object-fit: contain;
			}
			#sts-global-hub-bar a.sgh-app.active {
				background: linear-gradient(180deg, #3B49B8 0%, #2C368A 100%);
				border-color: rgba(255, 255, 255, 0.24);
				color: #FFFFFF;
				box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.32), 0 4px 14px rgba(44, 54, 138, 0.65);
			}
			#sts-global-hub-bar .sgh-db-pill {
				font-size: 11px;
				padding: 4px 11px;
				border-radius: 999px;
				background: rgba(255, 255, 255, 0.055);
				border: 1px solid rgba(255, 255, 255, 0.14);
				box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.14);
				color: #E4E4E7;
				font-weight: 600;
				display: inline-flex;
				align-items: center;
				gap: 6px;
			}
			#sts-global-hub-bar .sgh-sync-btn {
				font-size: 11px;
				padding: 4px 11px;
				border-radius: 999px;
				background: linear-gradient(180deg, #3B49B8 0%, #2C368A 100%);
				border: 1px solid rgba(255, 255, 255, 0.22);
				box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.28);
				color: #FFFFFF;
				font-weight: 600;
				cursor: pointer;
			}
			#sts-global-hub-bar .sgh-sync-btn:hover {
				filter: brightness(1.12);
			}
			@keyframes sghPulse {
				0%, 100% { opacity: 1; }
				50% { opacity: 0.35; }
			}
			.sgh-live-dot {
				width: 7px;
				height: 7px;
				border-radius: 50%;
				background: #34D399;
				display: inline-block;
				animation: sghPulse 2s infinite;
			}
		`;
		document.head.appendChild(style);

		const bar = document.createElement('div');
		bar.id = 'sts-global-hub-bar';
		bar.innerHTML = `
			<div class="sgh-left">
				<a class="sgh-hub-btn" href="${root}/" title="Quay về trang chủ chọn ứng dụng Vlive Studio Hub">
					<img class="sgh-brand-icon" src="${root}/icon.png" alt="Vlive" />
					<img class="sgh-brand-logo" src="${root}/logo.png" alt="Vlive" />
					<span>Studio Hub</span>
				</a>
			</div>
			<div class="sgh-center">
				<a class="sgh-app ${cur === 'script-studio' ? 'active' : ''}" href="${root}/script-studio/">📜 Script Studio</a>
				<a class="sgh-app ${cur === 'auto-video-studio' ? 'active' : ''}" href="${root}/video-studio/">🎬 Auto Video Studio</a>
				<a class="sgh-app ${cur === 'vlive-psd-studio' ? 'active' : ''}" href="${root}/psd-studio/">🎨 Vlive PSD Studio</a>
				<a class="sgh-app ${cur === 'sts-voice-studio' ? 'active' : ''}" href="${root}/voice-studio/">🎙️ STS Voice Studio</a>
			</div>
			<div class="sgh-right">
				<span class="sgh-db-pill" id="sghDbStatus"><span class="sgh-live-dot"></span> Tự động đồng bộ DB…</span>
				<button type="button" class="sgh-sync-btn" id="sghSyncNowBtn" title="Đồng bộ dữ liệu mới nhất ngay lập tức">🔄 Đồng bộ ngay</button>
			</div>
		`;
		document.body.prepend(bar);

		const refreshDbPill = async () => {
			const st = await STS_DB.stats();
			const el = document.getElementById('sghDbStatus');
			if (el) {
				const n = st.counts[cur] ?? 0;
				const timeStr = new Date(st.lastSyncTime || Date.now()).toLocaleTimeString('vi-VN', {hour12: false});
				el.innerHTML = `<span class="sgh-live-dot"></span> Live DB · ${n} dự án · cập nhật ${timeStr}`;
				el.title = `Engine: ${st.engine}`;
			}
		};
		document.getElementById('sghSyncNowBtn').onclick = async (e) => {
			const btn = e.currentTarget;
			btn.textContent = '⏳ Đang đồng bộ…';
			await STS_DB.syncNow();
			await refreshDbPill();
			btn.textContent = '✅ Đã đồng bộ';
			setTimeout(() => {
				btn.textContent = '🔄 Đồng bộ ngay';
			}, 1500);
		};

		STS_DB.syncNow().then(refreshDbPill).catch(refreshDbPill);
		window.addEventListener('sts-db-updated', refreshDbPill);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', mountGlobalBar);
	} else {
		mountGlobalBar();
	}
})();
