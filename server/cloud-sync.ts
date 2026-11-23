// Automatic Bi-Directional Cloud Sync:
// Synchronizes Local SQLite `app_records` (TikTok DNA, Voice Over plans, Jobs metadata, Script/Voice/PSD Studio)
// with the live Vercel Cloud Hub (`https://vlivests.vercel.app/api/hub/sync`) automatically.
import {dbSyncAllAppRecords} from './db.js';

export const VERCEL_CLOUD_URL = (process.env.VERCEL_CLOUD_URL || 'https://vlivests.vercel.app').replace(/\/+$/, '');

let syncing = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncAt = 0;
let lastSyncStatus: 'idle' | 'ok' | 'offline' = 'idle';

export function getCloudSyncState() {
	return {
		cloudUrl: VERCEL_CLOUD_URL,
		syncing,
		lastSyncAt,
		status: lastSyncStatus,
	};
}

export async function syncWithVercelCloud(): Promise<{ok: boolean; pushed: number; merged: number; cloudUrl: string}> {
	if (syncing) return {ok: true, pushed: 0, merged: 0, cloudUrl: VERCEL_CLOUD_URL};
	syncing = true;
	try {
		const local = dbSyncAllAppRecords([]);
		const res = await fetch(`${VERCEL_CLOUD_URL}/api/hub/sync`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({records: local.records}),
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) {
			lastSyncStatus = 'offline';
			return {ok: false, pushed: 0, merged: 0, cloudUrl: VERCEL_CLOUD_URL};
		}
		const j = (await res.json()) as {ok?: boolean; records?: {app: string; collection: string; id: string; data: unknown; updatedAt?: number; _deleted?: boolean}[]};
		const remoteRecords = Array.isArray(j.records) ? j.records.filter((r) => !r._deleted) : [];
		if (remoteRecords.length) {
			dbSyncAllAppRecords(remoteRecords);
		}
		lastSyncAt = Date.now();
		lastSyncStatus = 'ok';
		return {ok: true, pushed: local.records.length, merged: remoteRecords.length, cloudUrl: VERCEL_CLOUD_URL};
	} catch {
		lastSyncStatus = 'offline';
		return {ok: false, pushed: 0, merged: 0, cloudUrl: VERCEL_CLOUD_URL};
	} finally {
		syncing = false;
	}
}

export function scheduleCloudSync(delayMs = 1200) {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		void syncWithVercelCloud();
	}, delayMs);
}

export function startCloudSyncLoop() {
	// Initial sync 2s after server boot
	setTimeout(() => void syncWithVercelCloud(), 2000);
	// Periodic bi-directional sync every 20s
	setInterval(() => void syncWithVercelCloud(), 20_000);
}
