// Timeline editor: live Remotion preview + video / caption / effect tracks with drag, trim, split,
// delete, undo/redo, and a sentence list to fix every caption's text and timing.
import '../build/player.js';

const AVS = window.AVS;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const fmt = (t) => {
	t = Math.max(0, t || 0);
	const m = Math.floor(t / 60);
	return `${m}:${(t % 60).toFixed(1).padStart(4, '0')}`;
};
const COLORS = ['#3d7bff', '#9b5cff', '#16b88a', '#ff8a3d', '#ff4d8d', '#00b3d6', '#c9a227', '#6f8a00'];
const EMOJIS = ['🔥', '💰', '💡', '🚀', '🤯', '❤️', '😂', '🤔', '⚠️', '✅', '🎯', '⭐', '📈', '👀', '🙌', '😱'];

const E = {
	jobId: null,
	tl: null,
	ctx: null,
	clips: [],
	getOpts: () => ({}),
	onExport: null,
	player: null,
	plan: null,
	lay: [],
	pps: 60,
	sel: null, // {kind: 'seg'|'cap'|'beat'|'title'|'cta', id}
	past: [],
	future: [],
	saveTimer: null,
	compileTimer: null,
	time: 0,
	playing: false,
	drag: null,
	search: '',
	side: 'cap', // right panel: 'cap' | 'color'
	colorScope: 'all', // 'all' | 'seg'
	colorSnap: null,
	compare: false,
	setColor: null,
};

// ------------------------------------------------------------------ public
export async function openEditor(jobId, {getOptions, onExport, setColor}) {
	E.setColor = setColor || null;
	if (E.jobId === jobId && E.tl && E.fresh === false) {
		E.getOpts = getOptions;
		E.onExport = onExport;
		compile(false);
		fitTimelineZoom();
		renderAll();
		return;
	}
	E.fresh = false;
	E.jobId = jobId;
	E.getOpts = getOptions;
	E.onExport = onExport;
	const r = await (window.AVS_API ? window.AVS_API(`/api/jobs/${jobId}/timeline`) : fetch(`/api/jobs/${jobId}/timeline`).then((x) => x.json()));
	if (!r.ok) throw new Error(r.error);
	const base = window.AVS_BASE || '';
	const fixUrl = (u) => (u && u.startsWith('/') && base ? `${base}${u}` : u);
	E.tl = r.timeline;
	E.ctx = {
		...r.ctx,
		clips: (r.ctx.clips || []).map((c) => ({...c, url: fixUrl(c.url)})),
		sfx: Object.fromEntries(Object.entries(r.ctx.sfx || {}).map(([k, v]) => [k, fixUrl(v)])),
		music: (r.ctx.music || []).map((m) => ({...m, url: fixUrl(m.url)})),
	};
	E.clips = r.clips;
	E.past = [];
	E.future = [];
	E.sel = null;
	E.search = '';
	if ($('#capSearch')) $('#capSearch').value = '';
	$('#editorCard').classList.remove('hidden');
	if (!E.bound) bindOnce();
	compile(true);
	fitTimelineZoom();
	renderAll();
	setStatus('Đã tải timeline');
}

export function fitTimelineZoom() {
	if (!E.plan) return;
	const total = E.plan.durationInFrames / E.plan.fps;
	const sc = $('#tlScroll');
	const w = (sc?.clientWidth || 900) - 96;
	if (w > 100) {
		E.pps = Math.max(20, Math.min(200, Math.round(w / Math.max(1, total))));
		if ($('#tlZoom')) $('#tlZoom').value = E.pps;
	}
}

export function refreshEditor() {
	if (E.tl) compile(false);
}

export const editorDirty = () => E.past.length > 0;
export function closeEditor() {
	E.fresh = true;
	E.tl = null;
	E.player?.pause();
}

export function pauseEditor() {
	E.player?.pause();
}

// ------------------------------------------------------------------ compile / preview
function opts() {
	const o = {...E.ctx.opts, ...E.getOpts()};
	if (E.compare) o.color = {...AVS.color.DEFAULT_COLOR, auto: false, filter: ''};
	return o;
}
function compile(immediate) {
	clearTimeout(E.compileTimer);
	const run = () => {
		if (!E.tl) return;
		E.lay = AVS.layoutSegments(E.tl);
		const tl = E.compare ? {...E.tl, segments: E.tl.segments.map(({color, ...seg}) => seg)} : E.tl;
		E.plan = AVS.compile(tl, {...E.ctx, opts: opts()});
		if (!E.player) E.player = AVS.mount($('#edPlayer'), E.plan, onTime);
		else E.player.update(E.plan);
		const ar = E.plan.width / E.plan.height;
		$('#edPlayer').style.aspectRatio = `${ar}`;
	};
	if (immediate) run();
	else E.compileTimer = setTimeout(run, 120);
}

function onTime(t, playing) {
	E.time = t;
	E.playing = playing;
	const ph = $('#tlPlayhead');
	if (ph) ph.style.left = `${90 + t * E.pps}px`;
	$('#tlTime').textContent = `${fmt(t)} / ${fmt(E.plan ? E.plan.durationInFrames / E.plan.fps : 0)}`;
	if (playing) {
		const sc = $('#tlScroll');
		const x = 90 + t * E.pps;
		if (x > sc.scrollLeft + sc.clientWidth - 60 || x < sc.scrollLeft + 90) sc.scrollLeft = x - 120;
	}
	// highlight the caption being spoken
	const cur = captionSpans().find((c) => t >= c.start && t < c.end);
	const id = cur?.cap.id;
	if (id !== E.curCap) {
		E.curCap = id;
		$$('#capList .cap-row').forEach((r) => {
			const isNow = r.dataset.id === id;
			r.classList.toggle('now', isNow);
			if (isNow && playing && !$('#capList').contains(document.activeElement)) {
				r.scrollIntoView({block: 'nearest', behavior: 'smooth'});
			}
		});
	}
}

