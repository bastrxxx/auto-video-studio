// Vlive PSD Studio — Database Engine (IndexedDB + SQLite sync via window.STS_DB)
(() => {
	const APP = 'vlive-psd-studio';
	const BLOB_DB = 'VlivePsdBlobsDB';

	function openBlobDb() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(BLOB_DB, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains('blobs')) {
					db.createObjectStore('blobs', {keyPath: 'id'});
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	async function putBlob(id, blob) {
		try {
			const db = await openBlobDb();
			await new Promise((resolve, reject) => {
				const tx = db.transaction('blobs', 'readwrite');
				tx.objectStore('blobs').put({id, blob, updatedAt: Date.now()});
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		} catch {}
	}

	async function getBlob(id) {
		try {
			const db = await openBlobDb();
			return await new Promise((resolve) => {
				const tx = db.transaction('blobs', 'readonly');
				const req = tx.objectStore('blobs').get(id);
				req.onsuccess = () => resolve(req.result?.blob || null);
				req.onerror = () => resolve(null);
			});
		} catch {
			return null;
		}
	}

	async function deleteBlob(id) {
		try {
			const db = await openBlobDb();
			await new Promise((resolve) => {
				const tx = db.transaction('blobs', 'readwrite');
				tx.objectStore('blobs').delete(id);
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
			});
		} catch {}
	}

	const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(0) + ' KB' : (n || 0) + ' B');

	async function listProjects() {
		if (!window.STS_DB) return [];
		const items = await window.STS_DB.list(APP, 'projects');
		return (items || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	}

	function makeThumb() {
		try {
			const api = window.__psdStudio;
			if (!api?.state?.psd) return '';
			const comp = api.renderComposite(true);
			const c = document.createElement('canvas');
			c.width = 220;
			c.height = Math.max(1, Math.round((220 * comp.height) / Math.max(1, comp.width)));
			c.getContext('2d').drawImage(comp, 0, 0, c.width, c.height);
			return c.toDataURL('image/jpeg', 0.78);
		} catch {
			return '';
		}
	}

	async function saveBlobToDb(blob, fileName) {
		if (!window.STS_DB || !blob) return null;
		const api = window.__psdStudio;
		const psd = api?.state?.psd;
		const cleanName = String(fileName || api?.state?.fileName || 'design.psd');
		const id = 'psd_' + cleanName.toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
		const meta = {
			id,
			fileName: cleanName,
			fileSize: blob.size || 0,
			width: psd?.width || 0,
			height: psd?.height || 0,
			layerCount: api?.allLayers ? api.allLayers().length : 0,
			thumb: makeThumb(),
			updatedAt: Date.now(),
			updatedAtText: new Date().toLocaleString('vi-VN', {hour12: false}),
		};
		await putBlob(id, blob);
		await window.STS_DB.put(APP, 'projects', id, meta);
		await renderDbViews();
		return meta;
	}

	async function saveCurrentEditorToDb() {
		const api = window.__psdStudio;
		if (!api?.state?.psd) {
			api?.toast?.('Hãy mở một file PSD trước khi lưu vào Database', true);
			return;
		}
		try {
			const exported = await api.exportCurrentToBlob();
			if (!exported) return;
			await saveBlobToDb(exported.blob, exported.fileName);
			api.toast('Đã lưu dự án PSD vào Database!', 'success');
		} catch (err) {
			api?.toast?.('Lỗi lưu Database: ' + err.message, true);
		}
	}

	async function openFromDb(id) {
		const items = await listProjects();
		const meta = items.find((x) => x.id === id);
		const blob = await getBlob(id);
		const api = window.__psdStudio;
		if (!blob || !meta) {
			api?.toast?.('Không tìm thấy dữ liệu nhị phân PSD trong trình duyệt này', true);
			return;
		}
		const file = new File([blob], meta.fileName || 'design.psd', {type: 'image/vnd.adobe.photoshop'});
		const modal = document.getElementById('psdDbModal');
		if (modal) modal.hidden = true;
		await api.openFile(file);
	}

	async function downloadFromDb(id) {
		const items = await listProjects();
		const meta = items.find((x) => x.id === id);
		const blob = await getBlob(id);
		if (!blob || !meta) return;
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = meta.fileName || 'design.psd';
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	async function removeFromDb(id) {
		if (!confirm('Xoá dự án PSD này khỏi Database?')) return;
		await deleteBlob(id);
		await window.STS_DB?.delete(APP, 'projects', id);
		await renderDbViews();
	}

	async function renderDbViews() {
		const items = await listProjects();
		const badge = document.getElementById('psdDbCount');
		if (badge) badge.textContent = String(items.length);

		// Render in Dropzone quick list
		const dzBox = document.getElementById('psdDzDbBox');
		if (dzBox) {
			if (!items.length) {
				dzBox.innerHTML = `<div style="font-size:12px;color:#94a3b8;margin-top:10px">🗄 Database sẵn sàng — Mỗi file PSD bạn mở hoặc lưu sẽ tự động lưu vào Database.</div>`;
			} else {
				dzBox.innerHTML = `
					<div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(148,163,184,.18);text-align:left;width:100%">
						<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
							<b style="font-size:12px;color:#cbd5e1">🗄 Dự án PSD trong Database (${items.length})</b>
							<button type="button" class="btn sm" id="dzOpenDbModalBtn" style="font-size:11px;padding:3px 8px">Quản lý tất cả</button>
						</div>
						<div style="display:flex;flex-direction:column;gap:6px;max-height:165px;overflow:auto">
							${items
								.slice(0, 5)
								.map(
									(it) => `
								<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border-radius:8px;background:rgba(15,23,42,.65);border:1px solid rgba(148,163,184,.16)">
									<div style="min-width:0;flex:1">
										<div style="font-size:12px;font-weight:600;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${it.fileName}</div>
										<div style="font-size:11px;color:#94a3b8">${it.width}×${it.height}px · ${it.layerCount} layers · ${fmtSize(it.fileSize)}</div>
									</div>
									<button type="button" class="btn primary sm" data-db-open="${it.id}" style="padding:4px 10px;font-size:11px">Mở</button>
								</div>
							`,
								)
								.join('')}
						</div>
					</div>
				`;
				dzBox.querySelectorAll('[data-db-open]').forEach((b) => {
					b.onclick = () => openFromDb(b.dataset.dbOpen);
				});
				const mgr = document.getElementById('dzOpenDbModalBtn');
				if (mgr) mgr.onclick = () => openDbModal();
			}
		}

		// Render in Modal list
		const listEl = document.getElementById('psdDbList');
		if (listEl) {
			if (!items.length) {
				listEl.innerHTML = `<div style="padding:28px;text-align:center;color:#94a3b8;font-size:13px">Chưa có file PSD nào trong Database. Hãy mở một file .PSD hoặc bấm <b>"Lưu bản đang sửa vào DB"</b>.</div>`;
			} else {
				listEl.innerHTML = items
					.map(
						(it) => `
					<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:rgba(15,23,42,.55);border:1px solid rgba(148,163,184,.18)">
						${
							it.thumb
								? `<img src="${it.thumb}" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:6px;background:#090d16;border:1px solid rgba(255,255,255,.08)" />`
								: `<div style="width:52px;height:52px;border-radius:6px;background:#1e293b;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;color:#60a5fa">PSD</div>`
						}
						<div style="flex:1;min-width:0">
							<div style="font-weight:600;font-size:13px;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${it.fileName}</div>
							<div style="font-size:11px;color:#94a3b8;margin-top:2px">${it.width}×${it.height}px · ${it.layerCount} layers · ${fmtSize(it.fileSize)} · Lưu lúc ${it.updatedAtText || ''}</div>
						</div>
						<div style="display:flex;gap:6px">
							<button type="button" class="btn primary" data-db-open="${it.id}" style="padding:6px 11px;font-size:12px">📂 Mở</button>
							<button type="button" class="btn" data-db-dl="${it.id}" style="padding:6px 10px;font-size:12px">⬇ Tải</button>
							<button type="button" class="btn danger" data-db-del="${it.id}" style="padding:6px 10px;font-size:12px">🗑</button>
						</div>
					</div>
				`,
					)
					.join('');
				listEl.querySelectorAll('[data-db-open]').forEach((b) => (b.onclick = () => openFromDb(b.dataset.dbOpen)));
				listEl.querySelectorAll('[data-db-dl]').forEach((b) => (b.onclick = () => downloadFromDb(b.dataset.dbDl)));
				listEl.querySelectorAll('[data-db-del]').forEach((b) => (b.onclick = () => removeFromDb(b.dataset.dbDel)));
			}
		}
	}

	function openDbModal() {
		const modal = document.getElementById('psdDbModal');
		if (!modal) return;
		modal.hidden = false;
		renderDbViews();
	}

	function injectUi() {
		const topActions = document.querySelector('.top-actions');
		if (topActions && !document.getElementById('psdDbBtn')) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'tbtn';
			btn.id = 'psdDbBtn';
			btn.title = 'Quản lý các dự án PSD trong Database (IndexedDB + SQLite)';
			btn.innerHTML = `<span style="font-size:13px">🗄</span><span>Dự án DB (<b id="psdDbCount">0</b>)</span>`;
			btn.onclick = openDbModal;
			topActions.insertBefore(btn, topActions.firstChild);
		}

		const dzCard = document.querySelector('.dz-card');
		if (dzCard && !document.getElementById('psdDzDbBox')) {
			const box = document.createElement('div');
			box.id = 'psdDzDbBox';
			dzCard.appendChild(box);
		}

		if (!document.getElementById('psdDbModal')) {
			const modal = document.createElement('div');
			modal.className = 'modal';
			modal.id = 'psdDbModal';
			modal.hidden = true;
			modal.innerHTML = `
				<div class="modal-card" style="max-width:620px;width:92vw">
					<div class="modal-head">
						<h3>🗄 Cơ sở dữ liệu Vlive PSD Studio</h3>
						<button class="icon-btn" id="psdDbCloseBtn" type="button">✕</button>
					</div>
					<div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
						<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:10px;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.28)">
							<div style="font-size:12px;color:#cbd5e1">Lưu trữ toàn bộ file PSD, layer, smart object và lịch sử chỉnh sửa vào <b>IndexedDB + SQLite Database</b>.</div>
							<button type="button" class="btn primary" id="psdDbSaveNowBtn" style="white-space:nowrap">💾 Lưu bản đang sửa vào DB</button>
						</div>
						<div id="psdDbList" style="display:flex;flex-direction:column;gap:8px;max-height:55vh;overflow:auto"></div>
					</div>
				</div>
			`;
			document.body.appendChild(modal);
			modal.addEventListener('click', (e) => {
				if (e.target === modal) modal.hidden = true;
			});
			document.getElementById('psdDbCloseBtn').onclick = () => (modal.hidden = true);
			document.getElementById('psdDbSaveNowBtn').onclick = () => saveCurrentEditorToDb();
		}

		renderDbViews();
	}

	window.PSD_DB = {
		onPsdOpened(file) {
			saveBlobToDb(file, file.name).catch(() => {});
		},
		saveBlobToDb,
		saveCurrentEditorToDb,
		openDbModal,
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', injectUi);
	} else {
		injectUi();
	}
})();
