import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {dbGetSetting, dbSetSetting} from './db.js';

const execFileAsync = promisify(execFile);

export type AgyAiConfig = {
	enabled: boolean;
	model: string;
	customModel: string;
	customPath: string;
};

export type AgyModelItem = {id: string; label: string; family: string};

export const AGY_MODELS: AgyModelItem[] = [
	{id: 'auto', label: 'Tự động (Mặc định của agy CLI)', family: 'Auto'},
	{id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)', family: 'Gemini'},
	{id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', family: 'Gemini'},
	{id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)', family: 'Gemini'},
	{id: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)', family: 'Gemini'},
	{id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)', family: 'Gemini'},
	{id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)', family: 'Gemini'},
	{id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)', family: 'Gemini'},
	{id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', family: 'Gemini'},
	{id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)', family: 'Claude'},
	{id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)', family: 'Claude'},
	{id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', family: 'GPT-OSS'},
];

const DEFAULT_CONFIG: AgyAiConfig = {
	enabled: true,
	model: 'gemini-4-neon-medium',
	customModel: '',
	customPath: '',
};

const LEGACY_MODEL_MAP: Record<string, string> = {
	'gemini-4-neon': 'gemini-4-neon-medium',
	'gemini-4-argon': 'gemini-4-argon-medium',
	'claude-sonnet-4-6': 'claude-sonnet-5-5-medium',
	'claude-opus-4-6': 'claude-opus-5-5-medium',
	'gpt-oss-120b': 'gpt-oss-120b-medium',
};

export function getAgyConfig(): AgyAiConfig {
	const saved = dbGetSetting<Partial<AgyAiConfig>>('agy_ai_config') || {};
	const rawModel = typeof saved.model === 'string' && saved.model.trim() ? saved.model.trim() : DEFAULT_CONFIG.model;
	return {
		enabled: saved.enabled !== undefined ? Boolean(saved.enabled) : DEFAULT_CONFIG.enabled,
		model: LEGACY_MODEL_MAP[rawModel] || rawModel,
		customModel: typeof saved.customModel === 'string' ? saved.customModel.trim() : '',
		customPath: typeof saved.customPath === 'string' ? saved.customPath.trim() : '',
	};
}

export function saveAgyConfig(patch: Partial<AgyAiConfig>): AgyAiConfig {
	const next: AgyAiConfig = {
		...getAgyConfig(),
		...(patch.enabled !== undefined ? {enabled: Boolean(patch.enabled)} : {}),
		...(typeof patch.model === 'string' ? {model: patch.model.trim() || 'auto'} : {}),
		...(typeof patch.customModel === 'string' ? {customModel: patch.customModel.trim()} : {}),
		...(typeof patch.customPath === 'string' ? {customPath: patch.customPath.trim()} : {}),
	};
	dbSetSetting('agy_ai_config', next);
	return next;
}

export async function findAgyBinary(customPath?: string): Promise<string | null> {
	const home = os.homedir();
	const candidates = [
		customPath?.trim(),
		path.join(home, '.local', 'bin', 'agy'),
		path.join(home, '.antigravity', 'antigravity', 'bin', 'agy'),
		'/opt/homebrew/bin/agy',
		'/usr/local/bin/agy',
		'/Applications/Antigravity.app/Contents/Resources/app/bin/agy',
	].filter(Boolean) as string[];

	for (const p of candidates) {
		try {
			if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
		} catch {}
	}

	try {
		const {stdout} = await execFileAsync('which', ['agy'], {timeout: 2500});
		const found = stdout.trim();
		if (found) return found;
	} catch {}

	return null;
}

let cachedModels: AgyModelItem[] | null = null;
let cachedModelsAt = 0;

async function fetchLiveAgyModels(binPath: string): Promise<AgyModelItem[]> {
	if (cachedModels && Date.now() - cachedModelsAt < 5 * 60_000) return cachedModels;
	try {
		const {stdout} = await execFileAsync(binPath, ['models'], {timeout: 12_000});
		const clean = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '\n');
		const list: AgyModelItem[] = [{id: 'auto', label: 'Tự động (Mặc định của agy CLI)', family: 'Auto'}];
		const seen = new Set<string>(['auto']);
		for (const rawLine of clean.split('\n')) {
			const line = rawLine.trim();
			const m = /^([a-z0-9][a-z0-9._-]+)\s{2,}(.+)$/.exec(line);
			if (!m) continue;
			const id = m[1].trim();
			const label = m[2].trim();
			if (seen.has(id)) continue;
			seen.add(id);
			const family = id.startsWith('claude') ? 'Claude' : id.startsWith('gpt') ? 'GPT-OSS' : 'Gemini';
			list.push({id, label, family});
		}
		if (list.length > 1) {
			cachedModels = list;
			cachedModelsAt = Date.now();
			return list;
		}
	} catch {}
	return AGY_MODELS;
}

export async function getAgyStatus() {
	const config = getAgyConfig();
	const binPath = await findAgyBinary(config.customPath);
	let version = '';
	let models = AGY_MODELS;
	if (binPath) {
		try {
			const {stdout} = await execFileAsync(binPath, ['--version'], {timeout: 3500});
			version = stdout.trim().split('\n')[0] || '';
		} catch {}
		models = await fetchLiveAgyModels(binPath);
	}
	return {
		ok: true,
		installed: Boolean(binPath),
		binPath: binPath || '',
		version,
		config,
		activeModel: config.customModel || config.model,
		models,
	};
}

export async function runAgyPrompt(
	prompt: string,
	opts: {model?: string; timeoutMs?: number; cwd?: string} = {},
): Promise<{ok: boolean; output: string; model: string; durationMs: number; binPath: string}> {
	const config = getAgyConfig();
	const binPath = await findAgyBinary(config.customPath);
	if (!binPath) {
		throw new Error(
			'Chưa tìm thấy lệnh `agy` CLI trên máy tính. Hãy cài Antigravity CLI (`curl -fsSL https://antigravity.google/cli/install.sh | bash`).',
		);
	}
	const rawModel = (opts.model || config.customModel || config.model || 'auto').trim();
	const chosenModel = LEGACY_MODEL_MAP[rawModel] || rawModel;
	const args: string[] = ['--disable-slash-commands'];
	const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
	if (chosenModel && EFFORTS.has(chosenModel.toLowerCase())) {
		args.push('--effort', chosenModel.toLowerCase());
	} else if (chosenModel && chosenModel !== 'auto' && chosenModel !== 'default') {
		args.push('--model', chosenModel);
	}
	args.push('-p', prompt);

	const startedAt = Date.now();
	const timeoutMs = opts.timeoutMs || 120_000;

	return await new Promise((resolve, reject) => {
		const child = spawn(binPath, args, {
			cwd: opts.cwd || process.cwd(),
			env: {...process.env},
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				child.kill('SIGTERM');
			} catch {}
			reject(new Error(`agy CLI quá thời gian chờ (${Math.round(timeoutMs / 1000)}s)`));
		}, timeoutMs);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString('utf8');
		});

		child.on('error', (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`Không chạy được agy CLI: ${err.message}`));
		});

		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const durationMs = Date.now() - startedAt;
			if (code === 0) {
				resolve({
					ok: true,
					output: stdout.trim() || stderr.trim(),
					model: chosenModel,
					durationMs,
					binPath,
				});
			} else {
				const errText = (stderr || stdout || `Exit code ${code}`).trim().slice(0, 600);
				reject(new Error(`agy CLI trả lỗi (code ${code}): ${errText}`));
			}
		});
	});
}
