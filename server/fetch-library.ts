/**
 * Optional: download the licensed editing sounds and music beds that ghost-editor uses (Mixkit free licence:
 * commercial use OK, no attribution, may not be redistributed as-is — so they are fetched on YOUR machine,
 * never committed). CC0 sounds already ship in public/sfx.
 *   npm run setup:library
 */
import fs from 'node:fs';
import path from 'node:path';
import {PATHS} from './config.js';

const WANT_SFX = ['whoosh-1', 'whoosh-2', 'whoosh-3', 'whoosh-cine', 'pop-1', 'pop-2', 'pop-3', 'impact-1', 'impact-2', 'riser-1', 'ding-1'];

const get = async (url: string, dst: string) => {
	if (fs.existsSync(dst) && fs.statSync(dst).size > 1000) return 'cached';
	const res = await fetch(url, {headers: {'User-Agent': 'Mozilla/5.0 auto-video-studio'}});
	if (!res.ok) throw new Error(`${res.status} ${url}`);
	fs.writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
	return 'ok';
};

const main = async () => {
	const sfx = JSON.parse(fs.readFileSync(path.join(PATHS.public, 'sfx-mixkit.json'), 'utf8')) as Record<string, {mixkit_id: string}>;
	for (const id of WANT_SFX) {
		const e = sfx[id];
		if (!e) continue;
		try {
			const r = await get(`https://assets.mixkit.co/active_storage/sfx/${e.mixkit_id}/${e.mixkit_id}-preview.mp3`, path.join(PATHS.sfx, `${id}.mp3`));
			console.log(`[sfx] ${id}: ${r}`);
		} catch (err) {
			console.log(`[sfx] ${id}: lỗi ${(err as Error).message}`);
		}
	}
	const music = JSON.parse(fs.readFileSync(path.join(PATHS.public, 'music-manifest.json'), 'utf8')) as Record<string, {file: string; url: string}>;
	const ok: Record<string, unknown> = {};
	for (const [id, m] of Object.entries(music)) {
		if (!m.url) continue;
		try {
			const r = await get(m.url, path.join(PATHS.music, m.file));
			ok[id] = m;
			console.log(`[music] ${id}: ${r}`);
		} catch (err) {
			console.log(`[music] ${id}: lỗi ${(err as Error).message}`);
		}
	}
	fs.writeFileSync(path.join(PATHS.music, 'manifest.json'), JSON.stringify(ok, null, 1));
	console.log('Xong. Khởi động lại server để dùng thư viện mới.');
};

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
