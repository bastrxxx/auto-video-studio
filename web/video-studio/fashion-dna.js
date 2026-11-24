// Fashion 20-30s Studio + TikTok Channel DNA Learner + AI Voice Over Reasoner + 3-Second Hook Director
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

let ctx = {
	api: null,
	getApiBase: () => '',
	getOpts: () => ({}),
	applyPatch: () => {},
	switchView: () => {},
};

const DRAFT_KEY = 'avs.fashionDraft.v1';

const localState = {
	agy: null,
	dnaList: [],
	selectedDnaId: '',
	mergeIds: new Set(),
	voResult: null,
	voAudioMap: {},
	hook3sResult: null,
};

function saveFashionDraft() {
	const draft = {
		selectedDnaId: localState.selectedDnaId || '',
		dnaUrls: $('#dnaUrlsInput')?.value || '',
		dnaName: $('#dnaNameInput')?.value || '',
		dnaNiche: $('#dnaNicheInput')?.value || '',
		dnaNotes: $('#dnaNotesInput')?.value || '',
		voUserInput: $('#voUserInput')?.value || '',
		voTargetSec: $('#voTargetSec')?.value || '25',
		voDnaSelect: $('#voDnaSelect')?.value || '',
		voBrandStyle: $('#voBrandStyle')?.value || '',
		voVoiceSelect: $('#voVoiceSelect')?.value || 'vi-female-natural',
		voResult: localState.voResult || null,
		voAudioMap: localState.voAudioMap || {},
		hook3sResult: localState.hook3sResult || null,
		updatedAt: Date.now(),
	};
	try {
		localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
	} catch {}
	if (window.STS_DB?.put) {
		window.STS_DB.put('video-studio', 'workspace_draft', 'current', draft).catch(() => {});
	}
}

async function restoreFashionDraft() {
	let draft = null;
	try {
		draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
	} catch {}
	if (!draft && window.STS_DB?.get) {
		draft = await window.STS_DB.get('video-studio', 'workspace_draft', 'current').catch(() => null);
	}
	if (!draft || typeof draft !== 'object') return;
	if (draft.selectedDnaId) localState.selectedDnaId = draft.selectedDnaId;
	if (draft.dnaUrls && $('#dnaUrlsInput')) $('#dnaUrlsInput').value = draft.dnaUrls;
	if (draft.dnaName && $('#dnaNameInput')) $('#dnaNameInput').value = draft.dnaName;
	if (draft.dnaNiche && $('#dnaNicheInput')) $('#dnaNicheInput').value = draft.dnaNiche;
	if (draft.dnaNotes && $('#dnaNotesInput')) $('#dnaNotesInput').value = draft.dnaNotes;
	if (draft.voUserInput && $('#voUserInput')) $('#voUserInput').value = draft.voUserInput;
	if (draft.voTargetSec && $('#voTargetSec')) $('#voTargetSec').value = draft.voTargetSec;
	if (draft.voDnaSelect && $('#voDnaSelect')) $('#voDnaSelect').value = draft.voDnaSelect;
	if (draft.voBrandStyle && $('#voBrandStyle')) $('#voBrandStyle').value = draft.voBrandStyle;
	if (draft.voVoiceSelect && $('#voVoiceSelect')) $('#voVoiceSelect').value = draft.voVoiceSelect;
	if (draft.voAudioMap && typeof draft.voAudioMap === 'object') localState.voAudioMap = draft.voAudioMap;
	if (draft.voResult) {
		localState.voResult = draft.voResult;
		renderVoiceOverResults();
	}
	if (draft.hook3sResult) {
		localState.hook3sResult = draft.hook3sResult;
		const box = $('#hook3sStandaloneBox');
		if (box) {
			box.classList.remove('hidden');
			box.innerHTML = renderHook3sCardHtml(draft.hook3sResult, true);
			bindHook3sApplyButtons(box, draft.hook3sResult);
		}
	}
}

export async function initFashionStudio(bridge) {
	ctx = bridge;
	bindFashionSetup();
	bindDnaView();
	bindVoiceOverView();
	for (const id of ['#dnaUrlsInput', '#dnaNameInput', '#dnaNicheInput', '#dnaNotesInput', '#voUserInput', '#voTargetSec', '#voDnaSelect', '#voBrandStyle', '#voVoiceSelect']) {
		$(id)?.addEventListener('input', saveFashionDraft);
		$(id)?.addEventListener('change', saveFashionDraft);
	}
	await Promise.all([refreshAgyStatus(), refreshDnaList()]);
	await restoreFashionDraft();
	renderDnaLibrary();
	renderDnaDetail();
	syncFashionSetupUI();
}

