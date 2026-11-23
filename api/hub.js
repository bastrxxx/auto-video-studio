import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_FILE = path.join(os.tmpdir(), 'sts-unified-studio-cloud-db.json');
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

async function loadStore() {
	if (KV_URL && KV_TOKEN) {
		try {
			const r = await fetch(`${KV_URL}/get/sts_unified_cloud_db_v1`, {
				headers: {Authorization: `Bearer ${KV_TOKEN}`},
			});
			if (r.ok) {
				const j = await r.json();
				const raw = typeof j.result === 'string' ? JSON.parse(j.result) : j.result;
				if (Array.isArray(raw)) {
					const map = new Map();
					for (const rec of raw) if (rec && rec.pk) map.set(rec.pk, rec);
					globalThis.__STS_CLOUD_DB__ = map;
					return map;
				}
			}
		} catch {}
	}
	if (globalThis.__STS_CLOUD_DB__) return globalThis.__STS_CLOUD_DB__;
	let map = new Map();
	try {
		if (fs.existsSync(TMP_FILE)) {
			const raw = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
			if (Array.isArray(raw)) {
				for (const r of raw) {
					if (r && r.pk) map.set(r.pk, r);
				}
			}
		}
	} catch {}
	globalThis.__STS_CLOUD_DB__ = map;
	return map;
}

async function saveStore(map) {
	const arr = [...map.values()];
	try {
		fs.writeFileSync(TMP_FILE, JSON.stringify(arr));
	} catch {}
	if (KV_URL && KV_TOKEN) {
		try {
			await fetch(`${KV_URL}/set/sts_unified_cloud_db_v1`, {
				method: 'POST',
				headers: {Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json'},
				body: JSON.stringify(JSON.stringify(arr)),
			});
		} catch {}
	}
}

function computeStats(map) {
	const apps = {
		'script-studio': 0,
		'auto-video-studio': 0,
		'video-studio': 0,
		'vlive-psd-studio': 0,
		'sts-voice-studio': 0,
	};
	for (const r of map.values()) {
		if (r._deleted) continue;
		if (apps[r.app] !== undefined) apps[r.app]++;
	}
	return {
		engine: KV_URL ? 'Vercel Cloud KV + IndexedDB' : 'Vercel Cloud Realtime DB + IndexedDB',
		file: KV_URL ? 'kv://sts-unified-studio-db' : 'cloud://sts-unified-studio-db',
		jobs: apps['auto-video-studio'],
		dna: apps['video-studio'],
		apps,
	};
}

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
	res.setHeader('Access-Control-Allow-Credentials', 'true');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	if (req.method === 'OPTIONS') {
		res.status(204).end();
		return;
	}

	const store = await loadStore();
	const url = new URL(req.url || '/api/hub/stats', `http://${req.headers.host || 'localhost'}`);
	const pathname = url.pathname.replace(/\/+$/, '');

	// 1. GET /api/hub/stats
	if (pathname === '/api/hub/stats' && req.method === 'GET') {
		res.status(200).json({ok: true, db: computeStats(store), serverTime: Date.now()});
		return;
	}

	// 2. POST /api/hub/sync (Bi-directional CRDT last-write-wins sync)
	if (pathname === '/api/hub/sync' && req.method === 'POST') {
		const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
		const incoming = Array.isArray(body.records) ? body.records : [];
		let changed = false;
		for (const rec of incoming) {
			if (!rec || !rec.app || !rec.collection || !rec.id) continue;
			const pk = `${rec.app}:${rec.collection}:${rec.id}`;
			const existing = store.get(pk);
			const incTs = Number(rec.updatedAt) || Date.now();
			if (!existing || incTs > (existing.updatedAt || 0)) {
				store.set(pk, {
					pk,
					app: String(rec.app),
					collection: String(rec.collection),
					id: String(rec.id),
					data: rec.data ?? null,
					_deleted: Boolean(rec._deleted),
					updatedAt: incTs,
				});
				changed = true;
			}
		}
		if (changed) await saveStore(store);
		const records = [...store.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
		res.status(200).json({ok: true, records, db: computeStats(store), serverTime: Date.now()});
		return;
	}

	// 3. /api/hub/db/:app/:collection(/:id)
	const m = /^\/api\/hub\/db\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
	if (m) {
		const app = decodeURIComponent(m[1]);
		const collection = decodeURIComponent(m[2]);
		const id = m[3] ? decodeURIComponent(m[3]) : null;

		if (req.method === 'GET' && !id) {
			const items = [];
			for (const r of store.values()) {
				if (r.app === app && r.collection === collection && !r._deleted) {
					items.push({id: r.id, data: r.data, updatedAt: r.updatedAt});
				}
			}
			items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
			res.status(200).json({ok: true, items, db: computeStats(store)});
			return;
		}

		if (req.method === 'GET' && id) {
			const pk = `${app}:${collection}:${id}`;
			const r = store.get(pk);
			if (!r || r._deleted) {
				res.status(200).json({ok: true, item: null, updatedAt: r?.updatedAt || 0});
				return;
			}
			res.status(200).json({ok: true, item: r.data, updatedAt: r.updatedAt});
			return;
		}

		if (req.method === 'PUT' && id) {
			const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
			const pk = `${app}:${collection}:${id}`;
			const updatedAt = Number(body.updatedAt) || Date.now();
			store.set(pk, {
				pk,
				app,
				collection,
				id: String(id),
				data: body.data !== undefined ? body.data : body,
				_deleted: false,
				updatedAt,
			});
			await saveStore(store);
			res.status(200).json({ok: true, updatedAt, db: computeStats(store)});
			return;
		}

		if (req.method === 'DELETE' && id) {
			const pk = `${app}:${collection}:${id}`;
			const updatedAt = Date.now();
			store.set(pk, {pk, app, collection, id: String(id), data: null, _deleted: true, updatedAt});
			await saveStore(store);
			res.status(200).json({ok: true, updatedAt, db: computeStats(store)});
			return;
		}

		if (req.method === 'DELETE' && !id) {
			const updatedAt = Date.now();
			for (const [pk, r] of store.entries()) {
				if (r.app === app && r.collection === collection) {
					store.set(pk, {...r, data: null, _deleted: true, updatedAt});
				}
			}
			await saveStore(store);
			res.status(200).json({ok: true, updatedAt, db: computeStats(store)});
			return;
		}
	}

	res.status(200).json({ok: true, db: computeStats(store)});
}
