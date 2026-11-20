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

		// Ensure Manrope Google Font is loaded in all Studio apps
		if (!document.querySelector('link[href*="family=Manrope"]')) {
			const fontLink = document.createElement('link');
			fontLink.rel = 'stylesheet';
			fontLink.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap';
			document.head.appendChild(fontLink);
		}

		const style = document.createElement('style');
		style.textContent = `
			:root {
				--brand-primary: #2C368A;
				--brand-primary-light: #4A5BE0;
				--brand-glow: rgba(44, 54, 138, 0.55);
				--bg: #090A0E !important;
				--bg2: #12141C !important;
				--bg3: #1B1E2A !important;
				--panel: #14161F !important;
				--panel2: #1B1E2B !important;
				--panel3: #0D0F16 !important;
				--surface: #14161F !important;
				--surface2: #1B1E2B !important;
				--surface-2: #1B1E2B !important;
				--surface3: #232738 !important;
				--card: rgba(24, 26, 36, 0.68) !important;
				--line: rgba(255, 255, 255, 0.16) !important;
				--line2: rgba(255, 255, 255, 0.24) !important;
				--line-hi: rgba(255, 255, 255, 0.28) !important;
				--text: #FFFFFF !important;
				--txt: #FFFFFF !important;
				--txt2: #DCE2F2 !important;
				--muted: #B8C0D4 !important;
				--mut: #B8C0D4 !important;
				--accent: #94A5FF !important;
				--accent2: #687BFF !important;
				--pri: #4A5BE0 !important;
				--pri2: #2C368A !important;
				--primary: #4A5BE0 !important;
				--primary-d: #2C368A !important;
				--primary-l: rgba(74, 91, 224, 0.22) !important;
				--font-sans: 'Manrope', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
			}
			body, button, input, select, textarea, .app, .shell, .workspace {
				font-family: 'Manrope', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
			}
			body {
				background:
					radial-gradient(650px circle at 15% 10%, rgba(44, 54, 138, 0.26), transparent 60%),
					radial-gradient(550px circle at 85% 15%, rgba(44, 54, 138, 0.16), transparent 58%),
					#090A0E !important;
				color: #FFFFFF !important;
			}
			/* iOS 26 Liquid Glass surfaces across all 4 Studio apps with clear border contrast */
			.card, aside.panel, .topbar, header.top, .sidebar, .login-card, .modal-card, .modal, .ed-side, .ed-tl, .view-tabs {
				background: linear-gradient(145deg, rgba(255, 255, 255, 0.08) 0%, rgba(22, 24, 34, 0.72) 48%, rgba(15, 16, 24, 0.84) 100%) !important;
				backdrop-filter: blur(28px) saturate(185%) !important;
				-webkit-backdrop-filter: blur(28px) saturate(185%) !important;
				border: 1px solid rgba(255, 255, 255, 0.16) !important;
				box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.22), 0 18px 42px -12px rgba(0, 0, 0, 0.65) !important;
			}
			/* High-contrast active / primary buttons & pills (#2C368A Liquid Glass + pure white text) */
			button.primary, a.primary, .btn.primary, .btn.blue, .tbtn.primary, .view-tab.on, .tab.active, .ep-tab.active, .seg button.on, .num, .view-tab.on .step-dot, .clip .badge, .chip.on {
				background: linear-gradient(180deg, #4757D4 0%, #2C368A 100%) !important;
				border: 1px solid rgba(160, 176, 255, 0.5) !important;
				box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.35), 0 6px 20px -4px rgba(44, 54, 138, 0.7) !important;
				color: #FFFFFF !important;
				text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
			}
			button.primary:disabled, .btn.primary:disabled, .tbtn.primary:disabled {
				background: linear-gradient(180deg, rgba(71, 87, 212, 0.45) 0%, rgba(44, 54, 138, 0.45) 100%) !important;
				border-color: rgba(160, 176, 255, 0.32) !important;
				color: rgba(255, 255, 255, 0.85) !important;
				opacity: 1 !important;
			}
			/* High-contrast unselected buttons, inputs, selects, and labels */
			.seg button:not(.on), button.ghost, a.ghost, .btn:not(.primary):not(.blue):not(.ok):not(.danger), .tbtn:not(.primary) {
				color: #E2E8F5 !important;
			}
			.style small, .muted, .qb-lbl, label, th, .brand p, .view-tab small {
				color: #C2CAE0 !important;
			}
			select, textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]) {
				background: rgba(10, 12, 18, 0.88) !important;
				color: #FFFFFF !important;
				border: 1px solid rgba(255, 255, 255, 0.22) !important;
			}
			select:focus, textarea:focus, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):focus {
				border-color: #94A5FF !important;
				box-shadow: 0 0 0 3px rgba(74, 91, 224, 0.35) !important;
			}
			/* Script Studio screenplay paper: preserve selected script font (Courier New, etc.), remove dark boxes, use dark charcoal text */
			.script-paper {
				background: #FCFBF7 !important;
				color: #27272A !important;
			}
			.script-paper textarea,
			.script-paper .sb textarea,
			.script-paper table.doc-tbl textarea {
				font-family: inherit !important;
				background: transparent !important;
				color: #27272A !important;
				border: 0 !important;
				box-shadow: none !important;
			}
			.script-paper .sb textarea:focus,
			.script-paper table.doc-tbl textarea:focus {
				background: rgba(254, 249, 195, 0.45) !important;
				color: #18181B !important;
				border: 0 !important;
				box-shadow: none !important;
			}
			.script-paper .sb-backdrop {
				font-family: inherit !important;
				color: transparent !important;
			}
			.script-paper .sb.t-general textarea {
				color: #52525B !important;
			}
			.script-paper .gutter {
				color: #71717A !important;
			}
			/* Script Studio spreadsheet cells: keep clean borderless cells inside table.sheet */
			table.sheet td .cell,
			table.sheet td select.cell-select,
			table.sheet td input.cell-input,
			table.sheet th .gs-th-input {
				background: transparent !important;
				border: 0 !important;
				box-shadow: none !important;
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
				font-family: 'Manrope', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
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
			#sts-global-hub-bar .sgh-ai-btn {
				font-size: 11.5px;
				padding: 4px 11px;
				border-radius: 999px;
				background: linear-gradient(180deg, #4555CE 0%, #2C368A 100%);
				border: 1px solid rgba(160, 176, 255, 0.5);
				box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), 0 4px 12px rgba(44, 54, 138, 0.55);
				color: #FFFFFF;
				font-weight: 700;
				cursor: pointer;
				display: inline-flex;
				align-items: center;
				gap: 5px;
			}
			#sts-global-hub-bar .sgh-ai-btn:hover {
				filter: brightness(1.12);
			}
			/* Universal agy CLI Slide-Over Drawer for all 4 Studio Tools */
			#vlive-agy-drawer {
				position: fixed;
				top: 48px;
				right: 14px;
				width: 420px;
				max-width: calc(100vw - 28px);
				max-height: calc(100vh - 64px);
				z-index: 100001;
				border-radius: 20px;
				padding: 18px 20px;
				background: linear-gradient(155deg, rgba(28, 32, 48, 0.94) 0%, rgba(13, 15, 24, 0.98) 100%);
				backdrop-filter: blur(32px) saturate(190%);
				-webkit-backdrop-filter: blur(32px) saturate(190%);
				border: 1px solid rgba(152, 168, 255, 0.34);
				box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 26px 64px rgba(0, 0, 0, 0.78);
				color: #FFFFFF;
				font-family: 'Manrope', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
				display: flex;
				flex-direction: column;
				gap: 12px;
				overflow: auto;
			}
			#vlive-agy-drawer.hidden { display: none !important; }
			#vlive-agy-drawer .vad-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
			#vlive-agy-drawer .vad-head b { font-size: 14.5px; }
			#vlive-agy-drawer .vad-close { width: 28px; height: 28px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: #fff; cursor: pointer; }
			#vlive-agy-drawer .vad-row { display: flex; gap: 8px; align-items: center; }
			#vlive-agy-drawer select, #vlive-agy-drawer textarea {
				width: 100%;
				padding: 9px 11px;
				border-radius: 10px;
				border: 1px solid rgba(255,255,255,0.2);
				background: rgba(8,10,16,0.9);
				color: #FFFFFF;
				font-size: 13px;
				font-family: inherit;
			}
			#vlive-agy-drawer .vad-chips { display: flex; flex-wrap: wrap; gap: 6px; }
			#vlive-agy-drawer .vad-chip {
				font-size: 11.5px;
				padding: 4px 9px;
				border-radius: 999px;
				border: 1px solid rgba(145,162,255,0.32);
				background: rgba(44,54,138,0.28);
				color: #E2E8F5;
				cursor: pointer;
			}
			#vlive-agy-drawer .vad-chip:hover { background: rgba(69,85,206,0.5); color: #fff; }
			#vlive-agy-drawer .vad-out {
				padding: 11px 13px;
				border-radius: 11px;
				background: rgba(7,9,14,0.92);
				border: 1px solid rgba(255,255,255,0.12);
				font-size: 12.5px;
				line-height: 1.55;
				color: #E6ECF8;
				white-space: pre-wrap;
				max-height: 260px;
				overflow: auto;
			}
			#vlive-agy-drawer .vad-status { font-size: 11.5px; color: #B8C2D6; }
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
				<a class="sgh-hub-btn" href="${root}/" title="Quay về trang chủ chọn ứng dụng Vlive Studio Hub" style="padding:5px 14px">
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
				<button type="button" class="sgh-ai-btn" id="sghAgyBtn" title="Mở trợ lý AI dùng agy CLI trên máy tính & chọn mô hình">✦ AI (agy CLI)</button>
				<span class="sgh-db-pill" id="sghDbStatus"><span class="sgh-live-dot"></span> Tự động đồng bộ DB…</span>
				<button type="button" class="sgh-sync-btn" id="sghSyncNowBtn" title="Đồng bộ dữ liệu chung giữa cả 4 Studio ngay lập tức">🔄 Đồng bộ</button>
			</div>
		`;
		document.body.prepend(bar);

		// Build Universal agy CLI Drawer for this Studio tool
		const TOOL_CHIPS = {
			'script-studio': ['Tóm tắt & gợi ý sửa kịch bản', 'Phân tách cảnh quay (Shot list)', 'Viết thêm thoại tự nhiên hơn'],
			'auto-video-studio': ['Soát lỗi chính tả phụ đề tiếng Việt', 'Gợi ý 5 hook mở đầu 3 giây viral', 'Viết CTA kêu gọi Follow cuối video'],
			'vlive-psd-studio': ['Viết prompt Gemini xóa nền sạch', 'Gợi ý bố cục & màu sắc thumbnail', 'Đề xuất tiêu đề chữ nổi bật trên ảnh'],
			'sts-voice-studio': ['Gắn tag cảm xúc ElevenLabs v3 cho thoại', 'Chỉnh lời thoại đọc tự nhiên hơn', 'Gợi ý mô tả giọng đọc Voice Design'],
		};
		const drawer = document.createElement('div');
		drawer.id = 'vlive-agy-drawer';
		drawer.className = 'hidden';
		drawer.innerHTML = `
			<div class="vad-head">
				<b>✦ Trợ lý AI — Antigravity CLI (<code>agy</code>)</b>
				<button type="button" class="vad-close" id="vadCloseBtn">✕</button>
			</div>
			<div class="vad-status" id="vadStatusText">Đang kiểm tra kết nối agy CLI…</div>
			<div class="vad-row">
				<select id="vadModelSel" title="Chọn mô hình AI cho tất cả 4 Studio">
					<option value="auto">Tự động (agy mặc định)</option>
					<option value="gemini-4-neon">Gemini 4 Neon</option>
					<option value="gemini-4-argon">Gemini 4 Argon</option>
					<option value="gemini-3.1-pro">Gemini 3.1 Pro</option>
					<option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
					<option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
					<option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
					<option value="claude-opus-4-6">Claude Opus 4.6</option>
					<option value="gpt-oss-120b">GPT-OSS 120B</option>
				</select>
			</div>
			<div class="vad-chips" id="vadChips">
				${(TOOL_CHIPS[cur] || []).map((c) => `<button type="button" class="vad-chip">${c}</button>`).join('')}
			</div>
			<textarea id="vadPrompt" rows="3" placeholder="Nhập yêu cầu cho agy CLI trên máy tính…"></textarea>
			<div class="vad-row">
				<button type="button" class="sgh-ai-btn" id="vadRunBtn" style="flex:1;justify-content:center;padding:9px 14px;font-size:13px">▶ Chạy bằng agy CLI</button>
			</div>
			<div class="vad-out hidden" id="vadOut"></div>
		`;
		document.body.appendChild(drawer);

		const modelSel = document.getElementById('vadModelSel');
		const statusTxt = document.getElementById('vadStatusText');
		const outBox = document.getElementById('vadOut');
		const promptInput = document.getElementById('vadPrompt');

		async function syncAgyUi() {
			const st = await window.VLIVE_AI.status();
			const activeModel = st.activeModel || st.config?.model || 'gemini-4-neon';
			if (modelSel && [...modelSel.options].some((o) => o.value === activeModel)) {
				modelSel.value = activeModel;
			}
			const topBtn = document.getElementById('sghAgyBtn');
			if (topBtn) topBtn.textContent = `✦ agy: ${activeModel}`;
			if (statusTxt) {
				statusTxt.textContent = st.connected
					? st.installed
						? `🟢 agy CLI sẵn sàng (${st.binPath}) · Dùng chung cho cả 4 Studio`
						: `🟡 Đã kết nối Server Local · Chưa tìm thấy lệnh agy trong PATH`
					: `⚪ Chưa kết nối Server Local (localhost:8790)`;
			}
		}

		document.getElementById('sghAgyBtn').onclick = () => {
			drawer.classList.toggle('hidden');
			if (!drawer.classList.contains('hidden')) syncAgyUi();
		};
		document.getElementById('vadCloseBtn').onclick = () => drawer.classList.add('hidden');
		drawer.querySelectorAll('.vad-chip').forEach((b) => {
			b.onclick = () => {
				promptInput.value = b.textContent;
				promptInput.focus();
			};
		});
		modelSel.onchange = async () => {
			await window.VLIVE_AI.setConfig({model: modelSel.value, customModel: '', enabled: true});
			await syncAgyUi();
		};
		document.getElementById('vadRunBtn').onclick = async () => {
			const p = promptInput.value.trim();
			if (!p) return promptInput.focus();
			const runBtn = document.getElementById('vadRunBtn');
			runBtn.disabled = true;
			runBtn.textContent = '⏳ Đang chạy agy CLI…';
			outBox.classList.remove('hidden');
			outBox.textContent = `Đang chạy agy --model ${modelSel.value} -p "…" trên máy tính…`;
			try {
				const res = await window.VLIVE_AI.run(p, {model: modelSel.value});
				outBox.textContent = `[agy CLI · ${res.model} · ${(res.durationMs / 1000).toFixed(1)}s]\n\n${res.output}`;
			} catch (err) {
				outBox.textContent = `❌ ${err.message}`;
			} finally {
				runBtn.disabled = false;
				runBtn.textContent = '▶ Chạy bằng agy CLI';
			}
		};
		syncAgyUi().catch(() => {});

		const refreshDbPill = async () => {
			const st = await STS_DB.stats();
			const el = document.getElementById('sghDbStatus');
			if (el) {
				const total = Object.values(st.counts || {}).reduce((a, b) => a + (Number(b) || 0), 0);
				const timeStr = new Date(st.lastSyncTime || Date.now()).toLocaleTimeString('vi-VN', {hour12: false});
				el.innerHTML = `<span class="sgh-live-dot"></span> Chung 4 Studio · ${total} dự án · ${timeStr}`;
				el.title = `Engine: ${st.engine}`;
			}
		};
		document.getElementById('sghSyncNowBtn').onclick = async (e) => {
			const btn = e.currentTarget;
			btn.textContent = '⏳ Đang đồng bộ…';
			await syncCrossToolData();
			await STS_DB.syncNow();
			await refreshDbPill();
			btn.textContent = '✅ Đã đồng bộ';
			setTimeout(() => {
				btn.textContent = '🔄 Đồng bộ';
			}, 1500);
		};

		syncCrossToolData().then(() => STS_DB.syncNow()).then(refreshDbPill).catch(refreshDbPill);
		window.addEventListener('sts-db-updated', refreshDbPill);
	}

	// ---- Universal Antigravity CLI (`agy`) API shared across Hub & all 4 Studio Tools
	let agyServerCache = null;
	async function resolveAgyBase() {
		if (agyServerCache !== null) return agyServerCache;
		const candidates = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? ['', 'http://localhost:8790'] : ['http://localhost:8790', ''];
		for (const base of [...new Set(candidates)]) {
			try {
				const ctrl = new AbortController();
				const to = setTimeout(() => ctrl.abort(), 1400);
				const r = await fetch(`${base}/api/agy/status`, {signal: ctrl.signal});
				clearTimeout(to);
				if (r.ok && (r.headers.get('content-type') || '').includes('application/json')) {
					agyServerCache = base;
					return base;
				}
			} catch {}
		}
		return null;
	}

	window.VLIVE_AI = {
		getLocalConfig() {
			try {
				return JSON.parse(localStorage.getItem('vlive_agy_config') || 'null') || {enabled: true, model: 'gemini-4-neon', customModel: ''};
			} catch {
				return {enabled: true, model: 'gemini-4-neon', customModel: ''};
			}
		},
		async status() {
			const localCfg = this.getLocalConfig();
			const base = await resolveAgyBase();
			if (base === null) {
				return {connected: false, installed: false, config: localCfg, activeModel: localCfg.customModel || localCfg.model};
			}
			try {
				const j = await fetch(`${base}/api/agy/status`).then((r) => r.json());
				if (j.config) localStorage.setItem('vlive_agy_config', JSON.stringify(j.config));
				return {connected: true, ...j};
			} catch {
				return {connected: false, installed: false, config: localCfg, activeModel: localCfg.customModel || localCfg.model};
			}
		},
		async setConfig(patch) {
			const next = {...this.getLocalConfig(), ...patch};
			localStorage.setItem('vlive_agy_config', JSON.stringify(next));
			await STS_DB.put('shared', 'settings', 'agy_ai_config', next).catch(() => {});
			const base = await resolveAgyBase();
			if (base !== null) {
				await fetch(`${base}/api/agy/config`, {
					method: 'PUT',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify(next),
				}).catch(() => {});
			}
			return next;
		},
		async run(prompt, opts = {}) {
			const base = await resolveAgyBase();
			if (base === null) {
				throw new Error('Không kết nối được Server Local (http://localhost:8790) để chạy agy CLI trên máy tính.');
			}
			const cfg = this.getLocalConfig();
			const model = opts.model || cfg.customModel || cfg.model || 'auto';
			const r = await fetch(`${base}/api/agy/run`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({prompt, model}),
			});
			const j = await r.json();
			if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
			return j;
		},
	};

	// ---- Unified Cross-Tool Data Bridge (Script Studio <-> Voice Studio <-> Video Studio <-> PSD Studio)
	let lastSsHash = '';
	async function syncCrossToolData() {
		try {
			// 1. Mirror Script Studio persistent DB into unified STS_DB & bridge Voice-Off lines to STS Voice Studio
			const rawSs = localStorage.getItem('ss_persistent_db_v1');
			if (rawSs && rawSs !== lastSsHash) {
				lastSsHash = rawSs;
				const parsed = JSON.parse(rawSs);
				if (parsed && Array.isArray(parsed.projects)) {
					await STS_DB.put('script-studio', 'store', 'main', parsed);
					// Auto-bridge each Script Studio project's voice/dialogue lines into STS Voice Studio!
					const pMap = parsed.p || {};
					for (const proj of parsed.projects) {
						const detail = pMap[String(proj.id)] || proj;
						const voiceLines = detail?.voice?.lines || [];
						if (Array.isArray(voiceLines) && voiceLines.length > 0) {
							const mappedLines = voiceLines.map((l, idx) => ({
								id: idx + 1,
								ep: l.episode ? `Tập ${l.episode}` : 'Tập 1',
								scene: l.scene || l.shot || '',
								stt: String(idx + 1),
								rawChar: l.character || 'NHÂN VẬT',
								char: String(l.character || 'NHÂN VẬT').trim().toUpperCase(),
								text: l.line || '',
								tagged: l.tagged || l.line || '',
							}));
							await STS_DB.put('sts-voice-studio', 'projects', `ss_proj_${proj.id}`, {
								id: `ss_proj_${proj.id}`,
								name: `[Script Studio] ${proj.name}`,
								lines: mappedLines,
								nextId: mappedLines.length + 1,
								extraChars: [],
								mapping: {},
								defaultEp: 'Tập 1',
								updatedAt: Date.now(),
								updatedAtText: new Date().toLocaleString('vi-VN', {hour12: false}),
							});
						}
					}
				}
			}
		} catch {}
	}
	setInterval(() => {
		if (document.visibilityState === 'visible') syncCrossToolData().catch(() => {});
	}, 4500);

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', mountGlobalBar);
	} else {
		mountGlobalBar();
	}
})();
