// STS Voice Studio — Database Engine (IndexedDB + SQLite sync via window.STS_DB)
(() => {
	const APP = 'sts-voice-studio';
	let activeProjId = localStorage.getItem('sts_voice_active_proj') || 'default';
	let syncTimer = null;

	async function ensureDefaultProject() {
		if (!window.STS_DB) return [];
		let items = await window.STS_DB.list(APP, 'projects');
		const api = window.VOICE_STUDIO_API;
		if (!items.length && api) {
			const S = api.S;
			const seedLines =
				S.lines && S.lines.length
					? S.lines.map(({status, ...l}) => l)
					: [
							{id: 1, ep: 'Tập 1', scene: 'Cảnh 1', stt: '1', rawChar: 'LINH', char: 'LINH', text: 'Xin chào mọi người, hôm nay chúng ta bắt đầu bấm máy nhé!', tagged: '[excited] Xin chào mọi người, hôm nay chúng ta bắt đầu bấm máy nhé!'},
							{id: 2, ep: 'Tập 1', scene: 'Cảnh 1', stt: '2', rawChar: 'MINH', char: 'MINH', text: 'Âm thanh và kịch bản đã sẵn sàng trong Database.', tagged: '[calm] Âm thanh và kịch bản đã sẵn sàng trong Database.'},
					  ];
			const defProj = {
				id: 'default',
				name: 'Dự án Kịch bản Voice #1',
				lines: seedLines,
				nextId: seedLines.length + 1,
				extraChars: S.extraChars || [],
				mapping: S.mapping || {},
				defaultEp: document.getElementById('defaultEp')?.value || 'Tập 1',
				updatedAt: Date.now(),
				updatedAtText: new Date().toLocaleString('vi-VN', {hour12: false}),
			};
			await window.STS_DB.put(APP, 'projects', 'default', defProj);
			items = [defProj];
			if (!S.lines.length) {
				S.lines = seedLines.map((l) => ({...l, status: ''}));
				S.nextId = defProj.nextId;
				api.renderLines?.();
				api.renderChars?.();
				api.renderEpFilter?.();
				api.renderGenTable?.();
			}
		} else if (items.length && api) {
			const cur = items.find((x) => x.id === activeProjId) || items[0];
			activeProjId = cur.id;
			localStorage.setItem('sts_voice_active_proj', activeProjId);
			if (!api.S.lines.length && cur.lines?.length) {
				applyProjectToEditor(cur, false);
			}
		}
		return items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	}

	function applyProjectToEditor(proj, notify = true) {
		const api = window.VOICE_STUDIO_API;
		if (!api || !proj) return;
		const S = api.S;
		S.lines = (proj.lines || []).map((l) => ({...l, status: ''}));
		S.nextId = proj.nextId || S.lines.length + 1;
		S.extraChars = Array.isArray(proj.extraChars) ? [...proj.extraChars] : [];
		S.mapping = proj.mapping && typeof proj.mapping === 'object' ? {...proj.mapping} : S.mapping;
		const epInput = document.getElementById('defaultEp');
		if (epInput && proj.defaultEp !== undefined) epInput.value = proj.defaultEp;
		try {
			localStorage.setItem('script_v2', JSON.stringify({lines: S.lines.map(({status, ...l}) => l), nextId: S.nextId}));
			localStorage.setItem('extra_chars', JSON.stringify(S.extraChars));
			localStorage.setItem('voice_map', JSON.stringify(S.mapping));
		} catch {}
		api.renderLines?.();
		api.renderChars?.();
		api.renderEpFilter?.();
		api.renderGenTable?.();
		if (notify) api.toast?.(`Đã nạp dự án "${proj.name}" từ Database`, 'ok');
	}

	async function saveActiveProject(customName) {
		const api = window.VOICE_STUDIO_API;
		if (!window.STS_DB || !api) return;
		const items = await window.STS_DB.list(APP, 'projects');
		const existing = items.find((x) => x.id === activeProjId);
		const S = api.S;
		const rec = {
			id: activeProjId,
			name: customName || existing?.name || 'Dự án Kịch bản Voice',
			lines: (S.lines || []).map(({status, ...l}) => l),
			nextId: S.nextId || 1,
			extraChars: S.extraChars || [],
			mapping: S.mapping || {},
			defaultEp: document.getElementById('defaultEp')?.value || '',
			updatedAt: Date.now(),
			updatedAtText: new Date().toLocaleString('vi-VN', {hour12: false}),
		};
		await window.STS_DB.put(APP, 'projects', activeProjId, rec);
		await refreshDbBar();
	}

	function autoSync() {
		clearTimeout(syncTimer);
		syncTimer = setTimeout(() => {
			saveActiveProject().catch(() => {});
		}, 350);
	}

	async function createNewDbProject() {
		const name = prompt('Nhập tên dự án Kịch bản Voice mới để lưu trong Database:', `Dự án Voice ${new Date().toLocaleDateString('vi-VN')}`);
		if (!name || !name.trim()) return;
		const id = 'vp_' + Date.now();
		activeProjId = id;
		localStorage.setItem('sts_voice_active_proj', id);
		await saveActiveProject(name.trim());
		window.VOICE_STUDIO_API?.toast?.(`Đã tạo & lưu "${name.trim()}" vào Database!`, 'ok');
	}

	async function deleteActiveDbProject() {
		const items = await window.STS_DB.list(APP, 'projects');
		if (items.length <= 1) {
			window.VOICE_STUDIO_API?.toast?.('Cần giữ tối thiểu 1 dự án trong Database', 'err');
			return;
		}
		const cur = items.find((x) => x.id === activeProjId);
		if (!confirm(`Xoá dự án "${cur?.name || activeProjId}" khỏi Database?`)) return;
		await window.STS_DB.delete(APP, 'projects', activeProjId);
		const remaining = await window.STS_DB.list(APP, 'projects');
		const next = remaining[0];
		if (next) {
			activeProjId = next.id;
			localStorage.setItem('sts_voice_active_proj', activeProjId);
			applyProjectToEditor(next, true);
		}
		await refreshDbBar();
	}

	async function refreshDbBar() {
		if (!window.STS_DB) return;
		const items = (await window.STS_DB.list(APP, 'projects')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
		const sel = document.getElementById('voiceDbProjSelect');
		if (sel) {
			sel.innerHTML = items
				.map((it) => `<option value="${it.id}" ${it.id === activeProjId ? 'selected' : ''}>📁 ${it.name} (${(it.lines || []).length} câu · ${it.updatedAtText || 'mới'})</option>`)
				.join('');
		}
		const meta = document.getElementById('voiceDbMeta');
		if (meta) {
			const cur = items.find((x) => x.id === activeProjId) || items[0];
			meta.textContent = cur ? `Đã lưu tự động vào Database (${(cur.lines || []).length} dòng thoại · ${Object.keys(cur.mapping || {}).length} giọng đã gán)` : 'Database sẵn sàng';
		}
	}

	async function injectDbBar() {
		const scriptTab = document.getElementById('tab-script');
		if (scriptTab && !document.getElementById('voiceDbBar')) {
			const pageHead = scriptTab.querySelector('.page-head');
			const bar = document.createElement('div');
			bar.id = 'voiceDbBar';
			bar.className = 'card';
			bar.style.cssText = 'border:1px solid rgba(99,102,241,0.35);background:linear-gradient(90deg,rgba(30,27,75,0.55),rgba(15,23,42,0.85));margin-bottom:14px;padding:12px 16px';
			bar.innerHTML = `
				<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:10px">
					<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
						<b style="color:#a5b4fc;font-size:13px">🗄 Dự án Database:</b>
						<select id="voiceDbProjSelect" style="min-width:260px;padding:6px 10px;border-radius:8px"></select>
						<span id="voiceDbMeta" class="muted" style="font-size:12px">Đang tải Database…</span>
					</div>
					<div class="row" style="gap:8px">
						<button type="button" class="primary sm" id="voiceDbSaveBtn">💾 Lưu vào DB</button>
						<button type="button" class="ghost sm" id="voiceDbNewBtn">＋ Lưu thành dự án mới</button>
						<button type="button" class="danger sm" id="voiceDbDelBtn">🗑 Xoá dự án</button>
					</div>
				</div>
			`;
			if (pageHead && pageHead.nextSibling) {
				scriptTab.insertBefore(bar, pageHead.nextSibling);
			} else {
				scriptTab.prepend(bar);
			}

			document.getElementById('voiceDbProjSelect').onchange = async (e) => {
				const newId = e.target.value;
				activeProjId = newId;
				localStorage.setItem('sts_voice_active_proj', newId);
				const items = await window.STS_DB.list(APP, 'projects');
				const found = items.find((x) => x.id === newId);
				if (found) applyProjectToEditor(found, true);
				await refreshDbBar();
			};
			document.getElementById('voiceDbSaveBtn').onclick = async () => {
				await saveActiveProject();
				window.VOICE_STUDIO_API?.toast?.('Đã lưu kịch bản & gán giọng vào Database!', 'ok');
			};
			document.getElementById('voiceDbNewBtn').onclick = createNewDbProject;
			document.getElementById('voiceDbDelBtn').onclick = deleteActiveDbProject;
		}

		await ensureDefaultProject();
		await refreshDbBar();
	}

	window.VOICE_DB = {
		autoSync,
		saveActiveProject,
		refreshDbBar,
	};

	// ---- Tự động nạp dữ liệu mới khi dự án được cập nhật từ tab / thiết bị khác
	let lastAppliedTs = 0;
	window.addEventListener('sts-db-remote-updated', async (e) => {
		const apps = e.detail?.apps || [];
		if (apps.length && !apps.includes(APP)) return;
		const el = document.activeElement;
		const editing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.closest('#tab-script');
		const items = await window.STS_DB.list(APP, 'projects');
		const cur = items.find((x) => x.id === activeProjId);
		if (cur && (cur.updatedAt || 0) > lastAppliedTs && !editing) {
			lastAppliedTs = cur.updatedAt || Date.now();
			const api = window.VOICE_STUDIO_API;
			const localJson = JSON.stringify((api?.S?.lines || []).map(({status, ...l}) => l));
			if (localJson !== JSON.stringify(cur.lines || [])) applyProjectToEditor(cur, true);
		}
		await refreshDbBar();
	});

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', injectDbBar);
	} else {
		injectDbBar();
	}
})();
