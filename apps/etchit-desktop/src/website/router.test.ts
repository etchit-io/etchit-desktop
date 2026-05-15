import { describe, expect, it } from "vitest";

import { navHtml, routerScript } from "./router";

describe("router", () => {
  it("emits a script tag with the routing IIFE", () => {
    const s = routerScript();
    expect(s.startsWith("<script>")).toBe(true);
    expect(s.endsWith("</script>")).toBe(true);
    expect(s).toContain("hashchange");
    expect(s).toContain("data-page");
  });

  it("intercepts nav clicks instead of changing the URL", () => {
    // The published-site router must not rely on `<a href="#…">`
    // navigation: `srcdoc` iframes (editor preview) treat hash nav as
    // a top-level redirect on WebKit-derived embedders. We register
    // explicit click handlers and call `preventDefault()`.
    const s = routerScript();
    expect(s).toContain("addEventListener('click'");
    expect(s).toContain("e.preventDefault()");
  });

  it("still listens to hashchange for external deep-links", () => {
    // `autonomi://<addr>#about` must land on the About section when
    // fetch>it renders the published site — the hashchange listener
    // handles that entry path, even though in-page nav is click-driven.
    const s = routerScript();
    expect(s).toContain("addEventListener('hashchange'");
    expect(s).toContain("location.hash");
  });

  it("contains no external references", () => {
    const s = routerScript();
    expect(s).not.toMatch(/src=/);
    expect(s).not.toMatch(/https?:/);
  });
});

describe("navHtml", () => {
  it("returns empty when there's only one page (no nav needed)", () => {
    expect(navHtml([{ id: "home", name: "Home" }])).toBe("");
  });

  it("returns empty for an empty pages array", () => {
    expect(navHtml([])).toBe("");
  });

  it("renders a <nav> with one anchor per page", () => {
    const html = navHtml([
      { id: "home", name: "Home" },
      { id: "about", name: "About" },
      { id: "contact", name: "Contact" },
    ]);
    expect(html.startsWith("<nav>")).toBe(true);
    expect(html.endsWith("</nav>")).toBe(true);
    expect((html.match(/<a /g) ?? []).length).toBe(3);
    expect(html).toContain('href="#home"');
    expect(html).toContain('href="#about"');
    expect(html).toContain('href="#contact"');
  });

  it("escapes page names in attributes", () => {
    const html = navHtml([
      { id: "home", name: "Home" },
      { id: "x", name: '<script>"&' },
    ]);
    expect(html).toContain("&lt;script&gt;&quot;&amp;");
    expect(html).not.toContain("<script>");
  });
});
