import { applyTheme, loadTheme, type Theme } from "../theme/theme";

interface ThemeOption {
  id: Theme;
  label: string;
  description: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    id: "dark",
    label: "Dark",
    description: "Brand default — ink canvas, copper accent.",
  },
  {
    id: "dim",
    label: "Dim",
    description: "Warm mid-tone for less contrast than full dark.",
  },
  {
    id: "light",
    label: "Light",
    description: "Bone canvas for the brightest reading surface.",
  },
];

export function mountSettings(host: HTMLElement): void {
  host.innerHTML = `
    <div class="settings-content">
      <header class="settings-header">
        <h1>Settings</h1>
        <p class="settings-lede">Premium defaults out of the box; everything optional below.</p>
      </header>
      <section class="settings-section">
        <h2>Appearance</h2>
        <p class="settings-desc">
          etch/it ships dark — pick a softer surface if dark isn&rsquo;t your thing.
        </p>
        <div class="settings-theme-options" role="radiogroup" aria-label="Theme"></div>
      </section>
      <section class="settings-section">
        <h2>About</h2>
        <p class="settings-desc">
          <strong>etch/it &mdash; beta software.</strong>
          Dual-licensed under
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">AGPL-3.0-only</a>
          and a separate commercial license (see <code>COMMERCIAL.md</code>). Provided
          <em>&ldquo;AS IS&rdquo; without warranty of any kind</em>; see sections
          15 &amp; 16 of the AGPL for the full disclaimer.
        </p>
        <p class="settings-desc settings-desc-muted">
          Companion reader: <strong>fetch&gt;it</strong>.
        </p>
      </section>
    </div>
  `;

  const optionsHost = host.querySelector(".settings-theme-options") as HTMLElement;
  const current = loadTheme();
  for (const opt of THEME_OPTIONS) {
    const label = document.createElement("label");
    label.className = "settings-theme-option";
    label.dataset.theme = opt.id;
    label.innerHTML = `
      <input type="radio" name="theme" value="${opt.id}" ${opt.id === current ? "checked" : ""}>
      <span class="settings-theme-text">
        <span class="settings-theme-label">${opt.label}</span>
        <span class="settings-theme-desc">${opt.description}</span>
      </span>
    `;
    optionsHost.appendChild(label);
    const input = label.querySelector("input") as HTMLInputElement;
    input.addEventListener("change", () => {
      if (input.checked) applyTheme(opt.id);
    });
  }
}
