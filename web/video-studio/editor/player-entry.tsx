// Browser entry: live preview of the timeline with Remotion's <Player>.
import React from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {Player, type PlayerRef} from '@remotion/player';
import {AutoEdit} from '../../remotion/AutoEdit';
import {compileTimeline, editToSrc, layoutSegments, retimeCaption, srcToEdit, captionText, tlId, timelineToSrt, type CompileCtx, type Timeline} from '../../shared/timeline';
import {DEFAULT_OPTIONS, type EditPlan} from '../../shared/types';
import {STYLES} from '../../shared/styles';
import {ADJUST_KEYS, COLOR_FILTERS, DEFAULT_COLOR, ZERO_ADJUST, combineAdjust, statsOf, autoAdjust, gradeOf} from '../../shared/color';

type Handle = {
	update: (plan: EditPlan) => void;
	seek: (sec: number) => void;
	toggle: () => void;
	play: () => void;
	pause: () => void;
	isPlaying: () => boolean;
	time: () => number;
};

const mount = (el: HTMLElement, plan: EditPlan, onTime: (sec: number, playing: boolean) => void): Handle => {
	const ref = React.createRef<PlayerRef>();
	const root: Root = createRoot(el);
	let current = plan;
	const render = () =>
		root.render(
			<Player
				ref={ref}
				component={AutoEdit}
				inputProps={{plan: current}}
				durationInFrames={Math.max(1, current.durationInFrames)}
				fps={current.fps}
				compositionWidth={current.width}
				compositionHeight={current.height}
				style={{width: '100%', height: '100%'}}
				controls
				clickToPlay
				spaceKeyToPlayOrPause={false}
				acknowledgeRemotionLicense
			/>,
		);
	render();
	let raf = 0;
	const loop = () => {
		const p = ref.current;
		if (p) onTime(p.getCurrentFrame() / current.fps, p.isPlaying());
		raf = requestAnimationFrame(loop);
	};
	raf = requestAnimationFrame(loop);
	void raf;
	return {
		update: (pl) => {
			current = pl;
			render();
		},
		seek: (sec) => ref.current?.seekTo(Math.max(0, Math.min(current.durationInFrames - 1, Math.round(sec * current.fps)))),
		toggle: () => ref.current?.toggle(),
		play: () => ref.current?.play(),
		pause: () => ref.current?.pause(),
		isPlaying: () => !!ref.current?.isPlaying(),
		time: () => (ref.current ? ref.current.getCurrentFrame() / current.fps : 0),
	};
};

const api = {
	mount,
	compile: (tl: Timeline, ctx: CompileCtx) => compileTimeline(tl, ctx),
	layoutSegments,
	srcToEdit,
	editToSrc,
	retimeCaption,
	captionText,
	tlId,
	timelineToSrt,
	STYLES,
	DEFAULT_OPTIONS,
	color: {ADJUST_KEYS, COLOR_FILTERS, DEFAULT_COLOR, ZERO_ADJUST, combineAdjust, statsOf, autoAdjust, gradeOf},
};
(window as unknown as {AVS: typeof api}).AVS = api;
export default api;
