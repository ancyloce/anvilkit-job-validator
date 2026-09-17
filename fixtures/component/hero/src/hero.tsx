import { useState } from "react";

export interface HeroProps {
	title: string;
	subtitle: string;
	align: "left" | "center";
	ctaLabel: string;
}

/**
 * The rendered component. It uses a hook so that a host serving a second
 * React instance fails visibly (hooks cannot cross React instances), which
 * the validator's host fixture relies on.
 */
export function Hero({ title, subtitle, align, ctaLabel }: HeroProps) {
	const [clicks, setClicks] = useState(0);
	return (
		<section className={`ak-hero ak-hero--${align}`} data-anvilkit-component="Hero">
			<span className="ak-hero__mark" aria-hidden="true" />
			<h1 className="ak-hero__title">{title}</h1>
			<p className="ak-hero__subtitle">{subtitle}</p>
			<button type="button" className="ak-hero__cta" data-clicks={clicks} onClick={() => setClicks(clicks + 1)}>
				{ctaLabel}
			</button>
		</section>
	);
}
