# Hero (fixed component)

A Puck component with a title, a subtitle, an alignment and a call-to-action
button. It is the reviewed fixed source of the P10 certification chain: its
build, certification and host loading are proven by the validator; it is not
a product component.

## Usage

The browser module's default export is the Puck `ComponentConfig`; register it
under the allocated `puckType`:

```ts
import hero from "@anvilkit/hero-fixed";
const config = { components: { Hero: hero } };
```

Load `styles/hero.css` before importing the module; the stylesheet references
`assets/mark.svg` relatively, so ship both directories together. Editable
fields: `title` (text), `subtitle` (textarea), `align` (`left` or `center`),
`ctaLabel` (text). The component uses the host's React (`react`,
`react/jsx-runtime`) and never bundles its own.
