// Script Studio — Complete Database Engine (IndexedDB + SQLite sync via window.STS_DB)
(() => {
	const APP = 'script-studio';
	const nowStr = () => new Date().toLocaleString('vi-VN', {hour12: false});

	const ALL_ROLES = ['director', 'writer', 'art_director', 'pm', 'ac_manager', 'ac', 'concept', 'community', 'boss', 'post'];
	const FULL_CAPS = {
		members_manage: true,
		stage_approve: true,
		script_write: true,
		script_note: true,
		script_apply_notes: true,
		breakdown_generate: true,
		breakdown_edit: true,
		breakdown_qc: true,
		breakdown_boss: true,
		voice_edit: true,
		assets_edit: true,
		assets_upload: true,
		assets_ad_approve: true,
		assets_director_approve: true,
	};

	const DEFAULT_ADMIN = {
		id: 1,
		username: 'sts',
		password: '1111',
		display_name: 'Admin (sts)',
		lark_email: 'sts@studio.local',
		is_admin: true,
		active: true,
		approval_status: 'approved',
		positions: ALL_ROLES,
		default_can_view: true,
		default_can_edit: true,
		default_can_delete: true,
	};

	let stateCache = null;
	let initPromise = null;

	async function loadState() {
		if (stateCache) return stateCache;
		if (initPromise) return initPromise;
		initPromise = (async () => {
			const db = window.STS_DB;
			let root = await db.get(APP, 'store', 'main');
			if (!root || !Array.isArray(root.users)) {
				root = {
					nextId: 100,
					users: [DEFAULT_ADMIN],
					aiProviders: [
						{
							id: 1,
							name: 'Bộ sinh nội bộ (Offline AI)',
							type: 'offline',
							base_url: '',
							api_key: '',
							models: ['heuristic'],
						},
					],
					lark: {app_id: '', app_secret: '', domain: 'https://open.larksuite.com', default_positions: ['writer']},
					projects: [
						{
							id: 1,
							name: 'Dự án Phim Mẫu — Tập 01',
							start_date: new Date().toISOString().slice(0, 10),
							description: 'Dự án mẫu được lưu tự động trong Database (IndexedDB + SQLite).',
							owner_id: 1,
							owner_name: 'Admin (sts)',
							created_at: nowStr(),
							stages: {
								script: {status: 'draft', at: nowStr(), comment: ''},
								breakdown: {status: 'draft', at: nowStr(), comment: ''},
								voice: {status: 'draft', at: nowStr(), comment: ''},
								assets: {status: 'draft', at: nowStr(), comment: ''},
							},
							members: [
								{
									user_id: 1,
									username: 'sts',
									display_name: 'Admin (sts)',
									roles: ALL_ROLES,
									can_view: true,
									can_edit: true,
									can_delete: true,
								},
							],
							approvals: [],
							script: {
								rev: 1,
								font: 'Courier New',
								font_size: 14,
								updated_at: nowStr(),
								updated_by_name: 'Admin (sts)',
								blocks: [
									{id: 'b1', type: 'scene', text: 'INT. PHÒNG STUDIO - NGÀY'},
									{id: 'b2', type: 'action', text: 'Ánh sáng chiếu qua khung cửa sổ. Đạo diễn và Biên kịch đang thảo luận kịch bản mới.'},
									{id: 'b3', type: 'character', text: 'MINH'},
									{id: 'b4', type: 'parenthetical', text: '(hào hứng)'},
									{id: 'b5', type: 'dialogue', text: 'Kịch bản tập này đã được lưu thẳng vào cơ sở dữ liệu, sẵn sàng tạo phân tách cảnh và voice-off!'},
								],
								versions: [],
							},
							notes: [],
							sheetConfig: {},
							breakdown: {
								settings: {episodes: 1, minutes: 1.5, provider_id: 1, model: 'heuristic', style: 'Anime 2D', intent: '', auto_on_approve: false},
								job: null,
								episodes: [
									{
										id: 10,
										number: 1,
										title: 'Tập 1: Khởi đầu',
										summary: 'Giới thiệu bối cảnh và nhân vật chính',
										minutes: 1.5,
										shots: [
											{
												id: 101,
												storyboard: 'S1',
												location: 'INT. PHÒNG STUDIO - NGÀY',
												visual: 'Toàn cảnh phòng studio hiện đại, ánh nắng sớm chiếu vào bàn làm việc.',
												speaker: 'MINH',
												dialogue: 'Kịch bản tập này đã được lưu thẳng vào cơ sở dữ liệu, sẵn sàng tạo phân tách cảnh và voice-off!',
												emotion: '[excited] hào hứng, nhịp nhanh',
												props: 'Laptop, tập kịch bản',
												director_comment: 'Mở đầu giàu năng lượng',
												camera: 'Wide Shot → Push-in nhẹ',
												director_note: 'Ánh sáng ấm',
												timing: '6',
												qc: 'Đạt',
												boss: '',
											},
										],
									},
								],
								versions: [],
							},
							voice: {
								lines: [
									{
										id: 201,
										episode: '1',
										shot: 'S1',
										scene: 'INT. PHÒNG STUDIO - NGÀY',
										character: 'MINH',
										line: 'Kịch bản tập này đã được lưu thẳng vào cơ sở dữ liệu, sẵn sàng tạo phân tách cảnh và voice-off!',
										emotion: 'hào hứng',
										tagged: '[excited] Kịch bản tập này đã được lưu thẳng vào cơ sở dữ liệu, sẵn sàng tạo phân tách cảnh và voice-off!',
										note: '',
									},
								],
							},
							assets: [
								{
									id: 301,
									category: 'character',
									idx: 0,
									ad_approved: true,
									director_approved: true,
									data: {
										name: 'MINH',
										version: 'Trang phục đạo diễn trẻ',
										episodes: 'Tập 1',
										description: 'Nam, 25 tuổi, năng động, đeo kính gọng mảnh.',
										status: 'Xong',
										owner: 'Admin (sts)',
										deadline: new Date().toISOString().slice(0, 10),
										note: '',
									},
									files: [],
								},
							],
							files: [],
							history: [
								{
									id: 1,
									created_at: nowStr(),
									display_name: 'Admin (sts)',
									target_type: 'project',
									action: 'Khởi tạo dự án trong Database',
									detail: null,
								},
							],
						},
					],
				};
				await db.put(APP, 'store', 'main', root);
			}
			stateCache = root;
			window.__SS_FILE_URLS__ = window.__SS_FILE_URLS__ || {};
			for (const pr of root.projects || []) {
				for (const f of pr.files || []) if (f.id && f.dataUrl) window.__SS_FILE_URLS__[f.id] = f.dataUrl;
				for (const a of pr.assets || []) for (const f of a.files || []) if (f.id && f.dataUrl) window.__SS_FILE_URLS__[f.id] = f.dataUrl;
			}
			return stateCache;
		})();
		return initPromise;
	}

	async function saveState() {
		if (!stateCache) return;
		await window.STS_DB.put(APP, 'store', 'main', stateCache);
	}

	function nextId(st) {
		st.nextId = (Number(st.nextId) || 500) + 1;
		return st.nextId;
	}

	function findProj(st, pid) {
		const p = st.projects.find((x) => Number(x.id) === Number(pid));
		if (!p) throw new Error('Không tìm thấy dự án');
		p.notes = p.notes || [];
		p.sheetConfig = p.sheetConfig || {};
		p.files = p.files || [];
		p.history = p.history || [];
		p.voice = p.voice || {lines: []};
		p.assets = p.assets || [];
		p.breakdown = p.breakdown || {settings: {}, episodes: [], versions: [], job: null};
		return p;
	}

	function logHist(p, target_type, action, detail = null) {
		p.history = p.history || [];
		p.history.unshift({
			id: Date.now() + Math.floor(Math.random() * 1000),
			created_at: nowStr(),
			display_name: 'Admin (sts)',
			target_type,
			action,
			detail,
		});
	}

	async function handleScriptStudioApi(method, pathWithQuery, rawBody) {
		const st = await loadState();
		const [pathname, qs] = pathWithQuery.split('?');
		const params = new URLSearchParams(qs || '');
		const path = pathname.replace(/^\/api/, '');

		let body = rawBody;
		if (typeof rawBody === 'string') {
			try {
				body = JSON.parse(rawBody);
			} catch {
				body = {};
			}
		}

		// ---- Auth
		if (path === '/auth/me') {
			const authed =
				localStorage.getItem('sts_hub_auth') === '1' ||
				Boolean(localStorage.getItem('ss_auth_token'));
			if (!authed) {
				const err = new Error('Chưa đăng nhập');
				err.status = 401;
				throw err;
			}
			return {user: st.users[0] || DEFAULT_ADMIN};
		}
		if (path === '/auth/login' && method === 'POST') {
			const u = String(body?.username || '').trim();
			const p = String(body?.password || '').trim();
			const found = st.users.find((x) => x.username === u && (x.password === p || (u === 'sts' && p === '1111')));
			if (!found) throw new Error('Sai tài khoản hoặc mật khẩu');
			localStorage.setItem('sts_hub_auth', '1');
			localStorage.setItem('ss_auth_token', 'sts-admin-token');
			return {ok: true, token: 'sts-admin-token', user: found};
		}
		if (path === '/auth/logout') {
			localStorage.removeItem('ss_auth_token');
			return {ok: true};
		}
		if (path === '/auth/register' && method === 'POST') {
			const nu = {
				id: nextId(st),
				username: String(body?.username || '').trim(),
				display_name: String(body?.display_name || body?.username || '').trim(),
				password: String(body?.password || '1111'),
				lark_email: '',
				is_admin: false,
				active: true,
				approval_status: 'pending',
				positions: ['writer'],
				default_can_view: true,
				default_can_edit: true,
				default_can_delete: false,
			};
			st.users.push(nu);
			await saveState();
			return {ok: true, message: 'Đã tạo tài khoản và lưu vào Database!'};
		}
		if (path === '/auth/lark/info') return {configured: false, authorize_url: ''};
		if (path === '/auth/lark/demo') {
			localStorage.setItem('sts_hub_auth', '1');
			localStorage.setItem('ss_auth_token', 'sts-admin-token');
			return {ok: true, token: 'sts-admin-token', user: st.users[0] || DEFAULT_ADMIN};
		}
		if (path === '/auth/password') return {ok: true};

		// ---- Users & Settings
		if (path === '/users' && method === 'GET') return st.users;
		if (path === '/users' && method === 'POST') {
			const nu = {...body, id: nextId(st), active: true, approval_status: 'approved'};
			st.users.push(nu);
			await saveState();
			return nu;
		}
		let m;
		if ((m = /^\/users\/(\d+)$/.exec(path)) && method === 'PATCH') {
			const u = st.users.find((x) => Number(x.id) === Number(m[1]));
			if (u) Object.assign(u, body);
			await saveState();
			return u || {ok: true};
		}
		if (path === '/settings/lark') {
			if (method === 'PUT') {
				st.lark = {...st.lark, ...body};
				await saveState();
			}
			return st.lark;
		}
		if (path === '/ai-providers') {
			if (method === 'GET') {
				return {
					items: st.aiProviders.map((p) => ({
						...p,
						models: Array.isArray(p.models) ? p.models : String(p.models || '').split(',').map((s) => s.trim()).filter(Boolean),
					})),
					canConfig: true,
				};
			}
			if (method === 'POST') {
				const np = {
					...body,
					id: nextId(st),
					models: Array.isArray(body.models) ? body.models : String(body.models || '').split(',').map((s) => s.trim()).filter(Boolean),
				};
				st.aiProviders.push(np);
				await saveState();
				return np;
			}
		}
		if ((m = /^\/ai-providers\/(\d+)(\/test)?$/.exec(path))) {
			if (m[2] === '/test') return {ok: true, reply: 'Kết nối AI sẵn sàng hoạt động'};
			const id = Number(m[1]);
			if (method === 'DELETE') {
				st.aiProviders = st.aiProviders.filter((x) => Number(x.id) !== id);
				await saveState();
				return {ok: true};
			}
			const p = st.aiProviders.find((x) => Number(x.id) === id);
			if (p) {
				Object.assign(p, body, {
					models: Array.isArray(body.models) ? body.models : String(body.models || '').split(',').map((s) => s.trim()).filter(Boolean),
				});
				await saveState();
			}
			return p || {ok: true};
		}

		// ---- Projects List & Create
		if (path === '/projects' && method === 'GET') {
			return st.projects.map((p) => ({
				id: p.id,
				name: p.name,
				start_date: p.start_date,
				description: p.description,
				owner_name: p.owner_name || 'Admin (sts)',
				members: (p.members || []).length || 1,
				canEdit: true,
				myRoles: ALL_ROLES,
				stages: p.stages,
			}));
		}
		if (path === '/projects' && method === 'POST') {
			const id = nextId(st);
			const proj = {
				id,
				name: body.name || `Dự án #${id}`,
				start_date: body.start_date || new Date().toISOString().slice(0, 10),
				description: body.description || '',
				owner_id: 1,
				owner_name: 'Admin (sts)',
				created_at: nowStr(),
				stages: {
					script: {status: 'draft', at: nowStr(), comment: ''},
					breakdown: {status: 'draft', at: nowStr(), comment: ''},
					voice: {status: 'draft', at: nowStr(), comment: ''},
					assets: {status: 'draft', at: nowStr(), comment: ''},
				},
				members: [
					{
						user_id: 1,
						username: 'sts',
						display_name: 'Admin (sts)',
						roles: body.my_roles?.length ? body.my_roles : ALL_ROLES,
						can_view: true,
						can_edit: true,
						can_delete: true,
					},
				],
				approvals: [],
				script: {
					rev: 1,
					font: 'Courier New',
					font_size: 14,
					updated_at: nowStr(),
					updated_by_name: 'Admin (sts)',
					blocks: [{id: Math.random().toString(36).slice(2, 10), type: 'scene', text: 'INT. BỐI CẢNH - NGÀY'}],
					versions: [],
				},
				notes: [],
				sheetConfig: {},
				breakdown: {settings: {episodes: 1, minutes: 1.5, provider_id: 1, model: 'heuristic', style: 'Anime 2D', intent: ''}, job: null, episodes: [], versions: []},
				voice: {lines: []},
				assets: [],
				files: [],
				history: [{id: Date.now(), created_at: nowStr(), display_name: 'Admin (sts)', target_type: 'project', action: 'Tạo dự án mới', detail: null}],
			};
			st.projects.unshift(proj);
			await saveState();
			return {id};
		}

		// ---- Single Project Detail
		if ((m = /^\/projects\/(\d+)$/.exec(path))) {
			const pid = Number(m[1]);
			if (method === 'DELETE') {
				st.projects = st.projects.filter((x) => Number(x.id) !== pid);
				await saveState();
				return {ok: true};
			}
			const p = findProj(st, pid);
			if (method === 'PATCH') {
				Object.assign(p, body);
				logHist(p, 'project', 'Cập nhật thông tin dự án');
				await saveState();
				return {ok: true};
			}
			return {
				project: {
					id: p.id,
					name: p.name,
					start_date: p.start_date,
					description: p.description,
					owner_id: p.owner_id,
					created_at: p.created_at,
					stages: p.stages,
				},
				access: {
					admin: true,
					owner: true,
					view: true,
					edit: true,
					del: true,
					deleteProject: true,
					roles: ALL_ROLES,
					caps: FULL_CAPS,
				},
				members: p.members,
				approvals: p.approvals || [],
			};
		}

		// ---- Members & Stages
		if ((m = /^\/projects\/(\d+)\/members(?:\/(\d+))?$/.exec(path))) {
			const p = findProj(st, m[1]);
			if (method === 'POST') {
				const u = st.users.find((x) => Number(x.id) === Number(body.user_id));
				if (u) {
					p.members.push({
						user_id: u.id,
						username: u.username,
						display_name: u.display_name,
						roles: body.roles || ['writer'],
						can_view: body.can_view !== false,
						can_edit: Boolean(body.can_edit),
						can_delete: Boolean(body.can_delete),
					});
					await saveState();
				}
			} else if (method === 'PATCH' && m[2]) {
				const mem = p.members.find((x) => Number(x.user_id) === Number(m[2]));
				if (mem) Object.assign(mem, body);
				await saveState();
			} else if (method === 'DELETE' && m[2]) {
				p.members = p.members.filter((x) => Number(x.user_id) !== Number(m[2]));
				await saveState();
			}
			return {ok: true};
		}

		if ((m = /^\/projects\/(\d+)\/stages\/([a-z_]+)$/.exec(path)) && method === 'POST') {
			const p = findProj(st, m[1]);
			const stage = m[2];
			const act = body.action;
			const status = act === 'submit' ? 'review' : act === 'approve' ? 'approved' : act === 'reject' ? 'rejected' : 'draft';
			p.stages[stage] = {status, at: nowStr(), comment: body.comment || ''};
			p.approvals.unshift({id: nextId(st), created_at: nowStr(), display_name: 'Admin (sts)', action: act, stage, comment: body.comment || ''});
			logHist(p, stage, `Chuyển trạng thái ${stage} → ${status}`);
			await saveState();
			return {ok: true};
		}

		// ---- Script
		if ((m = /^\/projects\/(\d+)\/script$/.exec(path))) {
			const p = findProj(st, m[1]);
			if (method === 'PUT') {
				p.script.blocks = body.blocks || p.script.blocks;
				p.script.font = body.font || p.script.font;
				p.script.font_size = body.font_size || p.script.font_size;
				p.script.rev = (p.script.rev || 1) + 1;
				p.script.updated_at = nowStr();
				p.script.updated_by_name = 'Admin (sts)';
				logHist(p, 'script', `Lưu kịch bản (${p.script.blocks.length} dòng)`);
				await saveState();
				return {ok: true, rev: p.script.rev};
			}
			return p.script;
		}

		if ((m = /^\/projects\/(\d+)\/script\/versions(?:\/(\d+))?(?:\/(restore))?$/.exec(path))) {
			const p = findProj(st, m[1]);
			p.script.versions = p.script.versions || [];
			if (method === 'GET' && !m[2]) return p.script.versions;
			if (method === 'POST' && !m[2]) {
				const v = {
					id: nextId(st),
					created_at: nowStr(),
					display_name: 'Admin (sts)',
					reason: body.reason || 'Lưu phiên bản',
					blocks: JSON.parse(JSON.stringify(p.script.blocks || [])),
				};
				p.script.versions.unshift(v);
				await saveState();
				return v;
			}
			if (m[2]) {
				const v = p.script.versions.find((x) => Number(x.id) === Number(m[2]));
				if (!v) throw new Error('Không tìm thấy phiên bản');
				if (m[3] === 'restore') {
					p.script.blocks = JSON.parse(JSON.stringify(v.blocks || []));
					p.script.rev = (p.script.rev || 1) + 1;
					await saveState();
					return {ok: true};
				}
				return {...v, diff: []};
			}
		}

		if ((m = /^\/projects\/(\d+)\/script\/apply-notes$/.exec(path)) && method === 'POST') {
			const p = findProj(st, m[1]);
			const ids = body.note_ids || [];
			const results = [];
			for (const n of p.notes) {
				if (ids.includes(n.id)) {
					n.status = 'applied';
					n.color = 'green';
					if (n.suggestion) {
						const blk = p.script.blocks.find((b) => b.id === n.target_id);
						if (blk) {
							blk.text = n.quote && blk.text.includes(n.quote) ? blk.text.replace(n.quote, n.suggestion) : n.suggestion;
						}
					}
					n.result = n.suggestion ? `Đã thay bằng: "${n.suggestion}"` : 'Đã duyệt note';
					results.push({id: n.id, result: n.result});
				}
			}
			await saveState();
			return {results};
		}

		if ((m = /^\/projects\/(\d+)\/script\/spellcheck$/.exec(path)) && method === 'POST') {
			return {fixes: []};
		}

		// ---- Notes
		if ((m = /^\/projects\/(\d+)\/notes(?:\/(\d+))?(?:\/(replies))?$/.exec(path))) {
			const p = findProj(st, m[1]);
			if (method === 'GET') {
				const tt = params.get('target_type');
				return (p.notes || []).filter((n) => !tt || n.target_type === tt);
			}
			if (method === 'POST' && !m[2]) {
				const note = {
					id: nextId(st),
					target_type: body.target_type || 'script',
					target_id: String(body.target_id),
					field: body.field || '',
					quote: body.quote || '',
					pos_start: body.pos_start ?? null,
					pos_end: body.pos_end ?? null,
					suggestion: body.suggestion ?? null,
					comment: body.comment || '',
					color: body.color || 'yellow',
					status: 'open',
					author_name: 'Admin (sts)',
					created_at: nowStr(),
					replies: [],
				};
				p.notes.unshift(note);
				await saveState();
				return note;
			}
			if (m[2] && m[3] === 'replies' && method === 'POST') {
				const note = p.notes.find((n) => Number(n.id) === Number(m[2]));
				if (note) {
					note.replies = note.replies || [];
					note.replies.push({id: nextId(st), author: 'Admin (sts)', text: body.text || '', created_at: nowStr()});
					await saveState();
				}
				return {ok: true};
			}
			if (m[2] && method === 'PATCH') {
				const note = p.notes.find((n) => Number(n.id) === Number(m[2]));
				if (note) Object.assign(note, body);
				await saveState();
				return note || {ok: true};
			}
			if (m[2] && method === 'DELETE') {
				p.notes = p.notes.filter((n) => Number(n.id) !== Number(m[2]));
				await saveState();
				return {ok: true};
			}
		}

		// ---- Sheet Config
		if ((m = /^\/projects\/(\d+)\/sheet-config$/.exec(path))) {
			const p = findProj(st, m[1]);
			if (method === 'PUT') {
				p.sheetConfig = body || {};
				await saveState();
			}
			return p.sheetConfig || {};
		}

		// ---- Breakdown, Episodes & Shots
		if ((m = /^\/projects\/(\d+)\/breakdown$/.exec(path)) && method === 'GET') {
			const p = findProj(st, m[1]);
			const noteCounts = {};
			for (const n of p.notes || []) {
				if (n.target_type === 'shot' && n.status === 'open') {
					noteCounts[n.target_id] = (noteCounts[n.target_id] || 0) + 1;
				}
			}
			return {
				episodes: p.breakdown.episodes || [],
				settings: p.breakdown.settings || {},
				job: p.breakdown.job || null,
				files: p.files || [],
				noteCounts,
			};
		}
		if ((m = /^\/projects\/(\d+)\/breakdown\/settings$/.exec(path)) && method === 'PUT') {
			const p = findProj(st, m[1]);
			p.breakdown.settings = {...p.breakdown.settings, ...body};
			await saveState();
			return {ok: true};
		}
		if ((m = /^\/projects\/(\d+)\/breakdown\/generate$/.exec(path)) && method === 'POST') {
			const p = findProj(st, m[1]);
			const blocks = p.script?.blocks || [];
			const shots = [];
			let curLoc = 'INT. BỐI CẢNH - NGÀY';
			let curSpeaker = '';
			let idx = 1;
			for (const b of blocks) {
				if (b.type === 'scene') curLoc = b.text || curLoc;
				else if (b.type === 'character') curSpeaker = b.text || '';
				else if (b.type === 'dialogue' || b.type === 'action') {
					shots.push({
						id: nextId(st),
						storyboard: `S${idx++}`,
						location: curLoc,
						visual: b.type === 'action' ? b.text : `Cận cảnh ${curSpeaker || 'nhân vật'} đang thoại`,
						speaker: b.type === 'dialogue' ? curSpeaker : '',
						dialogue: b.type === 'dialogue' ? b.text : '',
						emotion: b.type === 'dialogue' ? 'Tự nhiên' : '',
						props: '',
						director_comment: '',
						camera: b.type === 'dialogue' ? 'Medium Close-Up (MCU)' : 'Wide / Medium Shot',
						director_note: p.breakdown.settings?.style || 'Anime 2D',
						timing: '5',
						qc: '',
						boss: '',
					});
				}
			}
			if (!shots.length) {
				shots.push({id: nextId(st), storyboard: 'S1', location: curLoc, visual: 'Cảnh mở đầu', timing: '5'});
			}
			p.breakdown.episodes = [
				{
					id: nextId(st),
					number: 1,
					title: 'Tập 1',
					summary: 'Tự động phân tách từ kịch bản văn học',
					minutes: Number(p.breakdown.settings?.minutes) || 1.5,
					shots,
				},
			];
			logHist(p, 'breakdown', `Tạo tự động kịch bản phân tách (${shots.length} shots)`);
			await saveState();
			return {ok: true};
		}
		if ((m = /^\/projects\/(\d+)\/breakdown\/versions/.exec(path))) {
			const p = findProj(st, m[1]);
			return p.breakdown.versions || [];
		}
		if ((m = /^\/projects\/(\d+)\/episodes(?:\/(\d+))?$/.exec(path))) {
			const p = findProj(st, m[1]);
			if (method === 'POST') {
				const num = (p.breakdown.episodes.length || 0) + 1;
				const ep = {id: nextId(st), number: num, title: `Tập ${num}`, summary: '', minutes: 1.5, shots: []};
				p.breakdown.episodes.push(ep);
				await saveState();
				return ep;
			}
			if (method === 'PATCH' && m[2]) {
				const ep = p.breakdown.episodes.find((e) => Number(e.id) === Number(m[2]));
				if (ep) Object.assign(ep, body);
				await saveState();
				return ep || {ok: true};
			}
			if (method === 'DELETE' && m[2]) {
				p.breakdown.episodes = p.breakdown.episodes.filter((e) => Number(e.id) !== Number(m[2]));
				await saveState();
				return {ok: true};
			}
		}
		if ((m = /^\/projects\/(\d+)\/episodes\/(\d+)\/shots(\/batch)?$/.exec(path)) && method === 'POST') {
			const p = findProj(st, m[1]);
			const ep = p.breakdown.episodes.find((e) => Number(e.id) === Number(m[2]));
			if (!ep) throw new Error('Không tìm thấy tập');
			if (m[3] === '/batch') {
				let updated = 0;
				let inserted = 0;
				for (const u of body.updates || []) {
					const sh = ep.shots.find((s) => Number(s.id) === Number(u.id));
					if (sh) {
						Object.assign(sh, u.data);
						updated++;
					}
				}
				for (const ins of body.inserts || []) {
					ep.shots.push({id: nextId(st), storyboard: `S${ep.shots.length + 1}`, timing: '5', ...ins});
					inserted++;
				}
				await saveState();
				return {updated, inserted};
			}
			const sh = {id: nextId(st), storyboard: `S${ep.shots.length + 1}`, timing: '5'};
			if (body.after_idx !== undefined && body.after_idx >= 0) ep.shots.splice(body.after_idx + 1, 0, sh);
			else ep.shots.push(sh);
			await saveState();
			return sh;
		}
		if ((m = /^\/projects\/(\d+)\/shots\/(\d+)$/.exec(path))) {
			const p = findProj(st, m[1]);
			for (const ep of p.breakdown.episodes) {
				if (method === 'DELETE') {
					ep.shots = ep.shots.filter((s) => Number(s.id) !== Number(m[2]));
				} else if (method === 'PATCH') {
					const sh = ep.shots.find((s) => Number(s.id) === Number(m[2]));
					if (sh && body.data) Object.assign(sh, body.data);
				}
			}
			await saveState();
			return {ok: true};
		}

		// ---- Voice Off
		if ((m = /^\/projects\/(\d+)\/voice(?:\/(batch|generate|\d+))?$/.exec(path))) {
			const p = findProj(st, m[1]);
			const sub = m[2];
			if (method === 'GET') return {lines: p.voice.lines || []};
			if (sub === 'generate' && method === 'POST') {
				const lines = [];
				for (const ep of p.breakdown.episodes || []) {
					for (const sh of ep.shots || []) {
						if (sh.dialogue && String(sh.dialogue).trim()) {
							lines.push({
								id: nextId(st),
								episode: String(ep.number),
								shot: sh.storyboard || '',
								scene: sh.location || '',
								character: sh.speaker || 'NHÂN VẬT',
								line: sh.dialogue,
								emotion: sh.emotion || 'calm',
								tagged: `[${sh.emotion || 'calm'}] ${sh.dialogue}`,
								note: '',
							});
						}
					}
				}
				p.voice.lines = lines;
				await saveState();
				return {ok: true, count: lines.length};
			}
			if (sub === 'batch' && method === 'POST') {
				let updated = 0;
				let inserted = 0;
				for (const u of body.updates || []) {
					const l = p.voice.lines.find((x) => Number(x.id) === Number(u.id));
					if (l) {
						Object.assign(l, u.data);
						updated++;
					}
				}
				for (const ins of body.inserts || []) {
					p.voice.lines.push({id: nextId(st), episode: '1', shot: '', scene: '', character: '', line: '', emotion: '', tagged: '', note: '', ...ins});
					inserted++;
				}
				await saveState();
				return {updated, inserted};
			}
			if (!sub && method === 'POST') {
				const nl = {id: nextId(st), episode: '1', shot: '', scene: '', character: '', line: '', emotion: '', tagged: '', note: '', ...(body.data || {})};
				if (body.after_idx !== undefined && body.after_idx >= 0) p.voice.lines.splice(body.after_idx + 1, 0, nl);
				else p.voice.lines.push(nl);
				await saveState();
				return nl;
			}
			if (sub && method === 'PATCH') {
				const l = p.voice.lines.find((x) => Number(x.id) === Number(sub));
				if (l && body.data) Object.assign(l, body.data);
				await saveState();
				return {ok: true};
			}
			if (sub && method === 'DELETE') {
				p.voice.lines = p.voice.lines.filter((x) => Number(x.id) !== Number(sub));
				await saveState();
				return {ok: true};
			}
		}

		// ---- Assets
		if ((m = /^\/projects\/(\d+)\/assets(?:\/(batch|generate|\d+))?(?:\/(approve-files))?$/.exec(path))) {
			const p = findProj(st, m[1]);
			const sub = m[2];
			if (method === 'GET') return {assets: p.assets || []};
			if (sub === 'generate' && method === 'POST') {
				const chars = new Set();
				for (const b of p.script.blocks || []) {
					if (b.type === 'character' && b.text?.trim()) chars.add(b.text.trim());
				}
				for (const ch of chars) {
					if (!p.assets.some((a) => a.category === 'character' && a.data?.name === ch)) {
						p.assets.push({
							id: nextId(st),
							category: 'character',
							idx: p.assets.length,
							ad_approved: false,
							director_approved: false,
							data: {name: ch, version: 'Mặc định', episodes: 'Tập 1', description: 'Trích xuất từ kịch bản', status: 'Chưa làm', owner: 'Admin (sts)', deadline: '', note: ''},
							files: [],
						});
					}
				}
				await saveState();
				return {ok: true};
			}
			if (sub === 'batch' && method === 'POST') {
				let updated = 0;
				let inserted = 0;
				for (const u of body.updates || []) {
					const a = p.assets.find((x) => Number(x.id) === Number(u.id));
					if (a) {
						a.data = {...a.data, ...u.data};
						updated++;
					}
				}
				for (const ins of body.inserts || []) {
					p.assets.push({
						id: nextId(st),
						category: body.category || 'character',
						idx: p.assets.length,
						ad_approved: false,
						director_approved: false,
						data: {name: '', status: 'Chưa làm', ...ins},
						files: [],
					});
					inserted++;
				}
				await saveState();
				return {updated, inserted};
			}
			if (!sub && method === 'POST') {
				const na = {
					id: nextId(st),
					category: body.category || 'character',
					idx: p.assets.length,
					ad_approved: false,
					director_approved: false,
					data: {name: '', status: 'Chưa làm', ...(body.data || {})},
					files: [],
				};
				p.assets.push(na);
				await saveState();
				return na;
			}
			if (sub && m[3] === 'approve-files' && method === 'POST') {
				const a = p.assets.find((x) => Number(x.id) === Number(sub));
				if (a) {
					const appIds = body.approved_ids || [];
					for (const f of a.files || []) {
						f.approved = appIds.includes(f.id);
						if (f.approved) f.approver = 'Admin (sts)';
					}
					await saveState();
				}
				return {ok: true};
			}
			if (sub && method === 'PATCH') {
				const a = p.assets.find((x) => Number(x.id) === Number(sub));
				if (a) {
					if (body.data) a.data = {...a.data, ...body.data};
					const {data, ...rest} = body;
					Object.assign(a, rest);
					await saveState();
				}
				return {ok: true};
			}
			if (sub && method === 'DELETE') {
				p.assets = p.assets.filter((x) => Number(x.id) !== Number(sub));
				await saveState();
				return {ok: true};
			}
		}

		// ---- Files Upload & Delete
		if ((m = /^\/projects\/(\d+)\/files(?:\/(\d+))?$/.exec(path))) {
			const p = findProj(st, m[1]);
			if (method === 'POST' && rawBody instanceof FormData) {
				const files = rawBody.getAll('files');
				const kind = rawBody.get('kind') || 'reference';
				const owner_type = rawBody.get('owner_type') || 'project';
				const owner_id = rawBody.get('owner_id') ? Number(rawBody.get('owner_id')) : null;
				const caption = rawBody.get('caption') || '';
				const added = [];
				for (const f of files) {
					const dataUrl = await new Promise((resolve) => {
						const r = new FileReader();
						r.onload = () => resolve(r.result);
						r.onerror = () => resolve('');
						r.readAsDataURL(f);
					});
					const rec = {
						id: nextId(st),
						original_name: f.name || 'file',
						mime: f.type || 'application/octet-stream',
						kind,
						owner_type,
						owner_id,
						caption,
						approved: false,
						uploader: 'Admin (sts)',
						uploaded_at: nowStr(),
						dataUrl,
					};
					window.__SS_FILE_URLS__ = window.__SS_FILE_URLS__ || {};
					window.__SS_FILE_URLS__[rec.id] = dataUrl;
					p.files.push(rec);
					if (owner_type === 'asset' && owner_id) {
						const asset = p.assets.find((a) => Number(a.id) === owner_id);
						if (asset) {
							asset.files = asset.files || [];
							asset.files.push(rec);
						}
					}
					added.push(rec);
				}
				await saveState();
				return {ok: true, files: added};
			}
			if (method === 'DELETE' && m[2]) {
				const fid = Number(m[2]);
				p.files = (p.files || []).filter((f) => Number(f.id) !== fid);
				for (const a of p.assets || []) {
					a.files = (a.files || []).filter((f) => Number(f.id) !== fid);
				}
				await saveState();
				return {ok: true};
			}
		}

		// ---- Script Import (.txt / .docx)
		if ((m = /^\/projects\/(\d+)\/script\/import$/.exec(path)) && method === 'POST') {
			const p = findProj(st, m[1]);
			let text = '';
			if (rawBody instanceof FormData) {
				const f = rawBody.get('file');
				if (f && typeof f.text === 'function') text = await f.text();
			}
			const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
			if (lines.length) {
				p.script.blocks = lines.map((line, i) => ({
					id: `b_${Date.now()}_${i}`,
					type: /^(INT\.|EXT\.|CẢNH\s)/i.test(line) ? 'scene' : line === line.toUpperCase() && line.length < 28 ? 'character' : 'action',
					text: line,
				}));
				p.script.rev = (p.script.rev || 1) + 1;
				await saveState();
			}
			return p.script;
		}

		// ---- History
		if ((m = /^\/projects\/(\d+)\/history$/.exec(path))) {
			const p = findProj(st, m[1]);
			return p.history || [];
		}

		return {ok: true};
	}

	// Intercept fetch calls to /api/* inside Script Studio so all operations persist into STS_DB (IndexedDB + SQLite)
	const origFetch = window.fetch.bind(window);
	window.fetch = async (input, init = {}) => {
		const urlStr = typeof input === 'string' ? input : input?.url || '';
		// Block dead trycloudflare tunnel or intercept local /api/* calls for Script Studio
		if (urlStr.includes('trycloudflare.com') || urlStr.includes('loca.lt')) {
			const idx = urlStr.indexOf('/api/');
			if (idx >= 0) {
				const apiPath = urlStr.slice(idx);
				try {
					const data = await handleScriptStudioApi((init.method || 'GET').toUpperCase(), apiPath, init.body);
					return new Response(JSON.stringify(data), {status: 200, headers: {'Content-Type': 'application/json'}});
				} catch (err) {
					return new Response(JSON.stringify({error: err.message}), {status: err.status || 400, headers: {'Content-Type': 'application/json'}});
				}
			}
		}
		if (urlStr.startsWith('/api/') && !urlStr.startsWith('/api/hub/')) {
			try {
				const data = await handleScriptStudioApi((init.method || 'GET').toUpperCase(), urlStr, init.body);
				return new Response(JSON.stringify(data), {status: 200, headers: {'Content-Type': 'application/json'}});
			} catch (err) {
				return new Response(JSON.stringify({error: err.message}), {status: err.status || 400, headers: {'Content-Type': 'application/json'}});
			}
		}
		return origFetch(input, init);
	};
})();