// ------------------------------------------------------------------ history / save
function commit(mutate, label) {
	E.past.push(JSON.stringify(E.tl));
	if (E.past.length > 150) E.past.shift();
	E.future = [];
	mutate(E.tl);
	afterChange(label);
}
function afterChange(label) {
	compile(false);
	E.lay = AVS.layoutSegments(E.tl);
	renderAll();
	scheduleSave(label);
}
function undo() {
	if (!E.past.length) return;
	E.future.push(JSON.stringify(E.tl));
	E.tl = JSON.parse(E.past.pop());
	afterChange('Hoàn tác');
}
function redo() {
	if (!E.future.length) return;
	E.past.push(JSON.stringify(E.tl));
	E.tl = JSON.parse(E.future.pop());
	afterChange('Làm lại');
}
function scheduleSave(label) {
	setStatus(`${label ? label + ' · ' : ''}đang lưu…`);
	clearTimeout(E.saveTimer);
	E.saveTimer = setTimeout(save, 700);
}
async function save() {
	try {
		const r = await (window.AVS_API
			? window.AVS_API(`/api/jobs/${E.jobId}/timeline`, {method: 'PUT', body: {timeline: E.tl}})
			: fetch(`/api/jobs/${E.jobId}/timeline`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({timeline: E.tl})}).then((x) => x.json()));
		setStatus(r.ok !== false ? 'Đã lưu ✓' : `Lỗi lưu: ${r.error}`);
	} catch (e) {
		setStatus(`Lỗi lưu: ${e.message}`);
	}
	$('#edUndo').disabled = !E.past.length;
	$('#edRedo').disabled = !E.future.length;
}
function setStatus(s) {
	$('#edStatus').textContent = s;
	$('#edUndo').disabled = !E.past.length;
	$('#edRedo').disabled = !E.future.length;
}

// ------------------------------------------------------------------ geometry helpers
const totalDur = () => (E.plan ? E.plan.durationInFrames / E.plan.fps : 0);
const speechEnd = () => (E.lay.length ? E.lay[E.lay.length - 1].end : 0);
const clipIndex = (id) => Math.max(0, E.clips.findIndex((c) => c.id === id));
const clipName = (id) => E.clips.find((c) => c.id === id)?.name || id;
const clipDur = (id) => E.ctx.clips.find((c) => c.id === id)?.duration ?? 1e9;

function captionSpans() {
	if (!E.tl) return [];
	const out = [];
	for (const cap of E.tl.captions) {
		let s = null;
		let e = null;
		for (const w of cap.words) {
			const x = AVS.srcToEdit(E.lay, cap.clip, w.a);
			if (x === null) continue;
			if (s === null || x < s) s = x;
			const xe = x + (w.b - w.a);
			if (e === null || xe > e) e = xe;
		}
		if (s !== null) out.push({cap, start: s, end: Math.max(e, s + 0.1)});
	}
	return out.sort((a, b) => a.start - b.start);
}
function beatSpans() {
	if (!E.tl) return [];
	const out = [];
	if (E.tl.title?.text) out.push({kind: 'title', id: 'title', start: 0, end: E.tl.title.dur || 2.6, label: `🅣 ${E.tl.title.text}`});
	for (const b of E.tl.beats) {
		const s = AVS.srcToEdit(E.lay, b.clip, b.a);
		if (s === null) continue;
		const label = b.type === 'emoji' ? b.emoji : b.type === 'big' ? `# ${b.text}` : `🏷 ${b.text}`;
		out.push({kind: 'beat', id: b.id, start: s, end: s + b.dur, label, beat: b});
	}
	if (E.tl.cta?.text) out.push({kind: 'cta', id: 'cta', start: speechEnd(), end: speechEnd() + (E.tl.cta.dur || 2.6), label: `📣 ${E.tl.cta.text}`});
	return out;
}

/** move a caption so it starts at edit time t (keeps its internal word rhythm) */
function placeCaption(cap, t, dur) {
	const src = AVS.editToSrc(E.lay, Math.max(0, t));
	if (!src) return cap;
	const a0 = cap.words[0]?.a ?? 0;
	const curDur = (cap.words[cap.words.length - 1]?.b ?? a0) - a0;
	const k = dur && curDur > 0 ? dur / curDur : 1;
	return {...cap, clip: src.clip, words: cap.words.map((w) => ({...w, a: src.t + (w.a - a0) * k, b: src.t + (w.b - a0) * k}))};
}

// ------------------------------------------------------------------ rendering
function renderAll() {
	renderTracks();
	renderCaptionList();
	renderInspector();
	renderColorPanel();
}

