import type { ComponentConfig } from "@puckeditor/core";
import { Hero, type HeroProps } from "./hero";

/** The Puck component configuration: fields, defaults and the renderer. */
export const config: ComponentConfig<HeroProps> = {
	label: "Hero",
	fields: {
		title: { type: "text" },
		subtitle: { type: "textarea" },
		align: {
			type: "radio",
			options: [
				{ label: "Left", value: "left" },
				{ label: "Center", value: "center" },
			],
		},
		ctaLabel: { type: "text" },
	},
	defaultProps: {
		title: "Build once, certify exactly",
		subtitle: "A reviewed fixed component: complete source, protected build, independent verdict.",
		align: "left",
		ctaLabel: "Get started",
	},
	render: ({ title, subtitle, align, ctaLabel }) => <Hero title={title} subtitle={subtitle} align={align} ctaLabel={ctaLabel} />,
};

export { Hero };
export type { HeroProps };
export default config;
