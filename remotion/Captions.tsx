// Word-timed captions in 8 looks (ghost-editor caption templates: house/clean, editorial blur-in,
// keyword serif, Caption News box, outline meme, karaoke pill). Hidden while a big card speaks for them.
import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame} from 'remotion';
import type {CaptionGroup, CaptionLook, EditPlan, PlanWord} from '../shared/types';
import {fontStack} from './fonts';

export const Captions: React.FC<{plan: EditPlan}> = ({plan}) => {
	const frame = useCurrentFrame();
	const t = frame / plan.fps;
	const bigActive = plan.beats.some((b) => (b.type === 'big' || b.type === 'endcard') && t >= b.start && t < b.end);
	if (bigActive) return null;
	const g = plan.captions.groups.find((x) => t >= x.start && t < x.end);
	if (!g) return null;
	return <Group plan={plan} g={g} t={t} frame={frame} />;
};

const Group: React.FC<{plan: EditPlan; g: CaptionGroup; t: number; frame: number}> = ({plan, g, t, frame}) => {
	const look = plan.captions.look;
	const fps = plan.fps;
	const local = frame - Math.round(g.start * fps);
	const enter = look.anim === 'pop' || look.anim === 'bounce' ? spring({frame: local, fps, config: {damping: 14, stiffness: 220, mass: 0.6}, durationInFrames: 8}) : 1;
	const scale = look.anim === 'pop' || look.anim === 'bounce' ? interpolate(enter, [0, 1], [0.82, 1]) : 1;
	const W = plan.width;
	return (
		<AbsoluteFill style={{pointerEvents: 'none'}}>
			<div
				style={{
					position: 'absolute',
					top: g.y,
					left: (W * (1 - look.maxWidth)) / 2,
					width: W * look.maxWidth,
					display: 'flex',
					justifyContent: 'center',
					transform: `scale(${scale})`,
					transformOrigin: '50% 50%',
				}}
			>
				<div
					style={{
						display: 'flex',
						flexWrap: 'wrap',
						justifyContent: 'center',
						alignItems: 'baseline',
						rowGap: look.size * 0.08,
						padding: look.bg === 'pill' || g.backing ? `${look.size * 0.18}px ${look.size * 0.4}px` : 0,
						borderRadius: look.size * 0.35,
						background: look.bg === 'pill' ? 'rgba(10,10,12,0.62)' : g.backing ? 'rgba(0,0,0,0.5)' : 'transparent',
						fontFamily: fontStack(look.font),
						fontWeight: look.weight,
						fontSize: look.size,
						lineHeight: 1.12,
						textAlign: 'center',
						textTransform: look.upper ? 'uppercase' : look.lower ? 'lowercase' : 'none',
						letterSpacing: look.upper ? '0.01em' : '-0.01em',
					}}
				>
					{g.words.map((w, k) => (
						<WordSpan key={k} w={w} look={look} t={t} fps={fps} frame={frame} />
					))}
				</div>
			</div>
		</AbsoluteFill>
	);
};

const WordSpan: React.FC<{w: PlanWord; look: CaptionLook; t: number; fps: number; frame: number}> = ({w, look, t, fps, frame}) => {
	const spoken = t >= w.start;
	const active = t >= w.start && t < w.end + 0.05;
	const sinceStart = frame - Math.round(w.start * fps);
	let color = look.color;
	let transform = '';
	let opacity = 1;
	let filter: string | undefined;
	let background: string | undefined;
	let padding: string | undefined;
	let fontFamily: string | undefined;
	let fontStyle: React.CSSProperties['fontStyle'];
	let textShadow = look.shadow ? '0 4px 18px rgba(0,0,0,0.55), 0 2px 4px rgba(0,0,0,0.7)' : undefined;

	if (look.anim === 'blur') {
		// editorial: each word resolves from blur as it is spoken
		const k = interpolate(sinceStart, [-2, 5], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
		opacity = interpolate(k, [0, 1], [0, 1]);
		filter = `blur(${(1 - k) * 10}px)`;
		transform = `translateY(${(1 - k) * 10}px)`;
	} else if (look.anim === 'karaoke') {
		opacity = spoken ? 1 : 0.45;
	} else if (look.anim === 'bounce' && active) {
		const s = spring({frame: sinceStart, fps, config: {damping: 9, stiffness: 260, mass: 0.5}, durationInFrames: 10});
		transform = `translateY(${-8 * s}px) scale(${1 + 0.14 * s})`;
	} else if (look.anim === 'pop' && active) {
		const s = spring({frame: sinceStart, fps, config: {damping: 12, stiffness: 300, mass: 0.5}, durationInFrames: 8});
		transform = `scale(${1 + 0.08 * s})`;
	}

	if (active && look.activeColor) color = look.activeColor;

	if (w.keyword && look.keywordMode !== 'none') {
		if (look.keywordMode === 'color') {
			if (spoken) color = look.keywordColor;
		} else if (look.keywordMode === 'box') {
			if (spoken) {
				const k = interpolate(sinceStart, [0, 5], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
				background = `linear-gradient(90deg, ${look.keywordColor} ${k * 100}%, transparent ${k * 100}%)`;
				color = isLight(look.keywordColor) ? '#111' : '#fff';
				padding = `0 ${look.size * 0.16}px`;
				transform += ` rotate(${look.style === 'editorial' ? -2.5 : 0}deg)`;
				textShadow = undefined;
			}
		} else if (look.keywordMode === 'serif') {
			fontFamily = `"${look.serifFont || 'Playfair Display'}", Georgia, serif`;
			fontStyle = 'italic';
			color = look.keywordColor;
			textShadow = `0 0 24px ${look.keywordColor}88, 0 2px 6px rgba(0,0,0,0.6)`;
		}
	}

	// outline as stacked shadows: renders the same in every Chrome (paint-order on HTML text does not)
	if (look.stroke > 0 && !background) textShadow = [outline(look.stroke, look.strokeColor), textShadow].filter(Boolean).join(', ');
	return (
		<span
			style={{
				display: 'inline-block',
				color,
				transform: transform || undefined,
				opacity,
				filter,
				background,
				padding,
				borderRadius: background ? look.size * 0.12 : undefined,
				fontFamily,
				fontStyle,
				textShadow,
				margin: `0 ${look.size * (look.anim === 'bounce' || look.anim === 'pop' ? 0.2 : 0.13)}px`,
				transformOrigin: '50% 80%',
			}}
		>
			{w.text}
		</span>
	);
};

const isLight = (hex: string) => {
	const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(hex);
	if (!m) return true;
	const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
	return 0.299 * r + 0.587 * g + 0.114 * b > 150;
};

const outline = (r: number, color: string) => {
	const out: string[] = [];
	const n = 16;
	for (let k = 0; k < n; k++) {
		const a = (k / n) * Math.PI * 2;
		out.push(`${(Math.cos(a) * r).toFixed(1)}px ${(Math.sin(a) * r).toFixed(1)}px 0 ${color}`);
	}
	return out.join(', ');
};