function renderTracks() {
	const total = Math.max(totalDur(), 1);
	const pps = E.pps;
	const inner = $('#tlInner');
	inner.style.width = `${90 + total * pps + 200}px`;
	// ruler
	const step = pps > 120 ? 0.5 : pps > 50 ? 1 : pps > 20 ? 2 : 5;
	let ticks = '';
	for (let t = 0; t <= total + step; t += step) ticks += `<span style="left:${90 + t * pps}px">${Number.isInteger(t) ? fmt(t).replace(/\.0$/, '') : ''}</span>`;
	$('#tlRuler').innerHTML = ticks;
	// video
	$('#trVideo').innerHTML = E.lay
		.map((l) => {
			const sel = E.sel?.kind === 'seg' && E.sel.id === l.seg.id;
			const c = COLORS[clipIndex(l.seg.clip) % COLORS.length];
			return `<div class="blk vid ${sel ? 'sel' : ''}" data-kind="seg" data-id="${l.seg.id}" style="left:${90 + l.start * pps}px;width:${Math.max(4, (l.end - l.start) * pps - 1)}px;background:${c}">
				<i class="h l"></i><span>${l.seg.color && Object.values(l.seg.color).some((v) => v) ? '🎨 ' : ''}${esc(clipName(l.seg.clip))} · ${(l.end - l.start).toFixed(1)}s</span><i class="h r"></i></div>`;
		})
		.join('');
	if (E.tl.cta?.text) {
		const s = speechEnd();
		$('#trVideo').insertAdjacentHTML('beforeend', `<div class="blk vid freeze" style="left:${90 + s * pps}px;width:${(E.tl.cta.dur || 2.6) * pps}px"><span>khung đứng</span></div>`);
	}
	// captions
	$('#trCap').innerHTML = captionSpans()
		.map(({cap, start, end}) => {
			const sel = E.sel?.kind === 'cap' && E.sel.id === cap.id;
			return `<div class="blk cap ${sel ? 'sel' : ''}" data-kind="cap" data-id="${cap.id}" style="left:${90 + start * pps}px;width:${Math.max(6, (end - start) * pps - 1)}px" title="${esc(AVS.captionText(cap))}">
				<i class="h l"></i><span>${esc(AVS.captionText(cap))}</span><i class="h r"></i></div>`;
		})
		.join('');
	// effects
	$('#trBeat').innerHTML = beatSpans()
		.map((b) => {
			const sel = E.sel?.kind === b.kind && E.sel.id === b.id;
			return `<div class="blk beat ${b.kind} ${sel ? 'sel' : ''}" data-kind="${b.kind}" data-id="${b.id}" style="left:${90 + b.start * pps}px;width:${Math.max(8, (b.end - b.start) * pps - 1)}px">
				<span>${esc(b.label)}</span>${b.kind === 'beat' || b.kind === 'title' ? '<i class="h r"></i>' : ''}</div>`;
		})
		.join('');
	$('#tlPlayhead').style.left = `${90 + E.time * pps}px`;
}

function renderCaptionList() {
	const spans = captionSpans();
	const q = E.search.trim().toLowerCase();
	const filtered = q
		? spans.map((item, idx) => ({...item, idx})).filter(({cap}) => AVS.captionText(cap).toLowerCase().includes(q))
		: spans.map((item, idx) => ({...item, idx}));

	$('#capCount').textContent = q ? `${filtered.length}/${spans.length} câu` : `${spans.length} câu`;
	if ($('#tabEditorSub')) $('#tabEditorSub').textContent = `${spans.length} câu phụ đề · kéo thả timeline`;

	if (!filtered.length) {
		$('#capList').innerHTML = `<div class="cap-empty">${q ? 'Không tìm thấy câu phụ đề nào khớp từ khoá.' : 'Chưa có câu phụ đề nào. Bấm “+ Phụ đề” để thêm.'}</div>`;
		return;
	}

	$('#capList').innerHTML = filtered
		.map(({cap, start, end, idx}) => {
			const isSel = E.sel?.kind === 'cap' && E.sel.id === cap.id;
			const isNow = E.curCap === cap.id;
			const kwRow = isSel
				? `<div class="cap-kw-bar">
						<span>⭐ Từ nổi bật (bấm từ để tô màu nhấn trên video):</span>
						${cap.words.map((w, i) => `<button type="button" class="chip ${w.keyword ? 'on' : ''}" data-kw="${i}">${esc(w.text)}</button>`).join('')}
					</div>`
				: '';
			return `<div class="cap-row ${isSel ? 'sel' : ''} ${isNow ? 'now' : ''}" data-id="${cap.id}">
				<button type="button" class="ghost sm play" title="Nghe thử câu #${idx + 1}">▶</button>
				<span class="cap-idx">${idx + 1}</span>
				<div class="cap-times">
					<input type="text" inputmode="decimal" class="t" data-f="start" value="${start.toFixed(2)}" title="Mốc bắt đầu (giây) — dùng phím ↑/↓ để chỉnh ±0.05s" />
					<span class="arr">→</span>
					<input type="text" inputmode="decimal" class="t" data-f="end" value="${end.toFixed(2)}" title="Mốc kết thúc (giây) — dùng phím ↑/↓ để chỉnh ±0.05s" />
				</div>
				<input type="text" class="txt" data-f="text" value="${esc(AVS.captionText(cap))}" placeholder="Nhập nội dung phụ đề…" />
				<button type="button" class="ghost sm del" title="Xoá câu này">🗑</button>
				${kwRow}
			</div>`;
		})
		.join('');
}

function renderInspector() {
	const box = $('#inspector');
	const s = E.sel;
	box.classList.toggle('compact', !s || s.kind === 'cap');
	if (!s || s.kind === 'cap') {
		box.innerHTML = `<span class="muted">💡 Mẹo: bấm vào câu phụ đề để chọn <b>⭐ Từ nổi bật</b>, hoặc bấm vào khối trên timeline bên dưới để chỉnh chi tiết.</span>
		<div class="head-btns">
			<button type="button" class="ghost sm" data-add="title">🅣 + Tiêu đề mở đầu</button>
			<button type="button" class="ghost sm" data-add="cta">📣 + Lời kêu gọi cuối</button>
		</div>`;
	} else if (s.kind === 'seg') {
		const seg = E.tl.segments.find((x) => x.id === s.id);
		if (!seg) return (E.sel = null), renderInspector();
		box.innerHTML = `<h4>🎬 Đoạn video · ${esc(clipName(seg.clip))}</h4>
		<div class="row">
			<label class="row">Điểm vào (s) <input type="number" step="0.05" data-seg="a" value="${seg.a.toFixed(2)}"></label>
			<label class="row">Điểm ra (s) <input type="number" step="0.05" data-seg="b" value="${seg.b.toFixed(2)}"></label>
		</div>
		<span class="muted">Kéo thân khối trên timeline để đổi thứ tự, kéo 2 mép trái/phải để cắt bớt hoặc nới rộng.</span>`;
	} else if (s.kind === 'beat') {
		const b = E.tl.beats.find((x) => x.id === s.id);
		if (!b) return (E.sel = null), renderInspector();
		box.innerHTML = `<h4>✨ Hiệu ứng trên video</h4>
		<div class="row">
			<label class="row">Loại <select data-beat="type"><option value="big" ${b.type === 'big' ? 'selected' : ''}>Thẻ số lớn</option><option value="emoji" ${b.type === 'emoji' ? 'selected' : ''}>Emoji</option><option value="pill" ${b.type === 'pill' ? 'selected' : ''}>Nhãn chủ đề</option></select></label>
			<label class="row">Thời lượng (s) <input type="number" step="0.1" min="0.3" data-beat="dur" value="${b.dur.toFixed(1)}"></label>
		</div>
		${b.type === 'emoji' ? `<div class=" emojis">${EMOJIS.map((e) => `<button type="button" class="chip ${b.emoji === e ? 'on' : ''}" data-emoji="${e}">${e}</button>`).join('')}</div>` : `<label class="col">Nội dung chữ <input type="text" data-beat="text" value="${esc(b.text || '')}"></label>`}
		${b.type === 'big' ? `<label class="col">Chú thích nhỏ bên dưới <input type="text" data-beat="sub" value="${esc(b.sub || '')}"></label>` : ''}`;
	} else if (s.kind === 'title' || s.kind === 'cta') {
		const o = E.tl[s.kind];
		if (!o) return (E.sel = null), renderInspector();
		box.innerHTML = `<h4>${s.kind === 'title' ? '🅣 Tiêu đề mở đầu (Hook)' : '📣 Lời kêu gọi cuối video (CTA)'}</h4>
		<div class="row">
			<label class="col" style="flex:1">Nội dung <input type="text" data-tc="text" value="${esc(o.text)}"></label>
			<label class="col" style="width:130px">Thời lượng (s) <input type="number" step="0.1" min="0.5" data-tc="dur" value="${(o.dur || 2.6).toFixed(1)}"></label>
		</div>`;
	}
	$('#edDelete').disabled = !E.sel;
}

