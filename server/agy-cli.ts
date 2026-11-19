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

export const AGY_MODELS = [
	{id: 'auto', label: 'Tự động (Mặc định của agy CLI)', family: 'Auto'},
	{id: 'gemini-4-neon', label: 'Gemini 4 Neon', family: 'Gemini'},
	{id: 'gemini-4-argon', label: 'Gemini 4 Argon', family: 'Gemini'},
	{id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', family: 'Gemini'},
	{id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', family: 'Gemini'},
	{id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Nhanh)', family: 'Gemini'},
	{id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', family: 'Claude'},
	{id: 'claude-opus-4-6', label: 'Claude Opus 4.6', family: 'Claude'},
	{id: 'gpt-oss-120b', label: 'GPT-OSS 120B', family: 'GPT-OSS'},
];

const DEFAULT_CONFIG: AgyAiConfig = {
	enabled: true,
	model: 'gemini-4-neon',
	customModel: '',
	customPath: '',
};

export function getAgyConfig(): AgyAiConfig {
	const saved = dbGetSetting<Partial<AgyAiConfig>>('agy_ai_config') || {};
	return {
		enabled: saved.enabled !== undefined ? Boolean(saved.enabled) : DEFAULT_CONFIG.enabled,
		model: typeof saved.model === 'string' && saved.model.trim() ? saved.model.trim() : DEFAULT_CONFIG.model,
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
		path.join(home, '.antigravity', 'antigravity', 'bin', 'agy'),
		path.join(home, '.local', 'bin', 'agy'),
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

export async function getAgyStatus() {
	const config = getAgyConfig();
	const binPath = await findAgyBinary(config.customPath);
	let version = '';
	if (binPath) {
		try {
			const {stdout} = await execFileAsync(binPath, ['--version'], {timeout: 3500});
			version = stdout.trim().split('\n')[0] || '';
		} catch {}
	}
	return {
		ok: true,
		installed: Boolean(binPath),
		binPath: binPath || '',
		version,
		config,
		activeModel: config.customModel || config.model,
		models: AGY_MODELS,
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
			'Chưa tìm thấy lệnh `agy` CLI trên máy tính. Hãy cài Antigravity CLI (hoặc nhập đường dẫn file thực thi `agy` trong phần Cài đặt).',
		);
	}
	const chosenModel = (opts.model || config.customModel || config.model || 'auto').trim();
	const args: string[] = [];
	if (chosenModel && chosenModel !== 'auto') {
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
