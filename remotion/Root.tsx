import React from 'react';
import {Composition, type CalculateMetadataFunction} from 'remotion';
import {AutoEdit, type AutoEditProps} from './AutoEdit';
import {demoPlan} from './demo-plan';

const calculateMetadata: CalculateMetadataFunction<AutoEditProps> = ({props}) => ({
	durationInFrames: Math.max(1, props.plan.durationInFrames),
	fps: props.plan.fps,
	width: props.plan.width,
	height: props.plan.height,
});

export const RemotionRoot: React.FC = () => (
	<Composition
		id="AutoEdit"
		component={AutoEdit}
		durationInFrames={demoPlan.durationInFrames}
		fps={demoPlan.fps}
		width={demoPlan.width}
		height={demoPlan.height}
		defaultProps={{plan: demoPlan}}
		calculateMetadata={calculateMetadata}
	/>
);
