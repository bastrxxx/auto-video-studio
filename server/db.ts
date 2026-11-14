import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PATHS} from './config.js';

export const DB_PATH = path.join(PATHS.data, 'studio.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA synchronous = NORMAL;
	PRAGMA foreign_keys = ON;

	CREATE TABLE IF NOT EXISTS users (
		username TEXT PRIMARY KEY,
		password_hash TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'admin',
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS jobs (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		state TEXT NOT NULL,
		step TEXT NOT NULL,
		progress REAL NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		data TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS job_docs (
		job_id TEXT NOT NULL,
		name TEXT NOT NULL,
		data TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (job_id, name),
		FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS app_records (
		app TEXT NOT NULL,
		collection TEXT NOT NULL,
		id TEXT NOT NULL,
		data TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (app, collection, id)
	);
`);

export const hashPassword = (username: string, password: string): string =>
	crypto.createHash('sha256').update(`avs-auth:${username}:${password}`).digest('hex');

// Seed default user (sts / 1111) into database
db.prepare(`
	INSERT INTO users (username, password_hash, role, created_at)
	VALUES (?, ?, 'admin', ?)
	ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash
`).run('sts', hashPassword('sts', '1111'), Date.now());

export const dbVerifyUser = (username: string, password: string): {ok: boolean; token?: string; user?: string} => {
	const row = db.prepare(`SELECT username, password_hash FROM users WHERE username = ?`).get(username) as
		| {username: string; password_hash: string}
		| undefined;
	if (!row) return {ok: false};
	const expected = hashPassword(username, password);
	if (row.password_hash !== expected) return {ok: false};
	return {ok: true, token: row.password_hash, user: row.username};
};

export const dbVerifyToken = (token?: string): {ok: boolean; user?: string} => {
	if (!token) return {ok: false};
	const row = db.prepare(`SELECT username FROM users WHERE password_hash = ?`).get(token) as {username: string} | undefined;
	return row ? {ok: true, user: row.username} : {ok: false};
};

// ---- Settings store
export const dbGetSetting = <T = unknown>(key: string, fallback: T | null = null): T | null => {
	const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as {value: string} | undefined;
	if (!row) return fallback;
	try {
		return JSON.parse(row.value) as T;
	} catch {
		return fallback;
	}
};

export const dbSetSetting = (key: string, value: unknown): void => {
	db.prepare(`
		INSERT INTO settings (key, value, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`).run(key, JSON.stringify(value), Date.now());
};

// ---- Jobs & Job Documents store
const stmtUpsertJob = db.prepare(`
	INSERT INTO jobs (id, name, state, step, progress, created_at, updated_at, data)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		name = excluded.name,
		state = excluded.state,
		step = excluded.step,
		progress = excluded.progress,
		updated_at = excluded.updated_at,
		data = excluded.data
`);

const stmtAllJobs = db.prepare(`SELECT data FROM jobs ORDER BY created_at ASC`);
const stmtDeleteJob = db.prepare(`DELETE FROM jobs WHERE id = ?`);
const stmtClearJobs = db.prepare(`DELETE FROM jobs`);

const stmtReadDoc = db.prepare(`SELECT data FROM job_docs WHERE job_id = ? AND name = ?`);
const stmtUpsertDoc = db.prepare(`
	INSERT INTO job_docs (job_id, name, data, updated_at)
	VALUES (?, ?, ?, ?)
	ON CONFLICT(job_id, name) DO UPDATE SET
		data = excluded.data,
		updated_at = excluded.updated_at
`);
const stmtDeleteDoc = db.prepare(`DELETE FROM job_docs WHERE job_id = ? AND name = ?`);

export interface DbJobLike {
	id: string;
	name: string;
	state: string;
	step: string;
	progress: number;
	createdAt: number;
}

export const dbSaveJob = <T extends DbJobLike>(job: T): void => {
	stmtUpsertJob.run(
		job.id,
		job.name || job.id,
		job.state || 'ready',
		job.step || 'upload',
		Number(job.progress) || 0,
		Number(job.createdAt) || Date.now(),
		Date.now(),
		JSON.stringify(job),
	);
};

export const dbLoadJobs = <T>(): T[] => {
	const rows = stmtAllJobs.all() as {data: string}[];
	const out: T[] = [];
	for (const r of rows) {
		try {
			out.push(JSON.parse(r.data) as T);
		} catch {}
	}
	return out;
};

export const dbDeleteJob = (id: string): void => {
	stmtDeleteJob.run(id);
};

export const dbClearJobs = (): void => {
	stmtClearJobs.run();
};

export const dbReadDoc = <T>(jobId: string, name: string): T | null => {
	const row = stmtReadDoc.get(jobId, name) as {data: string} | undefined;
	if (!row) return null;
	try {
		return JSON.parse(row.data) as T;
	} catch {
		return null;
	}
};

export const dbWriteDoc = (jobId: string, name: string, data: unknown): void => {
	stmtUpsertDoc.run(jobId, name, JSON.stringify(data), Date.now());
};

export const dbDeleteDoc = (jobId: string, name: string): void => {
	stmtDeleteDoc.run(jobId, name);
};

/** One-time automatic migration of legacy JSON files in data/jobs/<id>/*.json into SQLite */
export const migrateDiskJobsToDb = (): number => {
	if (!fs.existsSync(PATHS.jobs)) return 0;
	let migrated = 0;
	for (const d of fs.readdirSync(PATHS.jobs)) {
		const dir = path.join(PATHS.jobs, d);
		const jobFile = path.join(dir, 'job.json');
		if (!fs.existsSync(jobFile)) continue;
		const existing = db.prepare(`SELECT id FROM jobs WHERE id = ?`).get(d) as {id: string} | undefined;
		if (!existing) {
			try {
				const job = JSON.parse(fs.readFileSync(jobFile, 'utf8')) as DbJobLike;
				if (job && job.id) {
					dbSaveJob(job);
					migrated++;
				}
			} catch {}
		}
		// Migrate any auxiliary JSON docs (timeline.json, plan.json, cut.json, ai.json, analysis-*.json, face-*.json)
		try {
			for (const f of fs.readdirSync(dir)) {
				if (!f.endsWith('.json') || f === 'job.json') continue;
				const hasDoc = stmtReadDoc.get(d, f);
				if (!hasDoc) {
					try {
						const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
						dbWriteDoc(d, f, parsed);
					} catch {}
				}
			}
		} catch {}
	}
	return migrated;
};

export const dbStats = () => {
	const jobsCount = (db.prepare(`SELECT COUNT(*) as c FROM jobs`).get() as {c: number}).c;
	const docsCount = (db.prepare(`SELECT COUNT(*) as c FROM job_docs`).get() as {c: number}).c;
	const settingsCount = (db.prepare(`SELECT COUNT(*) as c FROM settings`).get() as {c: number}).c;
	const appRows = db.prepare(`SELECT app, COUNT(*) as c FROM app_records GROUP BY app`).all() as {app: string; c: number}[];
	const apps: Record<string, number> = {'auto-video-studio': jobsCount};
	for (const r of appRows) apps[r.app] = r.c;
	let sizeBytes = 0;
	try {
		sizeBytes = fs.statSync(DB_PATH).size;
	} catch {}
	return {
		engine: 'SQLite (node:sqlite WAL)',
		file: 'data/studio.db',
		jobs: jobsCount,
		docs: docsCount,
		settings: settingsCount,
		apps,
		sizeBytes,
	};
};

// ---- Multi-App Universal Database Store (for Script Studio, Vlive PSD Studio, STS Voice Studio)
const stmtListAppRecords = db.prepare(`SELECT id, data, updated_at FROM app_records WHERE app = ? AND collection = ? ORDER BY updated_at DESC`);
const stmtGetAppRecord = db.prepare(`SELECT data, updated_at FROM app_records WHERE app = ? AND collection = ? AND id = ?`);
const stmtUpsertAppRecord = db.prepare(`
	INSERT INTO app_records (app, collection, id, data, updated_at)
	VALUES (?, ?, ?, ?, ?)
	ON CONFLICT(app, collection, id) DO UPDATE SET
		data = excluded.data,
		updated_at = excluded.updated_at
`);
const stmtDeleteAppRecord = db.prepare(`DELETE FROM app_records WHERE app = ? AND collection = ? AND id = ?`);
const stmtClearAppCol = db.prepare(`DELETE FROM app_records WHERE app = ? AND collection = ?`);

export const dbListAppRecords = <T = unknown>(app: string, collection: string): {id: string; data: T; updatedAt: number}[] => {
	const rows = stmtListAppRecords.all(app, collection) as {id: string; data: string; updated_at: number}[];
	const out: {id: string; data: T; updatedAt: number}[] = [];
	for (const r of rows) {
		try {
			out.push({id: r.id, data: JSON.parse(r.data) as T, updatedAt: r.updated_at});
		} catch {}
	}
	return out;
};

export const dbGetAppRecord = <T = unknown>(app: string, collection: string, id: string): T | null => {
	const row = stmtGetAppRecord.get(app, collection, id) as {data: string} | undefined;
	if (!row) return null;
	try {
		return JSON.parse(row.data) as T;
	} catch {
		return null;
	}
};

export const dbPutAppRecord = (app: string, collection: string, id: string, data: unknown): void => {
	stmtUpsertAppRecord.run(app, collection, String(id), JSON.stringify(data), Date.now());
};

export const dbDeleteAppRecord = (app: string, collection: string, id: string): void => {
	stmtDeleteAppRecord.run(app, collection, String(id));
};

export const dbClearAppCollection = (app: string, collection: string): void => {
	stmtClearAppCol.run(app, collection);
};