export function syncFashionSetupUI() {
	const opts = ctx.getOpts() || {};
	const fashionChk = $('#optFashionMode');
	if (fashionChk) fashionChk.checked = opts.fashionMode !== false;

	const durSel = $('#optTargetRange');
	if (durSel) durSel.value = opts.targetDurationRange || '20-30';

	const dnaSel = $('#optDnaProfile');
	if (dnaSel) dnaSel.value = opts.dnaProfileId || '';

	const voDnaSel = $('#voDnaSelect');
	if (voDnaSel && !voDnaSel.value && opts.dnaProfileId) voDnaSel.value = opts.dnaProfileId;

	const hookInp = $('#optHook3sDesc');
	if (hookInp && document.activeElement !== hookInp) hookInp.value = opts.hook3sDescription || '';

	const muteOrig = $('#optVoMuteOriginal');
	if (muteOrig) muteOrig.checked = Boolean(opts.voiceOverMuteOriginal);

	const voBadge = $('#setupVoBadge');
	if (voBadge) {
		if (opts.voiceOverAudioUrl) {
			voBadge.innerHTML = `🎙️ Đã gắn Audio Voice Over <audio controls src="${esc(resolveMedia(opts.voiceOverAudioUrl))}" style="height:28px;vertical-align:middle;margin-left:8px"></audio> <button type="button" class="ghost sm" id="clearVoAudioBtn">✕ Gỡ</button>`;
			voBadge.classList.remove('hidden');
			$('#clearVoAudioBtn')?.addEventListener('click', () => {
				ctx.applyPatch({voiceOverAudioUrl: ''});
				syncFashionSetupUI();
			});
		} else if (opts.voiceOverScript) {
			voBadge.innerHTML = `📝 Đã chọn kịch bản VO (${opts.voiceOverScript.split(/\s+/).filter(Boolean).length} từ) — AI sẽ căn nhịp cut theo kịch bản này`;
			voBadge.classList.remove('hidden');
		} else {
			voBadge.classList.add('hidden');
		}
	}
}

export function renderResultHook3s(hook3s) {
	const box = $('#resultHook3sBox');
	if (!box) return;
	if (!hook3s) {
		box.classList.add('hidden');
		return;
	}
	box.classList.remove('hidden');
	box.innerHTML = renderHook3sCardHtml(hook3s, false);
}

function resolveMedia(u) {
	if (!u) return '';
	const base = ctx.getApiBase();
	return u.startsWith('/') && base ? `${base}${u}` : u;
}

// ---------------------------------------------------------------- AGY CLI Model Picker
async function refreshAgyStatus() {
	try {
		const res = await ctx.api('/api/agy/status');
		localState.agy = res;
		renderAgySelectors();
	} catch {
		localState.agy = null;
	}
}

