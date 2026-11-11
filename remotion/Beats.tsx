// Motion beats: big-number card (count-up text slam), emoji reaction next to the head,
// hook title, tilted topic pill, end card over the frozen outro.
import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame} from 'remotion';
import type {Beat, EditPlan} from '../shared/types';
import {fontStack} from './fonts';

export const Beats: React.FC<{plan: EditPlan; layer: 'under' | 'over'}> = ({plan, layer}) => {
	const frame = useCurrentFrame();
	const t = frame / plan.fps;
	const active = plan.beats.filter((b) => t >= b.start && t < b.end && (layer === 'under' ? b.type === 'endcard' : b.type !== 'endcard'));
	if (!active.length) return null;
	return (
		<AbsoluteFill style={{pointerEvents: 'none'}}>
			{active.map((b, k) => {
				const local = frame - Math.round(b.start * plan.fps);
				const left = Math.round(b.end * plan.fps) - frame;
				const props = {b, plan, local, left};
				switch (b.type) {
					case 'big':
						return <BigCard key={k} {...props} />;
					case 'emoji':
						return <EmojiPop key={k} {...props} />;
					case 'title':
						return <Title key={k} {...props} />;
					case 'pill':
						return <Pill key={k} {...props} />;
					case 'endcard':
						return <EndCard key={k} {...props} />;
					case 'flash':
					case 'dip':
						return <SceneChange key={k} {...props} />;
					default:
						return null;
				}
			})}
		</AbsoluteFill>
	);
};

type P = {b: Beat; plan: EditPlan; local: number; left: number};

