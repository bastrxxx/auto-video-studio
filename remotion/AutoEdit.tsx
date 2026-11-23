import React, {useMemo} from 'react';
import {AbsoluteFill, Audio, Freeze, interpolate, OffthreadVideo, Sequence, useCurrentFrame} from 'remotion';
import {cameraAt} from '../shared/camera';
import type {EditPlan} from '../shared/types';
import {Beats} from './Beats';
import {Captions} from './Captions';
import {ensureFonts} from './fonts';

export type AutoEditProps = {plan: EditPlan};

export const AutoEdit: React.FC<AutoEditProps> = ({plan}) => {
	useMemo(() => ensureFonts([plan.captions.look.font, plan.captions.look.serifFont, plan.brand.font]), [plan]);
	return (
		<AbsoluteFill style={{backgroundColor: '#000'}}>
			<GradeDefs plan={plan} />
			<VideoTrack plan={plan} />
			<LookLayer plan={plan} />
			<Beats plan={plan} layer="under" />
			{plan.captions.enabled ? <Captions plan={plan} /> : null}
			<Beats plan={plan} layer="over" />
			{plan.progressBar.enabled ? <ProgressBar plan={plan} /> : null}
			<SoundLayer plan={plan} />
		</AbsoluteFill>
	);
};

const Segments: React.FC<{plan: EditPlan; muted?: boolean; style?: React.CSSProperties}> = ({plan, muted, style: style0}) => (
	<>
		{plan.segments.map((seg, k) => {
			const src = plan.clips?.[seg.clip ?? 0]?.src ?? plan.src;
			const style = seg.grade !== undefined && plan.grades?.[seg.grade] ? {...style0, filter: `url(#avs-grade-${seg.grade})`} : style0;
			return (
			<Sequence key={k} from={seg.from} durationInFrames={seg.dur} layout="none">
				{src ? (
					seg.freeze ? (
						<Freeze frame={0}>
							<OffthreadVideo src={src} trimBefore={seg.trimBefore} muted style={style} />
						</Freeze>
					) : (
						<OffthreadVideo
							src={src}
							trimBefore={seg.trimBefore}
							muted={muted || Boolean(plan.voiceOver?.src && plan.voiceOver.muteOriginal)}
							style={style}
							// 2-frame fades at every join so cuts don't click; duck original audio when Voice Over is active
							volume={(f) => {
								const base = Math.max(0, Math.min(1, (f + 1) / 2, (seg.dur - f) / 2));
								if (plan.voiceOver?.src) return base * (plan.voiceOver.muteOriginal ? 0 : plan.voiceOver.originalVolume ?? 0.25);
								return base;
							}}
						/>
					)
				) : (
					<DemoBackground />
				)}
			</Sequence>
			);
		})}
	</>
);

/** SVG filters for the color grades (tone curve per channel -> saturation -> hue), referenced by url(#id) */
const GradeDefs: React.FC<{plan: EditPlan}> = ({plan}) => {
	const grades = plan.grades || [];
	if (!grades.some(Boolean)) return null;
	return (
		<svg width={0} height={0} style={{position: 'absolute', width: 0, height: 0}} aria-hidden>
			<defs>
				{grades.map((g, i) =>
					g ? (
						<filter key={i} id={`avs-grade-${i}`} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
							<feComponentTransfer>
								<feFuncR type="table" tableValues={g.r} />
								<feFuncG type="table" tableValues={g.g} />
								<feFuncB type="table" tableValues={g.b} />
							</feComponentTransfer>
							{Math.abs(g.saturate - 1) > 0.005 ? <feColorMatrix type="saturate" values={String(g.saturate)} /> : null}
							{Math.abs(g.hue) > 0.05 ? <feColorMatrix type="hueRotate" values={String(g.hue)} /> : null}
						</filter>
					) : null,
				)}
			</defs>
		</svg>
	);
};

const DemoBackground: React.FC = () => {
	const frame = useCurrentFrame();
	return (
		<AbsoluteFill
			style={{
				background: `linear-gradient(${frame * 2}deg, #1d2b64, #f8cdda)`,
			}}
		/>
	);
};