function renderAgySelectors() {
	const agy = localState.agy;
	const badge = $('#agyStatusPill');
	if (badge) {
		if (agy?.installed) {
			badge.className = 'pill ok';
			badge.textContent = `🤖 AGY CLI · ${agy.activeModel || 'auto'}`;
			badge.title = `${agy.binPath} (${agy.version || 'ready'})`;
		} else {
			badge.className = 'pill bad';
			badge.textContent = '🤖 AGY CLI chưa cài';
		}
	}
	const models = agy?.models || [{id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', family: 'Gemini'}];
	const active = agy?.activeModel || 'gemini-4-neon-medium';
	const html = models.map((m) => `<option value="${esc(m.id)}">[${esc(m.family)}] ${esc(m.label)}</option>`).join('');

	for (const id of ['#agyModelSelect', '#dnaModelSelect', '#voModelSelect']) {
		const sel = $(id);
		if (!sel) continue;
		sel.innerHTML = html;
		if ([...sel.options].some((o) => o.value === active)) sel.value = active;
	}
}

function bindFashionSetup() {
	$('#agyModelSelect')?.addEventListener('change', async (e) => {
		const model = e.target.value;
		try {
			const res = await ctx.api('/api/agy/config', {method: 'PUT', body: {enabled: true, model}});
			localState.agy = res;
			renderAgySelectors();
		} catch (err) {
			alert('Lỗi đổi model AGY: ' + err.message);
		}
	});

	$('#optFashionMode')?.addEventListener('change', (e) => {
		const on = e.target.checked;
		const patch = {fashionMode: on};
		if (on) {
			patch.format = '9:16';
			patch.platform = 'tiktok';
			if (!ctx.getOpts().maxDuration) patch.maxDuration = 28;
		}
		ctx.applyPatch(patch);
		syncFashionSetupUI();
	});

	$('#optTargetRange')?.addEventListener('change', (e) => {
		const val = e.target.value;
		const map = {'20-30': 28, '15-20': 18, '30-45': 40, auto: 0};
		ctx.applyPatch({targetDurationRange: val, maxDuration: map[val] ?? 28});
		syncFashionSetupUI();
	});

	$('#optDnaProfile')?.addEventListener('change', (e) => {
		const id = e.target.value;
		if (!id) {
			ctx.applyPatch({dnaProfileId: ''});
			return;
		}
		const dna = localState.dnaList.find((d) => d.id === id);
		if (dna) applyDnaToProject(dna, false);
	});

	$('#optHook3sDesc')?.addEventListener('input', (e) => {
		ctx.applyPatch({hook3sDescription: e.target.value});
	});

	$('#optVoMuteOriginal')?.addEventListener('change', (e) => {
		ctx.applyPatch({voiceOverMuteOriginal: e.target.checked});
	});

	$('#openDnaTabBtn')?.addEventListener('click', () => ctx.switchView('dna'));
	$('#openVoTabBtn')?.addEventListener('click', () => ctx.switchView('voiceover'));
}

// ---------------------------------------------------------------- TikTok Channel DNA Learner
async function refreshDnaList() {
	try {
		const res = await ctx.api('/api/dna');
		localState.dnaList = res.items || [];
		if (!localState.selectedDnaId && localState.dnaList.length) {
			localState.selectedDnaId = localState.dnaList[0].id;
		}
		renderDnaDropdowns();
		renderDnaLibrary();
		renderDnaDetail();
	} catch {}
}

function renderDnaDropdowns() {
	const optsHtml =
		`<option value="">— Chưa áp dụng DNA kênh —</option>` +
		localState.dnaList
			.map((d) => `<option value="${esc(d.id)}">🧬 ${esc(d.name)} (${d.metrics?.avgShotLengthSec || 1.6}s/shot · ${d.editingPreset?.style || 'editorial'})</option>`)
			.join('');

	for (const id of ['#optDnaProfile', '#voDnaSelect']) {
		const sel = $(id);
		if (!sel) continue;
		const prev = sel.value || (id === '#optDnaProfile' ? ctx.getOpts()?.dnaProfileId : '') || '';
		sel.innerHTML = optsHtml;
		if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
	}
}

function bindDnaView() {
	$('#dnaLearnBtn')?.addEventListener('click', async () => {
		const rawUrls = ($('#dnaUrlsInput')?.value || '').trim();
		const files = $('#dnaRefFiles')?.files ? [...$('#dnaRefFiles').files] : [];
		if (!rawUrls && !files.length) {
			alert('Hãy dán ít nhất 1 link kênh TikTok (hoặc chọn file video mẫu).');
			return;
		}
		const btn = $('#dnaLearnBtn');
		const statusEl = $('#dnaLearnStatus');
		btn.disabled = true;
		btn.textContent = '⏳ Đang cào kênh, đo FFmpeg & phân tích DNA bằng AGY CLI...';
		if (statusEl) {
			statusEl.textContent = 'Đang phân tích cấu trúc cắt ghép, hook 3 giây đầu, nhịp shot và phong cách dựng của kênh…';
			statusEl.classList.remove('hidden');
		}
		try {
			let j;
			const payload = {
				urls: rawUrls,
				name: ($('#dnaNameInput')?.value || '').trim(),
				niche: ($('#dnaNicheInput')?.value || 'Thời trang 20-30s (Lookbook / Phối đồ / Review)').trim(),
				notes: ($('#dnaNotesInput')?.value || '').trim(),
				model: $('#dnaModelSelect')?.value || '',
			};
			if (files.length) {
				const token = localStorage.getItem('avs.token') || '';
				const fd = new FormData();
				Object.entries(payload).forEach(([k, v]) => fd.append(k, v));
				for (const f of files) fd.append('referenceVideos', f);
				const res = await fetch(`${ctx.getApiBase()}/api/dna/learn`, {
					method: 'POST',
					headers: token ? {Authorization: `Bearer ${token}`} : {},
					credentials: 'include',
					body: fd,
				});
				j = await res.json();
				if (!res.ok || !j.ok) throw new Error(j.error || res.statusText);
			} else {
				j = await ctx.api('/api/dna/learn', {method: 'POST', body: payload});
			}

			localState.dnaList = j.items || [];
			localState.selectedDnaId = j.item?.id || '';
			if (j.item?.id && window.STS_DB?.put) {
				window.STS_DB.put('video-studio', 'tiktok_dna', j.item.id, j.item).catch(() => {});
			}
			renderDnaDropdowns();
			renderDnaLibrary();
			renderDnaDetail();
			if (statusEl) statusEl.textContent = `✅ Đã học xong DNA "${j.item.name}" bằng ${j.item.modelUsed} và lưu vào Database!`;
		} catch (err) {
			if (statusEl) statusEl.textContent = `❌ Lỗi: ${err.message}`;
			alert('Không học được DNA kênh: ' + err.message);
		} finally {
			btn.disabled = false;
			btn.textContent = '🧬 Bắt đầu học DNA kênh';
		}
	});

	$('#dnaMergeBtn')?.addEventListener('click', async () => {
		const ids = [...localState.mergeIds];
		if (ids.length < 2) {
			alert('Hãy tick chọn ít nhất 2 hồ sơ DNA trong thư viện để hợp nhất.');
			return;
		}
		const btn = $('#dnaMergeBtn');
		btn.disabled = true;
		btn.textContent = '⏳ Đang hợp nhất Master DNA...';
		try {
			const res = await ctx.api('/api/dna/merge', {
				method: 'POST',
				body: {ids, model: $('#dnaModelSelect')?.value || ''},
			});
			localState.mergeIds.clear();
			localState.dnaList = res.items || [];
			localState.selectedDnaId = res.item?.id || '';
			renderDnaDropdowns();
			renderDnaLibrary();
			renderDnaDetail();
		} catch (err) {
			alert('Lỗi hợp nhất DNA: ' + err.message);
		} finally {
			btn.disabled = false;
			btn.textContent = '🔀 Hợp nhất các kênh đã chọn';
		}
	});
}

function renderDnaLibrary() {
	const listEl = $('#dnaList');
	if (!listEl) return;
	if (!localState.dnaList.length) {
		listEl.innerHTML = `<p class="muted" style="padding:10px 0">Chưa có hồ sơ DNA nào. Dán link kênh TikTok ở trên rồi bấm <b>Học DNA kênh</b>.</p>`;
		return;
	}
	listEl.innerHTML = localState.dnaList
		.map((d) => {
			const on = d.id === localState.selectedDnaId;
			const checked = localState.mergeIds.has(d.id);
			const handles = (d.channels || []).map((c) => c.handle).join(', ');
			return `<div class="dna-item ${on ? 'on' : ''}" data-id="${esc(d.id)}">
				<label class="dna-chk" title="Chọn để hợp nhất nhiều kênh"><input type="checkbox" data-merge="${esc(d.id)}" ${checked ? 'checked' : ''} /></label>
				<div class="dna-item-body" data-select="${esc(d.id)}">
					<b>${esc(d.name)}</b>
					<small>${esc(handles)} · ${d.metrics?.avgShotLengthSec || 1.6}s/shot · ${d.editingPreset?.maxDuration || 28}s · ${esc(d.editingPreset?.style || 'editorial')}</small>
				</div>
				<div class="dna-item-acts">
					<button type="button" class="ghost sm" data-apply="${esc(d.id)}">✅ Áp dụng</button>
					<button type="button" class="ghost sm danger" data-del="${esc(d.id)}" title="Xoá DNA">✕</button>
				</div>
			</div>`;
		})
		.join('');

	$$('[data-select]', listEl).forEach((el) =>
		el.addEventListener('click', () => {
			localState.selectedDnaId = el.dataset.select;
			renderDnaLibrary();
			renderDnaDetail();
		}),
	);
	$$('[data-merge]', listEl).forEach((el) =>
		el.addEventListener('change', (e) => {
			const id = el.dataset.merge;
			if (e.target.checked) localState.mergeIds.add(id);
			else localState.mergeIds.delete(id);
			const mBtn = $('#dnaMergeBtn');
			if (mBtn) mBtn.disabled = localState.mergeIds.size < 2;
		}),
	);
	$$('[data-apply]', listEl).forEach((el) =>
		el.addEventListener('click', () => {
			const dna = localState.dnaList.find((d) => d.id === el.dataset.apply);
			if (dna) applyDnaToProject(dna, true);
		}),
	);
	$$('[data-del]', listEl).forEach((el) =>
		el.addEventListener('click', async () => {
			if (!confirm('Xoá hồ sơ DNA này?')) return;
			const res = await ctx.api(`/api/dna/${el.dataset.del}`, {method: 'DELETE'});
			localState.dnaList = res.items || [];
			if (localState.selectedDnaId === el.dataset.del) localState.selectedDnaId = localState.dnaList[0]?.id || '';
			renderDnaDropdowns();
			renderDnaLibrary();
			renderDnaDetail();
		}),
	);
}

function renderDnaDetail() {
	const box = $('#dnaDetail');
	if (!box) return;
	const d = localState.dnaList.find((x) => x.id === localState.selectedDnaId);
	if (!d) {
		box.innerHTML = `<div class="muted" style="padding:18px;text-align:center">Chọn một hồ sơ DNA bên trái hoặc nhập link kênh TikTok mới để xem phân tích chi tiết.</div>`;
		return;
	}
	const m = d.metrics || {};
	const h = d.hook3sFormula || {};
	const p = d.pacingCurve || {};
	const ep = d.editingPreset || {};
	box.innerHTML = `
		<div class="dna-detail-head">
			<div>
				<h3>🧬 ${esc(d.name)}</h3>
				<small class="muted">Model: <b>${esc(d.modelUsed)}</b> · Ngách: ${esc(d.niche)} · ${(d.channels || []).map((c) => `${esc(c.handle)} (${c.videoCount} video, ${c.sampledVideos} đo FFmpeg)`).join(' · ')}</small>
			</div>
			<button type="button" class="primary" id="dnaApplyDetailBtn">✅ Áp dụng DNA này vào Auto-Edit</button>
		</div>
		<p class="dna-summary">${esc(d.summary)}</p>

		<div class="dna-metrics">
			<div class="dm-card"><span>Thời lượng TB</span><b>${esc(m.avgDurationSec || 25)}s</b><small>Mục tiêu ${(m.targetRangeSec || [20, 30]).join('–')}s</small></div>
			<div class="dm-card"><span>Độ dài 1 shot</span><b>${esc(m.avgShotLengthSec || 1.6)}s</b><small>${esc(m.cutsPer10Sec || 6)} cuts / 10s</small></div>
			<div class="dm-card"><span>Tốc độ thoại</span><b>${esc(m.wordsPerSec || 3.1)} từ/s</b><small>Nhạc: ${esc(m.musicEnergy || 'high')}</small></div>
			<div class="dm-card"><span>Preset Remotion</span><b>${esc(ep.style || 'editorial')}</b><small>${esc(ep.pace)} · ${esc(ep.transition)} · zoom ${esc(ep.zoom)}x</small></div>
		</div>

		<div class="dna-grid">
			<div class="dna-panel">
				<h4>⚡ Công thức Hook 3 giây đầu</h4>
				<ul>
					<li><b>Mô thức:</b> ${esc(h.pattern)}</li>
					<li><b>Hình ảnh 0–3s:</b> ${esc(h.visualPattern)}</li>
					<li><b>Kiểu chữ:</b> ${esc(h.textStyle)}</li>
					<li><b>Âm thanh:</b> ${esc(h.audioImpact)}</li>
				</ul>
				${(h.examples || []).length ? `<div class="dna-chips">${h.examples.map((ex) => `<span>“${esc(ex)}”</span>`).join('')}</div>` : ''}
			</div>

			<div class="dna-panel">
				<h4>⏱ Đường cong nhịp điệu (Pacing Curve)</h4>
				<ul>
					<li><b>0–3s (Hook):</b> ${esc(p.intro0to3s)}</li>
					<li><b>3–20s (Thân bài):</b> ${esc(p.body3to20s)}</li>
					<li><b>20–30s (Chốt & CTA):</b> ${esc(p.outro20to30s)}</li>
				</ul>
				<div class="muted" style="margin-top:8px">🎨 Màu sắc: <b>${esc(ep.colorMood)}</b></div>
			</div>

			<div class="dna-panel">
				<h4>🎬 Ngữ pháp Shot Thời trang (Shot Grammar)</h4>
				<ol>${(d.shotGrammar || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
			</div>

			<div class="dna-panel">
				<h4>🏆 Quy tắc Viral &amp; Điều cần tránh</h4>
				<ul class="ok-list">${(d.viralRules || []).map((r) => `<li>✅ ${esc(r)}</li>`).join('')}</ul>
				<ul class="bad-list">${(d.avoidRules || []).map((r) => `<li>⛔ ${esc(r)}</li>`).join('')}</ul>
			</div>
		</div>
	`;

	$('#dnaApplyDetailBtn')?.addEventListener('click', () => applyDnaToProject(d, true));
}

function applyDnaToProject(dna, goToSetup) {
	const ep = dna.editingPreset || {};
	ctx.applyPatch({
		dnaProfileId: dna.id,
		fashionMode: true,
		style: ep.style || 'editorial',
		pace: ep.pace || 'fast',
		transition: ep.transition || 'flash',
		zoom: Number(ep.zoom) || 1.2,
		sfx: ep.sfx || 'standard',
		wordsPerGroup: Number(ep.wordsPerGroup) || 3,
		maxDuration: Number(ep.maxDuration) || 28,
		accent: ep.accent || '',
		hook3sDescription: `${dna.hook3sFormula?.pattern || ''} | ${dna.hook3sFormula?.visualPattern || ''}`.trim(),
	});
	syncFashionSetupUI();
	if (goToSetup) {
		ctx.switchView('setup');
	}
}

// ---------------------------------------------------------------- AI Voice Over Reasoner & 3s Hook Director
function bindVoiceOverView() {
	$('#voGenerateBtn')?.addEventListener('click', async () => {
		const userInput = ($('#voUserInput')?.value || '').trim();
		if (!userInput) {
			alert('Hãy viết vài câu mô tả sản phẩm / ý tưởng video thời trang của bạn!');
			return;
		}
		const btn = $('#voGenerateBtn');
		btn.disabled = true;
		btn.textContent = '🧠 AGY CLI đang phân tích & suy luận 3 phương án...';
		try {
			const res = await ctx.api('/api/fashion/voiceover', {
				method: 'POST',
				body: {
					userInput,
					targetSec: Number($('#voTargetSec')?.value) || 25,
					dnaProfileId: $('#voDnaSelect')?.value || '',
					brandStyle: ($('#voBrandStyle')?.value || '').trim(),
					model: $('#voModelSelect')?.value || '',
				},
			});
			localState.voResult = res;
			localState.voAudioMap = {};
			saveFashionDraft();
			renderVoiceOverResults();
		} catch (err) {
			alert('Lỗi tạo phương án Voice Over: ' + err.message);
		} finally {
			btn.disabled = false;
			btn.textContent = '🧠 Phân tích & Đề xuất 3 Phương án VO tối ưu';
		}
	});

	$('#hook3sAnalyzeBtn')?.addEventListener('click', async () => {
		const btn = $('#hook3sAnalyzeBtn');
		btn.disabled = true;
		btn.textContent = '⚡ Đang thiết kế Hook 3 giây đầu...';
		try {
			const opts = ctx.getOpts() || {};
			const res = await ctx.api('/api/fashion/hook3s', {
				method: 'POST',
				body: {
					brief: opts.brief || ($('#voUserInput')?.value || '').trim(),
					voiceOverScript: opts.voiceOverScript || '',
					dnaProfileId: $('#voDnaSelect')?.value || opts.dnaProfileId || '',
					model: $('#voModelSelect')?.value || '',
				},
			});
			localState.hook3sResult = res.hook3s;
			saveFashionDraft();
			const box = $('#hook3sStandaloneBox');
			if (box) {
				box.classList.remove('hidden');
				box.innerHTML = renderHook3sCardHtml(res.hook3s, true);
				bindHook3sApplyButtons(box, res.hook3s);
			}
		} catch (err) {
			alert('Lỗi phân tích Hook 3s: ' + err.message);
		} finally {
			btn.disabled = false;
			btn.textContent = '⚡ Phân tích & Thiết kế Hook 3s đầu';
		}
	});
}

function renderVoiceOverResults() {
	const wrap = $('#voResultsWrap');
	if (!wrap || !localState.voResult) return;
	const r = localState.voResult;
	const a = r.analysis || {};
	wrap.classList.remove('hidden');

	wrap.innerHTML = `
		<div class="vo-analysis-card">
			<div class="vo-analysis-head">
				<h3>🧠 Phân tích &amp; Suy luận của AI (${esc(r.modelUsed)})</h3>
				<span class="pill ok">Mục tiêu ${esc(r.targetSec)}s ${r.dnaUsed ? `· DNA ${esc(r.dnaUsed.name)}` : ''}</span>
			</div>
			<div class="vo-analysis-grid">
				<div><b>Thông điệp lõi:</b> ${esc(a.coreMessage)}</div>
				<div><b>Khách hàng mục tiêu:</b> ${esc(a.targetAudience)}</div>
				<div><b>Trọng tâm Thời trang:</b> ${esc(a.fashionFocus)}</div>
				<div><b>Chiến lược nhịp cắt:</b> ${esc(a.pacingStrategy)}</div>
				<div class="full"><b>💡 Insight Hook 3 giây đầu:</b> ${esc(a.hookInsight)}</div>
			</div>
		</div>

		<div class="vo-options-grid">
			${(r.options || [])
				.map(
					(o, idx) => `
				<div class="vo-opt-card" data-vo-idx="${idx}">
					<div class="vo-opt-top">
						<span class="vo-badge">${esc(o.badge)}</span>
						<span class="muted">${esc(o.estimatedSec)}s · ${esc(o.wordCount)} từ · ${esc(o.recommendedStyle)}</span>
					</div>
					<h4>${esc(o.angle)}</h4>
					<p class="vo-reason"><b>Lý do tối ưu:</b> ${esc(o.reasoning)}</p>

					<div class="vo-hook-box">
						<div class="vo-hook-lbl">⚡ HOOK 3 GIÂY ĐẦU (0.0–3.0s)</div>
						<div><b>Câu mở:</b> “${esc(o.hook3s?.line)}” <code>${esc(o.hook3s?.emotionTag)}</code></div>
						<div><b>Hình ảnh 0–3s:</b> ${esc(o.hook3s?.visualHint)}</div>
						<div><b>Chữ overlay:</b> <span class="vo-overlay-chip">${esc(o.hook3s?.overlayText)}</span></div>
					</div>

					<div class="vo-script-box">
						<div class="vo-script-lbl">🎙️ Kịch bản Voice Over hoàn chỉnh <small>(Giọng: ${esc(o.voiceTone)})</small></div>
						<textarea class="vo-script-edit" rows="4" data-script-idx="${idx}">${esc(o.fullScript)}</textarea>
					</div>

					${
						(o.beats || []).length
							? `<details class="vo-beats-det">
						<summary>🎬 Xem bảng phân cảnh &amp; Cut ghép từng giây (${o.beats.length} nhịp)</summary>
						<div class="vo-beats-list">
							${o.beats
								.map(
									(b) => `<div class="vo-beat-row">
								<span class="vo-beat-time">${esc(b.timeRange)}</span>
								<div>
									<div><b>${esc(b.spoken)}</b> <code>${esc(b.emotionTag)}</code></div>
									<small class="muted">🎥 ${esc(b.shotSuggestion)} · ✂️ ${esc(b.cutHint)}</small>
								</div>
							</div>`,
								)
								.join('')}
						</div>
					</details>`
							: ''
					}

					<div class="vo-audio-preview ${localState.voAudioMap?.[idx] ? '' : 'hidden'}" id="voAudioPreview-${idx}">${
						localState.voAudioMap?.[idx]
							? `<div class="vo-audio-bar"><span>🔊 ${esc(localState.voAudioMap[idx].engine)} (${localState.voAudioMap[idx].durationSec}s)</span><audio controls src="${esc(resolveMedia(localState.voAudioMap[idx].audioUrl))}"></audio></div>`
							: ''
					}</div>

					<div class="vo-opt-actions">
						<button type="button" class="primary sm" data-pick-vo="${idx}">✅ Chọn phương án này</button>
						<button type="button" class="ghost sm" data-tts-vo="${idx}">🔊 Tạo Audio Voice Over</button>
					</div>
				</div>`,
				)
				.join('')}
		</div>
	`;

	$$('[data-pick-vo]', wrap).forEach((btn) =>
		btn.addEventListener('click', async () => {
			const idx = Number(btn.dataset.pickVo);
			const o = r.options[idx];
			const editedScript = $(`[data-script-idx="${idx}"]`, wrap)?.value.trim() || o.fullScript;
			const voiceId = $('#voVoiceSelect')?.value || 'vi-female-natural';
			btn.disabled = true;
			btn.textContent = '⏳ Đang tạo giọng đọc & dựng Timeline...';
			let audioUrl = localState.voAudioMap?.[idx]?.audioUrl || ctx.getOpts()?.voiceOverAudioUrl || '';
			if (!localState.voAudioMap?.[idx]?.audioUrl) {
				try {
					const tts = await ctx.api('/api/fashion/voiceover/tts', {
						method: 'POST',
						body: {text: editedScript, voiceId, rateWpm: 195},
					});
					audioUrl = tts.audioUrl;
					localState.voAudioMap[idx] = {engine: tts.engine, audioUrl: tts.audioUrl, durationSec: tts.durationSec};
					saveFashionDraft();
					const prev = $(`#voAudioPreview-${idx}`, wrap);
					if (prev) {
						prev.classList.remove('hidden');
						prev.innerHTML = `<div class="vo-audio-bar"><span>🔊 ${esc(tts.engine)} (${tts.durationSec}s)</span><audio controls src="${esc(resolveMedia(tts.audioUrl))}"></audio></div>`;
					}
				} catch {}
			}
			ctx.applyPatch({
				fashionMode: true,
				title: o.hook3s?.overlayText || '',
				cta: o.cta || '',
				style: o.recommendedStyle || 'editorial',
				pace: o.recommendedPace || 'fast',
				transition: o.recommendedTransition || 'flash',
				maxDuration: Math.min(30, Math.max(20, Number(o.estimatedSec) || 26)),
				hook3sDescription: `Câu mở: ${o.hook3s?.line || ''} | Hình ảnh 0-3s: ${o.hook3s?.visualHint || ''}`,
				voiceOverScript: editedScript,
				...(audioUrl ? {voiceOverAudioUrl: audioUrl} : {}),
				brief: `${($('#voUserInput')?.value || '').trim()}\n\n[VO ${o.angle}]: ${editedScript}`.trim(),
			});
			syncFashionSetupUI();
			btn.disabled = false;
			btn.textContent = '✅ Đã chọn & Đang dựng Timeline!';
			if (ctx.hasClips?.() && ctx.startAutoEdit) {
				ctx.startAutoEdit();
			} else {
				ctx.switchView('setup');
			}
		}),
	);

	$$('[data-tts-vo]', wrap).forEach((btn) =>
		btn.addEventListener('click', async () => {
			const idx = Number(btn.dataset.ttsVo);
			const editedScript = $(`[data-script-idx="${idx}"]`, wrap)?.value.trim() || r.options[idx].fullScript;
			const voiceId = $('#voVoiceSelect')?.value || 'vi-female-natural';
			btn.disabled = true;
			btn.textContent = '⏳ Đang tổng hợp giọng đọc...';
			try {
				const tts = await ctx.api('/api/fashion/voiceover/tts', {
					method: 'POST',
					body: {text: editedScript, voiceId, rateWpm: 195},
				});
				localState.voAudioMap[idx] = {engine: tts.engine, audioUrl: tts.audioUrl, durationSec: tts.durationSec};
				saveFashionDraft();
				const prev = $(`#voAudioPreview-${idx}`, wrap);
				if (prev) {
					prev.classList.remove('hidden');
					prev.innerHTML = `<div class="vo-audio-bar"><span>🔊 ${esc(tts.engine)} (${tts.durationSec}s)</span><audio controls src="${esc(resolveMedia(tts.audioUrl))}"></audio></div>`;
				}
				ctx.applyPatch({voiceOverAudioUrl: tts.audioUrl, voiceOverScript: editedScript});
				syncFashionSetupUI();
				btn.textContent = '✅ Đã gắn Audio vào Video';
			} catch (err) {
				alert('Lỗi tạo audio Voice Over: ' + err.message);
				btn.textContent = '🔊 Tạo Audio Voice Over';
			} finally {
				btn.disabled = false;
			}
		}),
	);
}

function renderHook3sCardHtml(h, interactive) {
	return `
		<div class="hook3s-card">
			<div class="hook3s-head">
				<div>
					<span class="vo-badge">⚡ MÔ TẢ HOOK 3 GIÂY ĐẦU (0.0s – 3.0s)</span>
					<h4>${esc(h.title || h.textOverlay)}</h4>
				</div>
				<div class="hook3s-score">
					<small>Retention Score</small>
					<b>${esc(h.retentionScore || 88)}<span>/100</span></b>
				</div>
			</div>
			<div class="hook3s-grid">
				<div><b>🎥 Hình ảnh 0–3s:</b> ${esc(h.visualAction)}</div>
				<div><b>🗣️ Câu mở đầu:</b> “${esc(h.openingLine)}”</div>
				<div><b>🔤 Chữ trên màn hình:</b> <span class="vo-overlay-chip">${esc(h.textOverlay)}</span></div>
				<div><b>🎬 Máy quay &amp; SFX:</b> ${esc(h.cameraMove)} · ${esc(h.sfxCue)}</div>
				<div class="full"><b>💡 Tại sao hiệu quả:</b> ${esc(h.whyItWorks)}</div>
			</div>
			${
				interactive && (h.alternatives || []).length
					? `<div class="hook3s-alts">
						<b>Biến thể Hook 3s khác:</b>
						${h.alternatives
							.map(
								(a, i) => `<button type="button" class="ghost sm" data-alt-hook="${i}">✨ ${esc(a.label)}: “${esc(a.openingLine)}”</button>`,
							)
							.join('')}
					</div>`
					: ''
			}
			${interactive ? `<div style="margin-top:10px"><button type="button" class="primary sm" data-apply-hook3s>✅ Áp dụng Hook 3s này vào Video</button></div>` : ''}
		</div>
	`;
}

function bindHook3sApplyButtons(box, h) {
	$('[data-apply-hook3s]', box)?.addEventListener('click', () => {
		ctx.applyPatch({
			title: h.textOverlay || h.title || '',
			hook3sDescription: `Hình ảnh 0-3s: ${h.visualAction} | Câu mở: ${h.openingLine} | Camera: ${h.cameraMove}`,
		});
		syncFashionSetupUI();
		ctx.switchView('setup');
	});
	$$('[data-alt-hook]', box).forEach((btn) =>
		btn.addEventListener('click', () => {
			const a = h.alternatives[Number(btn.dataset.altHook)];
			if (!a) return;
			ctx.applyPatch({
				title: a.textOverlay || '',
				hook3sDescription: `Hình ảnh 0-3s: ${a.visualAction} | Câu mở: ${a.openingLine}`,
			});
			syncFashionSetupUI();
			ctx.switchView('setup');
		}),
	);
}