const unitOf = (plan: EditPlan) => Math.min(plan.width, plan.height) / 1080;
const exitOf = (left: number, n = 6) => interpolate(left, [0, n], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

const BigCard: React.FC<P> = ({b, plan, local, left}) => {
	const fps = plan.fps;
	const u = unitOf(plan);
	const s = spring({frame: local, fps, config: {damping: 11, stiffness: 180, mass: 0.7}});
	const out = exitOf(left);
	let text = b.text || '';
	if (b.count) {
		const k = interpolate(local, [0, fps * 0.7], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: (x) => 1 - Math.pow(1 - x, 3)});
		const v = b.count.from + (b.count.to - b.count.from) * k;
		const num = b.count.decimals > 0 ? v.toFixed(b.count.decimals) : Math.round(v).toLocaleString('en-US');
		text = `${b.count.prefix}${num}${b.count.suffix}`;
	}
	const size = (text.length > 9 ? 120 : text.length > 6 ? 150 : 190) * u;
	return (
		<div
			style={{
				position: 'absolute',
				left: (b.x ?? plan.width / 2) - plan.width * 0.42,
				width: plan.width * 0.84,
				top: (b.y ?? plan.height * 0.6) - 170 * u,
				height: 340 * u,
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'center',
				transform: `scale(${interpolate(s, [0, 1], [0.55, 1])}) rotate(${interpolate(s, [0, 1], [-6, 0])}deg)`,
				opacity: Math.min(1, s * 1.5) * out,
			}}
		>
			<div
				style={{
					padding: `${18 * u}px ${48 * u}px`,
					borderRadius: 40 * u,
					background: 'rgba(12,12,14,0.78)',
					boxShadow: `0 ${20 * u}px ${60 * u}px rgba(0,0,0,0.45), inset 0 0 0 ${3 * u}px ${plan.brand.accent}55`,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
				}}
			>
				<div
					style={{
						fontFamily: fontStack('Montserrat'),
						fontWeight: 900,
						fontSize: size,
						lineHeight: 1,
						color: plan.brand.accent,
						letterSpacing: '-0.03em',
						textShadow: `0 0 ${40 * u}px ${plan.brand.accent}66`,
						whiteSpace: 'nowrap',
					}}
				>
					{text}
				</div>
				{b.sub ? (
					<div
						style={{
							marginTop: 12 * u,
							fontFamily: fontStack('Montserrat'),
							fontWeight: 800,
							fontSize: 44 * u,
							color: '#fff',
							letterSpacing: '0.06em',
							opacity: interpolate(local, [6, 14], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
							textAlign: 'center',
						}}
					>
						{b.sub}
					</div>
				) : null}
			</div>
		</div>
	);
};

const EmojiPop: React.FC<P> = ({b, plan, local, left}) => {
	const fps = plan.fps;
	const s = spring({frame: local, fps, config: {damping: 8, stiffness: 200, mass: 0.6}});
	const out = exitOf(left, 7);
	const size = b.size ?? 180;
	const float = Math.sin(local / 7) * size * 0.04;
	const lean = (b.x ?? 0) > plan.width / 2 ? -10 : 10;
	return (
		<div
			style={{
				position: 'absolute',
				left: (b.x ?? plan.width * 0.78) - size / 2,
				top: (b.y ?? plan.height * 0.3) - size / 2 + float,
				width: size,
				height: size,
				fontSize: size * 0.82,
				lineHeight: `${size}px`,
				textAlign: 'center',
				transform: `scale(${s * out}) rotate(${lean * s}deg)`,
				filter: `drop-shadow(0 ${size * 0.06}px ${size * 0.12}px rgba(0,0,0,0.4))`,
				fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
			}}
		>
			{b.emoji}
		</div>
	);
};

const Title: React.FC<P> = ({b, plan, local, left}) => {
	const fps = plan.fps;
	const u = unitOf(plan);
	const s = spring({frame: local, fps, config: {damping: 13, stiffness: 160}});
	const out = exitOf(left, 8);
	const words = (b.text || '').split(/\s+/);
	return (
		<div
			style={{
				position: 'absolute',
				top: (b.y ?? plan.height * 0.2) - 90 * u,
				left: plan.width * 0.07,
				width: plan.width * 0.86,
				display: 'flex',
				flexWrap: 'wrap',
				justifyContent: 'center',
				gap: `${10 * u}px ${18 * u}px`,
				opacity: out,
				transform: `translateY(${interpolate(s, [0, 1], [-40 * u, 0])}px)`,
			}}
		>
			{words.map((w, k) => {
				const ws = spring({frame: local - k * 2, fps, config: {damping: 12, stiffness: 220}});
				const hi = k === words.length - 1 || /\d/.test(w);
				return (
					<span
						key={k}
						style={{
							display: 'inline-block',
							padding: `${4 * u}px ${18 * u}px`,
							borderRadius: 14 * u,
							background: hi ? plan.brand.accent : '#fff',
							color: '#111',
							fontFamily: fontStack(plan.brand.font === 'Bangers' ? 'Bangers' : 'Montserrat'),
							fontWeight: 900,
							fontSize: 78 * u,
							lineHeight: 1.15,
							textTransform: 'uppercase',
							transform: `scale(${ws}) rotate(${hi ? -2 : 0}deg)`,
							boxShadow: `0 ${10 * u}px ${30 * u}px rgba(0,0,0,0.35)`,
						}}
					>
						{w}
					</span>
				);
			})}
		</div>
	);
};

const Pill: React.FC<P> = ({b, plan, local, left}) => {
	const u = unitOf(plan);
	const s = spring({frame: local, fps: plan.fps, config: {damping: 12, stiffness: 200}});
	const out = exitOf(left);
	return (
		<div style={{position: 'absolute', top: (b.y ?? plan.height * 0.15) - 40 * u, width: '100%', display: 'flex', justifyContent: 'center'}}>
			<span
				style={{
					padding: `${12 * u}px ${30 * u}px`,
					borderRadius: 999,
					background: plan.brand.accent,
					color: '#111',
					fontFamily: fontStack('Montserrat'),
					fontWeight: 800,
					fontSize: 48 * u,
					transform: `scale(${s * out}) rotate(-3deg)`,
					boxShadow: `0 ${10 * u}px ${30 * u}px rgba(0,0,0,0.35)`,
				}}
			>
				{b.text}
			</span>
		</div>
	);
};

const EndCard: React.FC<P> = ({b, plan, local}) => {
	const u = unitOf(plan);
	const s = spring({frame: local, fps: plan.fps, config: {damping: 14, stiffness: 120}});
	const line = interpolate(local, [8, 22], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
	return (
		<AbsoluteFill style={{background: `rgba(0,0,0,${0.55 * s})`, alignItems: 'center', justifyContent: 'center'}}>
			<div style={{transform: `translateY(${(1 - s) * 60 * u}px)`, opacity: s, textAlign: 'center', padding: `0 ${80 * u}px`}}>
				<div style={{fontFamily: fontStack('Montserrat'), fontWeight: 900, fontSize: 92 * u, color: '#fff', lineHeight: 1.1}}>{b.text}</div>
				<div style={{height: 10 * u, width: `${line * 70}%`, background: plan.brand.accent, margin: `${28 * u}px auto 0`, borderRadius: 10 * u}} />
			</div>
		</AbsoluteFill>
	);
};

// clip-to-clip transition: a white flash or a dip to black, peaking on the cut
const SceneChange: React.FC<P> = ({b, plan, local}) => {
	const total = Math.max(2, Math.round((b.end - b.start) * plan.fps));
	const mid = total / 2;
	const k = 1 - Math.abs(local - mid) / mid;
	const o = Math.max(0, Math.min(1, b.type === 'flash' ? Math.pow(k, 1.6) * 0.85 : Math.min(1, k * 1.4)));
	return <AbsoluteFill style={{background: b.type === 'flash' ? '#fff' : '#000', opacity: o}} />;
};
