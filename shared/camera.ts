// Camera math shared by the planner (caption placement) and the Remotion composition (rendering),
// so where the server thinks the face is on screen is exactly where it is rendered.
import type {EditPlan, Push} from './types';

export const lerpTrack = (track: [number, number, number][], t: number, fallback: [number, number]): [number, number] => {
	if (!track.length) return fallback;
	if (t <= track[0][0]) return [track[0][1], track[0][2]];
	const last = track[track.length - 1];
	if (t >= last[0]) return [last[1], last[2]];
	// binary search
	let lo = 0;
	let hi = track.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (track[mid][0] <= t) lo = mid;
		else hi = mid;
	}
	const a = track[lo];
	const b = track[hi];
	const k = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
	return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};

const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

export const zoomAt = (snaps: [number, number][], pushes: Push[], t: number, ease: boolean): number => {
	let s = 1;
	let prev = 1;
	let snapAt = -1;
	for (const [at, z] of snaps) {
		if (t >= at) {
			prev = s;
			s = z;
			snapAt = at;
		} else break;
	}
	if (ease && snapAt >= 0) {
		const d = 0.18;
		const k = Math.min(1, (t - snapAt) / d);
		s = prev + (s - prev) * easeInOut(k);
	}
	let p = 1;
	for (const q of pushes) {
		if (t < q.start || t >= q.end + q.down) continue;
		const rise = Math.min(1, (t - q.start) / Math.max(q.up, 1e-3));
		const fall = q.down > 0 && t > q.end ? 1 - (t - q.end) / q.down : 1;
		p *= 1 + (q.z - 1) * easeInOut(rise) * Math.max(0, fall);
	}
	return s * p;
};

export type CameraState = {
	left: number; // video box position in output px (before zoom)
	top: number;
	w: number; // video box size in output px
	h: number;
	z: number; // zoom
	ox: number; // zoom origin, output px
	oy: number;
};

type CamPlan = Pick<EditPlan, 'width' | 'height' | 'srcWidth' | 'srcHeight' | 'fit' | 'camera' | 'clips' | 'segments' | 'fps'>;

/** source dimensions of the clip on screen at edit time t */
export const clipDimsAt = (plan: CamPlan, t: number): {W: number; H: number; clip: number} => {
	if (!plan.clips || plan.clips.length < 2) return {W: plan.srcWidth, H: plan.srcHeight, clip: 0};
	const f = Math.floor(t * plan.fps + 1e-6);
	let clip = plan.segments[0]?.clip ?? 0;
	for (const s of plan.segments) {
		if (f >= s.from) clip = s.clip ?? 0;
		else break;
	}
	const c = plan.clips[clip] || plan.clips[0];
	return {W: c.width, H: c.height, clip};
};

export const cameraAt = (plan: CamPlan, t: number): CameraState => {
	const {width: OW, height: OH} = plan;
	const {W, H} = clipDimsAt(plan, t);
	const cover = Math.max(OW / W, OH / H);
	const contain = Math.min(OW / W, OH / H);
	const s0 = plan.fit === 'fill' ? cover : contain;
	const w = W * s0;
	const h = H * s0;
	const [cx, cy] = lerpTrack(plan.camera.follow, t, [0.5, 0.42]);
	let left = OW / 2 - cx * w;
	let top = OH / 2 - cy * h;
	if (plan.fit === 'fill') {
		left = Math.min(0, Math.max(OW - w, left));
		top = Math.min(0, Math.max(OH - h, top));
	} else {
		left = (OW - w) / 2;
		top = (OH - h) / 2;
	}
	const [fx, fy] = lerpTrack(plan.camera.origin, t, [0.5, 0.35]);
	const z = zoomAt(plan.camera.snaps, plan.camera.pushes, t, plan.camera.ease);
	return {left, top, w, h, z, ox: left + fx * w, oy: top + fy * h};
};

/** source-normalised point -> output pixel */
export const toScreen = (cam: CameraState, nx: number, ny: number): [number, number] => {
	const x = cam.left + nx * cam.w;
	const y = cam.top + ny * cam.h;
	return [cam.ox + cam.z * (x - cam.ox), cam.oy + cam.z * (y - cam.oy)];
};
