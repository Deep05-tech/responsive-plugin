# Elementor Responsive Agent - Known Limitations

While **Elementor Responsive Agent (ERA)** reliably detects layout overflows, touch target sizing, typography, and container misconfigurations within Elementor's native component tree, the following edge cases and custom structures are out of scope for automated JSON patching:

1. **Custom HTML & Raw Code Widgets**
   - Embedded arbitrary HTML markup (e.g. `<div style="width:900px">`) in HTML widgets or shortcodes cannot be safely refactored by mutating Elementor's responsive styling controls without modifying raw HTML string contents.
   - Planted/hardcoded inline CSS styles inside raw HTML strings require manual markup adjustment.

2. **Third-Party Sliders & Carousels (e.g. Slider Revolution, Swiper extensions)**
   - External slider JavaScript plugins calculate internal slide widths dynamically at runtime using custom option registries rather than native Elementor container CSS variables.

3. **Hand-Written / Theme Custom CSS (`style.css` & Custom CSS Field)**
   - Arbitrary CSS rules injected with `!important` or fixed viewport units in theme stylesheets or Elementor Custom CSS meta bypass Elementor's native responsive CSS cascade.

4. **Popups & Off-Canvas Modals**
   - Elementor popups and off-canvas drawers are detached from the main DOM document flow and rely on trigger events (click/scroll) to mount and render dimensions.

5. **Dynamic WooCommerce Templates & Complex Query Loops**
   - Dynamic product archive loop tables and third-party checkout plugins that inject non-Elementor table layouts without responsive wrappers.
