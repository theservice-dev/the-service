# Shopify Theme Development: Agent Instructions
**Architecture:** Online Store 2.0 (Horizon Framework)
**Primary Language:** Liquid, Tailwind CSS (via Theme Settings), Vanilla JS

## 1. Project Context
- We are building on the **Horizon** framework, which supports up to 8 levels of nested blocks.
- **GitHub Integration:** This repo is synced with the Shopify Admin. Never delete files without confirming if they are linked to live JSON templates.
- **Style Guide:** Use BEM (Block Element Modifier) for all CSS classes.
- **Mobile-First:** Design primarily for mobile devices, as they account for the majority of Shopify store traffic.

## 2. Liquid Coding Standards
- **Performance:** Always use `{%-` and `-%}` to trim whitespace. 
- **Modularity:** Prefer `snippets` for reusable UI components (buttons, cards) and `blocks` for merchant-configurable content.
- **Documentation:** Use `{% comment %}...{% endcomment %}` for complex logic. For snippets/blocks, use **LiquidDoc** headers to define parameters.
- **Data Access:** Avoid global objects (`all_products`). Use section/block settings to pass data.
- **Security:** Liquid output is auto-escaped. Be aware of `| raw` usage and ensure user input is handled safely.

## 3. Horizon Framework Specifics
- **Nested Blocks:** When generating sections, ensure the `schema` supports `max_blocks` and specific `blocks` types to leverage Horizon's nesting capabilities.
- **CSS Variables:** Only use variables defined in `config/settings_schema.json`. Example: `var(--color-accent-1)`.
- **Theme Blocks:** Utilize the `/blocks` directory for functional elements that can be moved across different sections.

## 4. Performance Optimization
- **Lighthouse Targets:** Aim for a minimum score of 60 on Homepage, Product, and Collection pages.
- **JavaScript:** Keep minified bundles under 16KB. Avoid large libraries like jQuery or React; use native DOM APIs.
- **Asset Loading:** Use `preload` for critical resources. Defer non-critical scripts.
- **Images:** Use responsive images (`srcset`), modern formats (WebP/AVIF), and strip metadata.
- **Fonts:** Prefer system fonts to avoid download lag and layout shifts.

## 5. Accessibility (WCAG 2.1/2.2 AA)
- **Keyboard Navigation:** Ensure all interactive elements are reachable and operable via keyboard. Visible focus indicators are mandatory.
- **Semantic HTML:** Use proper heading hierarchy (H1 -> H2 -> H3) without skipping levels. Use `<button>` for actions and `<a>` for navigation.
- **Contrast:** Maintain 4.5:1 contrast ratio for body text and 3:1 for large text.
- **Media:** Provide meaningful `alt` text for images. Use `alt=""` for decorative images.
- **Forms:** Ensure all form inputs have associated labels.

## 6. Security & Stability
- **JavaScript Scoping:** Wrap all scripts in IIFEs (Immediately Invoked Function Expressions) or use ES modules to prevent global namespace pollution.
- **Sandboxing:** Remember Liquid runs in a sandboxed environment.
- **Input Handling:** Validate and sanitize all user inputs.

## 7. Automation & Tools
- **Validation:** Before finishing any task, run `validate_theme` via the Shopify Dev MCP and `shopify theme check`.
- **API Knowledge:** If unsure about a Liquid filter or GraphQL field, use the `learn_shopify_api` tool.
- **Testing:** Perform manual accessibility audits using keyboard navigation and screen readers.