const VideoTrack: React.FC<{plan: EditPlan}> = ({plan}) => {
	const frame = useCurrentFrame();
	const t = frame / plan.fps;
	const cam = cameraAt(plan, t);
	const fill: React.CSSProperties = {width: '100%', height: '100%', objectFit: 'fill', display: 'block'};
	return (
		<AbsoluteFill style={{overflow: 'hidden'}}>
			{plan.fit === 'blur' ? (
				<AbsoluteFill style={{filter: 'blur(48px) brightness(0.55) saturate(1.2)', transform: 'scale(1.25)'}}>
					<Segments plan={plan} muted style={{width: '100%', height: '100%', objectFit: 'cover'}} />
				</AbsoluteFill>
			) : null}
			<div
				style={{
					position: 'absolute',
					inset: 0,
					transform: `scale(${cam.z})`,
					transformOrigin: `${cam.ox}px ${cam.oy}px`,
					filter: plan.look.grade || undefined,
				}}
			>
				<div style={{position: 'absolute', left: cam.left, top: cam.top, width: cam.w, height: cam.h}}>
					<Segments plan={plan} style={fill} />
				</div>
			</div>
		</AbsoluteFill>
	);
};

const LookLayer: React.FC<{plan: EditPlan}> = ({plan}) => {
	const frame = useCurrentFrame();
	const {grain = 0, vignette = 0} = plan.look;
	if (!grain && !vignette) return null;
	return (
		<AbsoluteFill style={{pointerEvents: 'none'}}>
			{grain > 0 ? (
				<svg width={plan.width} height={plan.height} style={{position: 'absolute', inset: 0, opacity: grain * 2.2, mixBlendMode: 'overlay'}}>
					<filter id="grain">
						<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={frame % 12} stitchTiles="stitch" />
						<feColorMatrix type="saturate" values="0" />
					</filter>
					<rect width="100%" height="100%" filter="url(#grain)" />
				</svg>
			) : null}
			{vignette > 0 ? (
				<AbsoluteFill style={{background: `radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 45%, rgba(0,0,0,${vignette}) 100%)`}} />
			) : null}
		</AbsoluteFill>
	);
};

const ProgressBar: React.FC<{plan: EditPlan}> = ({plan}) => {
	const frame = useCurrentFrame();
	const p = frame / Math.max(1, plan.durationInFrames - 1);
	const h = Math.round(10 * (plan.height / 1920));
	return (
		<AbsoluteFill style={{pointerEvents: 'none'}}>
			<div style={{position: 'absolute', left: 0, top: 0, height: h, width: '100%', background: 'rgba(255,255,255,0.18)'}} />
			<div style={{position: 'absolute', left: 0, top: 0, height: h, width: `${p * 100}%`, background: plan.progressBar.color, boxShadow: `0 0 12px ${plan.progressBar.color}`}} />
		</AbsoluteFill>
	);
};

const SoundLayer: React.FC<{plan: EditPlan}> = ({plan}) => {
	const fps = plan.fps;
	const music = plan.music;
	const duck = useMemo(() => {
		if (!music) return null;
		const sp = music.speech;
		return (f: number) => {
			const t = f / fps;
			// distance to the nearest speech interval
			let d = 99;
			for (const [a, b] of sp) {
				if (t >= a && t <= b) {
					d = 0;
					break;
				}
				d = Math.min(d, t < a ? a - t : t - b);
				if (a > t + 2) break;
			}
			const k = Math.max(0, Math.min(1, (d - 0.15) / 0.45));
			const base = music.duckVolume + (music.volume - music.duckVolume) * k;
			const total = plan.durationInFrames / fps;
			const fade = Math.min(1, t / 0.8, Math.max(0, (total - t) / 1.5));
			return base * fade;
		};
	}, [music, fps, plan.durationInFrames]);
	return (
		<>
			{plan.sfx.map((s, k) => (
				<Sequence key={k} from={Math.round(s.at * fps)} durationInFrames={Math.max(1, Math.round((s.maxDur ?? 2.5) * fps))} layout="none">
					<Audio
						src={s.src}
						volume={(f) =>
							s.volume * interpolate(f, [Math.round((s.maxDur ?? 2.5) * fps) - 8, Math.round((s.maxDur ?? 2.5) * fps)], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
						}
					/>
				</Sequence>
			))}
			{plan.voiceOver?.src ? <Audio src={plan.voiceOver.src} volume={plan.voiceOver.volume ?? 1} /> : null}
			{music && duck ? <Audio src={music.src} loop volume={duck} /> : null}
		</>
	);
};