// ------------------------------------------------------------------ actions
function select(kind, id, seekTo, rerenderList = true) {
	const changed = E.sel?.kind !== kind || E.sel?.id !== id;
	E.sel = kind ? {kind, id} : null;
	renderTracks();
	renderInspector();
	if (changed && rerenderList) renderCaptionList();
	else $$('#capList .cap-row').forEach((r) => r.classList.toggle('sel', kind === 'cap' && r.dataset.id === id));
	if (seekTo !== undefined) E.player?.seek(seekTo + 0.01);
	if (changed && E.side === 'color') {
		if (kind === 'seg') E.colorScope = 'seg';
		renderColorPanel();
	}
}

function cleanAllQuotes() {
	if (!E.tl?.captions?.length) return;
	let count = 0;
	const strip = (s) => s.replace(/^["“”'‘’«»]+|["“”'‘’«»]+$/g, '').trim();
	for (const cap of E.tl.captions) {
		for (const w of cap.words) {
			const cleaned = strip(w.text);
			if (cleaned && cleaned !== w.text) count++;
		}
	}
	if (!count) {
		setStatus('Phụ đề đã sạch dấu ngoặc kép ✓');
		return;
	}
	commit((tl) => {
		for (const cap of tl.captions) {
			for (const w of cap.words) {
				const cleaned = strip(w.text);
				if (cleaned) w.text = cleaned;
			}
		}
	}, `Đã dọn ${count} dấu ""`);
}

function deleteSelected() {
	const s = E.sel;
	if (!s) return;
	commit((tl) => {
		if (s.kind === 'seg') {
			if (tl.segments.length <= 1) return alert('Cần giữ ít nhất 1 đoạn video');
			tl.segments = tl.segments.filter((x) => x.id !== s.id);
		} else if (s.kind === 'cap') tl.captions = tl.captions.filter((x) => x.id !== s.id);
		else if (s.kind === 'beat') tl.beats = tl.beats.filter((x) => x.id !== s.id);
		else if (s.kind === 'title') tl.title = null;
		else if (s.kind === 'cta') tl.cta = null;
	}, 'Đã xoá');
	E.sel = null;
	renderAll();
}

function splitAtPlayhead() {
	const t = E.time;
	if (E.sel?.kind === 'cap') {
		const span = captionSpans().find((c) => c.cap.id === E.sel.id);
		if (span && t > span.start && t < span.end) {
			const cap = span.cap;
			const cut = AVS.editToSrc(E.lay, t);
			const first = cap.words.filter((w) => w.a < cut.t);
			const second = cap.words.filter((w) => w.a >= cut.t);
			if (first.length && second.length)
				return commit((tl) => {
					const i = tl.captions.findIndex((x) => x.id === cap.id);
					tl.captions.splice(i, 1, {...cap, words: first}, {id: AVS.tlId(), clip: cap.clip, words: second});
				}, 'Tách phụ đề');
		}
	}
	const src = AVS.editToSrc(E.lay, t);
	if (!src) return;
	const seg = src.seg.seg;
	if (src.t - seg.a < 0.1 || seg.b - src.t < 0.1) return;
	commit((tl) => {
		const i = tl.segments.findIndex((x) => x.id === seg.id);
		tl.segments.splice(i, 1, {...seg, b: src.t}, {...seg, id: AVS.tlId(), a: src.t});
	}, 'Tách đoạn');
}

function addCaption() {
	const src = AVS.editToSrc(E.lay, E.time);
	if (!src) return;
	const id = AVS.tlId();
	commit((tl) => {
		const cap = AVS.retimeCaption({id, clip: src.clip, words: [{text: 'x', a: 0, b: 0}]}, 'Phụ đề mới', src.t, Math.min(src.t + 1.5, clipDur(src.clip)));
		tl.captions.push(cap);
	}, 'Thêm phụ đề');
	select('cap', id);
	setTimeout(() => {
		const inp = $(`#capList .cap-row[data-id="${id}"] .txt`);
		inp?.scrollIntoView({block: 'center'});
		inp?.focus();
		inp?.select();
	}, 50);
}

function addBeat(type) {
	if (type === 'title' || type === 'cta') {
		commit((tl) => (tl[type] = {text: type === 'title' ? 'Tiêu đề của bạn' : 'Follow để xem thêm 👉', dur: 2.6}), 'Thêm');
		return select(type, type);
	}
	const src = AVS.editToSrc(E.lay, E.time);
	if (!src) return;
	const id = AVS.tlId();
	commit((tl) => tl.beats.push({id, type, clip: src.clip, a: src.t, dur: type === 'emoji' ? 1.6 : 2.2, text: type === 'big' ? '100%' : type === 'pill' ? 'Chủ đề' : undefined, emoji: type === 'emoji' ? '🔥' : undefined}), 'Thêm hiệu ứng');
	select('beat', id);
}

// ------------------------------------------------------------------ drag on the timeline
function onPointerDown(e) {
	const blk = e.target.closest('.blk');
	const area = e.target.closest('#tlInner');
	if (!area) return;
	const rect = $('#tlInner').getBoundingClientRect();
	const tAt = (clientX) => (clientX - rect.left - 90) / E.pps;
	if (!blk || !blk.dataset.kind) {
		const t = Math.max(0, tAt(e.clientX));
		E.player?.seek(t);
		select(null);
		E.drag = {kind: 'seek', tAt};
		$('#tlInner').setPointerCapture(e.pointerId);
		return;
	}
	const kind = blk.dataset.kind;
	const id = blk.dataset.id;
	const edge = e.target.classList.contains('h') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
	select(kind, id);
	if (kind === 'cap') {
		const row = $(`#capList .cap-row[data-id="${id}"]`);
		row?.scrollIntoView({block: 'nearest', behavior: 'smooth'});
	}
	E.drag = {kind, id, edge, x0: e.clientX, snap: JSON.stringify(E.tl), moved: false, tAt, blk};
	$('#tlInner').setPointerCapture(e.pointerId);
	e.preventDefault();
}

function onPointerMove(e) {
	const d = E.drag;
	if (!d) return;
	if (d.kind === 'seek') return E.player?.seek(Math.max(0, d.tAt(e.clientX)));
	const dx = (e.clientX - d.x0) / E.pps;
	if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
	if (!d.moved) return;
	const tl = JSON.parse(d.snap);
	const lay0 = AVS.layoutSegments(tl);
	if (d.kind === 'seg') {
		const i = tl.segments.findIndex((x) => x.id === d.id);
		const seg = tl.segments[i];
		if (d.edge === 'l') seg.a = Math.max(0, Math.min(seg.b - 0.1, seg.a + dx));
		else if (d.edge === 'r') seg.b = Math.min(clipDur(seg.clip), Math.max(seg.a + 0.1, seg.b + dx));
		else {
			const t = d.tAt(e.clientX);
			let to = lay0.findIndex((l) => t < (l.start + l.end) / 2);
			if (to < 0) to = lay0.length;
			const [m] = tl.segments.splice(i, 1);
			tl.segments.splice(to > i ? to - 1 : to, 0, m);
		}
	} else if (d.kind === 'cap') {
		E.lay = lay0;
		const span = spansOf(tl).find((c) => c.cap.id === d.id);
		if (span) {
			const i = tl.captions.findIndex((x) => x.id === d.id);
			if (!d.edge) tl.captions[i] = placeCaptionIn(tl, lay0, span.cap, span.start + dx);
			else {
				const start = d.edge === 'l' ? Math.min(span.end - 0.15, span.start + dx) : span.start;
				const end = d.edge === 'r' ? Math.max(span.start + 0.15, span.end + dx) : span.end;
				const a = AVS.editToSrc(lay0, start);
				if (a) {
					const segEnd = a.seg.b;
					tl.captions[i] = AVS.retimeCaption({...span.cap, clip: a.clip}, AVS.captionText(span.cap), a.t, Math.min(segEnd, a.t + (end - start)));
				}
			}
		}
	} else if (d.kind === 'beat') {
		const b = tl.beats.find((x) => x.id === d.id);
		const s = AVS.srcToEdit(lay0, b.clip, b.a);
		if (d.edge === 'r') b.dur = Math.max(0.3, b.dur + dx);
		else if (s !== null) {
			const src = AVS.editToSrc(lay0, Math.max(0, s + dx));
			if (src) {
				b.clip = src.clip;
				b.a = src.t;
			}
		}
	} else if (d.kind === 'title' && d.edge === 'r') {
		tl.title.dur = Math.max(0.5, (tl.title.dur || 2.6) + dx);
	}
	E.tl = tl;
	E.lay = AVS.layoutSegments(tl);
	renderTracks();
}

function onPointerUp() {
	const d = E.drag;
	E.drag = null;
	if (!d || d.kind === 'seek') return;
	if (!d.moved) {
		const span = d.kind === 'cap' ? captionSpans().find((c) => c.cap.id === d.id) : null;
		const seg = d.kind === 'seg' ? E.lay.find((l) => l.seg.id === d.id) : null;
		const t = span?.start ?? seg?.start;
		if (t !== undefined) E.player?.seek(t + 0.01);
		return;
	}
	E.past.push(d.snap);
	E.future = [];
	afterChange(d.kind === 'seg' ? (d.edge ? 'Cắt đoạn' : 'Đổi thứ tự') : 'Di chuyển');
}

const spansOf = (tl) => {
	const keep = E.tl;
	E.tl = tl;
	const s = captionSpans();
	E.tl = keep;
	return s;
};
const placeCaptionIn = (tl, lay, cap, t) => {
	const keepLay = E.lay;
	E.lay = lay;
	const out = placeCaption(cap, t);
	E.lay = keepLay;
	return out;
};

// ------------------------------------------------------------------ bindings
function bindOnce() {
	E.bound = true;
	const inner = $('#tlInner');
	inner.addEventListener('pointerdown', onPointerDown);
	inner.addEventListener('pointermove', onPointerMove);
	inner.addEventListener('pointerup', onPointerUp);
	inner.addEventListener('pointercancel', onPointerUp);
	inner.addEventListener('dblclick', (e) => {
		const blk = e.target.closest('.blk.cap');
		if (!blk) return;
		const inp = $(`#capList .cap-row[data-id="${blk.dataset.id}"] .txt`);
		inp?.scrollIntoView({block: 'center'});
		inp?.focus();
	});
	$('#tlZoom').addEventListener('input', (e) => {
		E.pps = Number(e.target.value);
		renderTracks();
	});
	$('#edUndo').addEventListener('click', undo);
	$('#edRedo').addEventListener('click', redo);
	$('#edSplit').addEventListener('click', splitAtPlayhead);
	$('#edDelete').addEventListener('click', deleteSelected);
	$('#edAddCap').addEventListener('click', addCaption);
	$('#edAddBeat').addEventListener('change', (e) => {
		if (e.target.value) addBeat(e.target.value);
		e.target.value = '';
	});
	$('#edExport').addEventListener('click', async () => {
		clearTimeout(E.saveTimer);
		await save();
		E.player?.pause();
		E.onExport?.(E.tl);
	});
	$('#capSearch')?.addEventListener('input', (e) => {
		E.search = e.target.value;
		renderCaptionList();
	});
	$('#capCleanQuotes')?.addEventListener('click', cleanAllQuotes);
	bindColorPanel();
	$$('#sideTabs .side-tab').forEach((b) =>
		b.addEventListener('click', () => {
			E.side = b.dataset.side;
			$$('#sideTabs .side-tab').forEach((x) => x.classList.toggle('on', x === b));
			$('#capPanel').classList.toggle('hidden', E.side !== 'cap');
			$('#colorPanel').classList.toggle('hidden', E.side !== 'color');
			$('#inspector').classList.toggle('hidden', E.side === 'color');
			if (E.side === 'color') E.colorScope = E.sel?.kind === 'seg' ? 'seg' : 'all';
			renderColorPanel();
		}),
	);

	// sentence list
	const list = $('#capList');
	list.addEventListener('click', (e) => {
		const row = e.target.closest('.cap-row');
		if (!row) return;
		const id = row.dataset.id;
		const span = captionSpans().find((c) => c.cap.id === id);
		if (e.target.closest('.del')) {
			select('cap', id);
			return deleteSelected();
		}
		if (e.target.closest('.play') && span) {
			select('cap', id, undefined, false);
			E.player.seek(span.start);
			E.player.play();
			clearTimeout(E.stopTimer);
			E.stopTimer = setTimeout(() => E.player.pause(), (span.end - span.start) * 1000 + 150);
			return;
		}
		const kw = e.target.dataset.kw;
		if (kw !== undefined) {
			commit((tl) => {
				const cap = tl.captions.find((x) => x.id === id);
				if (cap) cap.words.forEach((w, i) => (w.keyword = i === Number(kw) ? !w.keyword || undefined : undefined));
			}, 'Từ nổi bật');
			return;
		}
		if (e.target.tagName !== 'INPUT') select('cap', id, span?.start);
		else if (E.sel?.id !== id) select('cap', id, undefined, false);
	});
	list.addEventListener('change', (e) => {
		const row = e.target.closest('.cap-row');
		if (!row) return;
		const id = row.dataset.id;
		const f = e.target.dataset.f;
		const span = captionSpans().find((c) => c.cap.id === id);
		if (!span) return;
		commit((tl) => {
			const i = tl.captions.findIndex((x) => x.id === id);
			const cap = tl.captions[i];
			if (f === 'text') {
				const text = e.target.value.trim();
				if (!text) tl.captions.splice(i, 1);
				else tl.captions[i] = AVS.retimeCaption(cap, text);
			} else {
				let start = span.start;
				let end = span.end;
				const v = parseFloat(e.target.value.replace(',', '.'));
				if (!Number.isFinite(v)) return;
				if (f === 'start') start = Math.max(0, v);
				else end = Math.max(0, v);
				if (end <= start + 0.1) end = start + 0.5;
				const a = AVS.editToSrc(E.lay, start);
				if (a) tl.captions[i] = AVS.retimeCaption({...cap, clip: a.clip}, AVS.captionText(cap), a.t, Math.min(a.seg.b, a.t + (end - start)));
			}
		}, f === 'text' ? 'Sửa chữ' : 'Sửa thời gian');
	});
	list.addEventListener('keydown', (e) => {
		const f = e.target.dataset?.f;
		if ((f === 'start' || f === 'end') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
			e.preventDefault();
			const step = (e.shiftKey ? 0.25 : 0.05) * (e.key === 'ArrowUp' ? 1 : -1);
			const cur = parseFloat(e.target.value.replace(',', '.')) || 0;
			e.target.value = Math.max(0, cur + step).toFixed(2);
			e.target.dispatchEvent(new Event('change', {bubbles: true}));
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			const nextRow = e.target.closest('.cap-row')?.nextElementSibling;
			e.target.blur();
			const next = nextRow?.querySelector(`[data-f="${f}"]`);
			if (next) {
				next.focus();
				next.select?.();
			}
		}
	});

	// inspector
	const ins = $('#inspector');
	ins.addEventListener('click', (e) => {
		const add = e.target.dataset.add;
		if (add) return addBeat(add);
		const emo = e.target.dataset.emoji;
		if (emo && E.sel?.kind === 'beat') commit((tl) => (tl.beats.find((x) => x.id === E.sel.id).emoji = emo), 'Đổi emoji');
	});
	ins.addEventListener('change', (e) => {
		const t = e.target;
		if (t.dataset.seg && E.sel?.kind === 'seg')
			return commit((tl) => {
				const seg = tl.segments.find((x) => x.id === E.sel.id);
				const v = Number(t.value);
				if (t.dataset.seg === 'a') seg.a = Math.max(0, Math.min(seg.b - 0.1, v));
				else seg.b = Math.min(clipDur(seg.clip), Math.max(seg.a + 0.1, v));
			}, 'Cắt đoạn');
		if (t.dataset.beat && E.sel?.kind === 'beat')
			return commit((tl) => {
				const b = tl.beats.find((x) => x.id === E.sel.id);
				const k = t.dataset.beat;
				if (k === 'dur') b.dur = Math.max(0.3, Number(t.value) || 1);
				else if (k === 'type') {
					b.type = t.value;
					if (b.type === 'emoji' && !b.emoji) b.emoji = '🔥';
					if (b.type !== 'emoji' && !b.text) b.text = b.type === 'big' ? '100%' : 'Chủ đề';
					b.count = undefined;
				} else {
					b[k] = t.value;
					if (k === 'text') b.count = undefined;
				}
			}, 'Sửa hiệu ứng');
		if (t.dataset.tc && (E.sel?.kind === 'title' || E.sel?.kind === 'cta'))
			return commit((tl) => {
				const o = tl[E.sel.kind];
				if (t.dataset.tc === 'dur') o.dur = Math.max(0.5, Number(t.value) || 2.6);
				else o.text = t.value;
			}, 'Sửa');
	});

	// keyboard
	document.addEventListener('keydown', (e) => {
		if ($('#viewEditor')?.classList.contains('hidden')) return;
		const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
		const mod = e.metaKey || e.ctrlKey;
		if (mod && e.key.toLowerCase() === 'z' && !typing) {
			e.preventDefault();
			return e.shiftKey ? redo() : undo();
		}
		if (mod && e.key.toLowerCase() === 'y' && !typing) {
			e.preventDefault();
			return redo();
		}
		if (typing) return;
		if (e.key === ' ') {
			e.preventDefault();
			E.player?.toggle();
		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();
			deleteSelected();
		} else if (e.key.toLowerCase() === 's' && !mod) {
			e.preventDefault();
			splitAtPlayhead();
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault();
			E.player?.seek(E.time + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30));
		}
	});
}


// ------------------------------------------------------------------ color (CapCut-style "Điều chỉnh" + bộ lọc)
const COLOR_GROUPS = [
	{name: '☀️ Ánh sáng', keys: [['exposure', 'Phơi sáng'], ['brightness', 'Độ sáng'], ['contrast', 'Tương phản'], ['highlights', 'Vùng sáng'], ['shadows', 'Vùng tối'], ['fade', 'Làm mờ', 0]]},
	{name: '🎨 Màu', keys: [['saturation', 'Bão hoà'], ['temperature', 'Nhiệt độ'], ['tint', 'Sắc thái'], ['hue', 'Tông màu']]},
	{name: '🎞 Hiệu ứng', keys: [['vignette', 'Viền tối', 0], ['grain', 'Hạt phim', 0]], globalOnly: true},
];
const SWATCH_BG = 'linear-gradient(135deg,#f3c7a2 0%,#d98a5c 28%,#7fb3e0 58%,#4f8f3f 100%)';
/** rough CSS look of a filter preset for its swatch */
const swatchCss = (a) => {
	const f = [];
	f.push(`brightness(${(1 + (a.exposure || 0) / 160 + (a.brightness || 0) / 250).toFixed(3)})`);
	f.push(`contrast(${(1 + (a.contrast || 0) / 160 - (a.fade || 0) / 300).toFixed(3)})`);
	f.push(`saturate(${Math.max(0, 1 + (a.saturation || 0) / 100).toFixed(3)})`);
	if (a.temperature > 0) f.push(`sepia(${(a.temperature / 220).toFixed(3)})`);
	if (a.temperature < 0 || a.hue) f.push(`hue-rotate(${((a.hue || 0) * 0.6 + (a.temperature < 0 ? -a.temperature * 0.35 : 0)).toFixed(1)}deg)`);
	return f.join(' ');
};

const globalColor = () => ({...AVS.color.DEFAULT_COLOR, ...(E.getOpts().color || {})});
const selSeg = () => (E.sel?.kind === 'seg' ? E.tl?.segments.find((x) => x.id === E.sel.id) : null);

function setGlobalColor(patch) {
	const next = {...globalColor(), ...patch};
	if (E.setColor) E.setColor(next);
	else compile(false);
}

function renderColorPanel() {
	const box = $('#colorPanel');
	if (!box || !E.tl || E.side !== 'color') return;
	const g = globalColor();
	const seg = selSeg();
	const scope = E.colorScope === 'seg' && seg ? 'seg' : 'all';
	const vals = scope === 'seg' ? {...AVS.color.ZERO_ADJUST, ...(seg.color || {})} : g;
	const measured = E.ctx.clips.filter((c) => c.color).length;
	const filterAdj = AVS.color.COLOR_FILTERS.find((f) => f.id === g.filter);
	const slider = ([k, label, min = -100], globalOnly) => {
		if (scope === 'seg' && globalOnly) return '';
		const v = Math.round(vals[k] || 0);
		return `<label class="cc-row ${v ? 'changed' : ''}" title="Bấm đúp để về 0">
			<span class="cc-lbl">${label}</span>
			<input type="range" class="cc-range cc-${k}" data-ck="${k}" min="${min}" max="100" step="1" value="${v}">
			<span class="cc-val" data-cv="${k}">${v > 0 ? '+' : ''}${v}</span>
		</label>`;
	};
	box.innerHTML = `
		<div class="cc-head">
			<div class="seg cc-scope">
				<button type="button" data-scope="all" class="${scope === 'all' ? 'on' : ''}">🌐 Toàn bộ video</button>
				<button type="button" data-scope="seg" class="${scope === 'seg' ? 'on' : ''}" ${seg ? '' : 'title="Bấm chọn 1 đoạn trên track 🎬 Video bên dưới"'}>🎬 Đoạn đang chọn</button>
			</div>
			<div class="head-btns">
				<button type="button" class="ghost sm" id="ccCompare" title="Giữ chuột để xem bản gốc chưa chỉnh màu">👁 Giữ để so sánh</button>
				<button type="button" class="ghost sm" id="ccReset">↺ Đặt lại</button>
			</div>
		</div>
		${
			scope === 'seg'
				? `<div class="cc-note">Đang chỉnh riêng đoạn <b>${esc(clipName(seg.clip))}</b> (${seg.a.toFixed(1)}–${seg.b.toFixed(1)}s). Giá trị ở đây <b>cộng thêm</b> vào màu chung của cả video. Có thể hoàn tác bằng ⌘Z.</div>`
				: E.colorScope === 'seg'
					? `<div class="cc-note">Bấm chọn 1 đoạn trên track 🎬 Video ở timeline bên dưới để chỉnh màu riêng cho đoạn đó.</div>`
					: ''
		}
		${
			scope === 'all'
				? `<div class="cc-card">
			<div class="cc-auto">
				<label class="switch"><input type="checkbox" id="ccAuto" ${g.auto ? 'checked' : ''}><i></i></label>
				<div class="cc-auto-txt"><b>✨ Tự động chỉnh màu</b><small>${
					measured ? `Đã đo màu ${measured}/${E.ctx.clips.length} clip: cân bằng trắng, phơi sáng, độ tương phản, độ bão hoà cho đồng đều giữa các cảnh.` : 'Đang chờ đo màu clip (sẽ tự đo khi dựng / xuất video).'
				}</small></div>
			</div>
			<label class="cc-row ${g.auto ? '' : 'disabled'}"><span class="cc-lbl">Mức độ</span><input type="range" class="cc-range" id="ccAutoStrength" min="0" max="100" step="1" value="${g.autoStrength}" ${g.auto ? '' : 'disabled'}><span class="cc-val">${g.autoStrength}%</span></label>
		</div>
		<div class="cc-card">
			<div class="cc-title">🎞 Bộ lọc màu</div>
			<div class="cc-filters">
				<button type="button" class="cc-filter ${!g.filter ? 'on' : ''}" data-filter=""><i style="background:${SWATCH_BG}"></i><span>Không</span></button>
				${AVS.color.COLOR_FILTERS.map((f) => `<button type="button" class="cc-filter ${g.filter === f.id ? 'on' : ''}" data-filter="${f.id}"><i style="background:${SWATCH_BG};filter:${swatchCss(f.adj)}"></i><span>${esc(f.name)}</span></button>`).join('')}
			</div>
			${filterAdj ? `<label class="cc-row"><span class="cc-lbl">Cường độ</span><input type="range" class="cc-range" id="ccFilterAmount" min="0" max="100" step="1" value="${g.filterAmount}"><span class="cc-val">${g.filterAmount}%</span></label>` : ''}
		</div>`
				: ''
		}
		${
			scope === 'seg' || E.colorScope !== 'seg'
				? COLOR_GROUPS.map((gr) => {
						const rows = gr.keys.map((k) => slider(k, gr.globalOnly)).join('');
						return rows ? `<div class="cc-card"><div class="cc-title">${gr.name}</div>${rows}</div>` : '';
					}).join('')
				: ''
		}`;
}

function setRangeLabel(input) {
	const k = input.dataset.ck;
	const v = Number(input.value);
	const out = input.parentElement.querySelector('.cc-val');
	if (out) out.textContent = k ? `${v > 0 ? '+' : ''}${v}` : `${v}%`;
	input.closest('.cc-row')?.classList.toggle('changed', !!k && v !== 0);
}

function applyColorValue(k, v, final) {
	const seg = E.colorScope === 'seg' ? selSeg() : null;
	if (seg) {
		if (!E.colorSnap) E.colorSnap = JSON.stringify(E.tl);
		const color = {...(seg.color || {}), [k]: v};
		if (!v) delete color[k];
		seg.color = Object.keys(color).length ? color : undefined;
		compile(false);
		if (final) {
			E.past.push(E.colorSnap);
			if (E.past.length > 150) E.past.shift();
			E.future = [];
			E.colorSnap = null;
			renderTracks();
			scheduleSave('Chỉnh màu đoạn');
		}
	} else {
		setGlobalColor({[k]: v});
	}
}

function bindColorPanel() {
	const box = $('#colorPanel');
	if (!box) return;
	box.addEventListener('input', (e) => {
		const t = e.target;
		if (t.dataset.ck) {
			setRangeLabel(t);
			applyColorValue(t.dataset.ck, Number(t.value), false);
		} else if (t.id === 'ccAutoStrength') {
			setRangeLabel(t);
			setGlobalColor({autoStrength: Number(t.value)});
		} else if (t.id === 'ccFilterAmount') {
			setRangeLabel(t);
			setGlobalColor({filterAmount: Number(t.value)});
		}
	});
	box.addEventListener('change', (e) => {
		const t = e.target;
		if (t.dataset.ck) applyColorValue(t.dataset.ck, Number(t.value), true);
		else if (t.id === 'ccAuto') {
			setGlobalColor({auto: t.checked});
			renderColorPanel();
		}
	});
	box.addEventListener('dblclick', (e) => {
		const t = e.target.closest('.cc-row')?.querySelector('input[data-ck]');
		if (!t) return;
		t.value = 0;
		setRangeLabel(t);
		applyColorValue(t.dataset.ck, 0, true);
	});
	box.addEventListener('click', (e) => {
		const sc = e.target.closest('[data-scope]');
		if (sc) {
			E.colorScope = sc.dataset.scope;
			return renderColorPanel();
		}
		const f = e.target.closest('[data-filter]');
		if (f) {
			setGlobalColor({filter: f.dataset.filter});
			return renderColorPanel();
		}
		if (e.target.id === 'ccReset') {
			const seg = E.colorScope === 'seg' ? selSeg() : null;
			if (seg) {
				if (seg.color) commit((tl) => (tl.segments.find((x) => x.id === seg.id).color = undefined), 'Đặt lại màu đoạn');
			} else {
				setGlobalColor({...AVS.color.DEFAULT_COLOR});
			}
			renderColorPanel();
		}
	});
	const setCompare = (on) => {
		if (E.compare === on) return;
		E.compare = on;
		compile(true);
		$('#ccCompare')?.classList.toggle('on', on);
	};
	box.addEventListener('pointerdown', (e) => {
		if (e.target.id === 'ccCompare') setCompare(true);
	});
	window.addEventListener('pointerup', () => setCompare(false));
	box.addEventListener('pointerleave', () => setCompare(false));
}
