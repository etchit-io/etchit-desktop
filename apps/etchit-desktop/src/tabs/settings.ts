import { invoke } from "@tauri-apps/api/core";

import { KEYCHAIN_CHANGED_EVENT } from "../wallet/statusPill";

function announceKeychainChange(): void {
  window.dispatchEvent(new CustomEvent(KEYCHAIN_CHANGED_EVENT));
}

import { normalizeSecretKey } from "../etch/secretKey";
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
        <h2>Advanced &mdash; wallet key</h2>
        <p class="settings-desc">
          For etching without WalletConnect. Paste a hex private key and
          etch/it will use it to pay for uploads, storing it only in
          your operating system&rsquo;s keychain &mdash; never on disk in
          plaintext.
        </p>
        <div class="settings-warn">
          <p class="settings-warn-title">Use a dedicated upload wallet.</p>
          <p class="settings-warn-body">
            Fund it small, treat it as hot. Don&rsquo;t paste a wallet that
            holds anything you&rsquo;d be upset to lose.
          </p>
        </div>
        <label class="settings-key-label" for="settings-key-input">Private key</label>
        <input
          id="settings-key-input"
          type="password"
          class="settings-key-input"
          placeholder="64-hex (with or without 0x prefix)"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <div class="settings-key-actions">
          <button type="button" class="settings-key-store" disabled>Store key</button>
          <button type="button" class="settings-key-clear" hidden>Clear stored key</button>
        </div>
        <p class="settings-key-status" role="status" aria-live="polite">checking&hellip;</p>
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

  mountAppearance(host);
  mountAdvanced(host);
}

function mountAppearance(host: HTMLElement): void {
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

function mountAdvanced(host: HTMLElement): void {
  const input = host.querySelector(".settings-key-input") as HTMLInputElement;
  const storeBtn = host.querySelector(".settings-key-store") as HTMLButtonElement;
  const clearBtn = host.querySelector(".settings-key-clear") as HTMLButtonElement;
  const status = host.querySelector(".settings-key-status") as HTMLParagraphElement;

  function refreshStoreEnabled(): void {
    storeBtn.disabled = normalizeSecretKey(input.value) === null;
  }

  function setStatusStored(): void {
    status.textContent = "Key stored. Uploads will pay from this wallet.";
    status.dataset.tone = "ok";
    clearBtn.hidden = false;
  }

  function setStatusEmpty(): void {
    status.textContent = "No key stored. Add one to enable etching.";
    status.dataset.tone = "muted";
    clearBtn.hidden = true;
  }

  function setStatusError(msg: string): void {
    status.textContent = msg;
    status.dataset.tone = "error";
  }

  void invoke<boolean>("has_secret_key").then(
    (present) => (present ? setStatusStored() : setStatusEmpty()),
    (e) => setStatusError(String(e)),
  );

  input.addEventListener("input", refreshStoreEnabled);

  storeBtn.addEventListener("click", () => {
    const value = input.value;
    storeBtn.disabled = true;
    storeBtn.textContent = "Storing…";
    void invoke<void>("store_secret_key", { key: value }).then(
      () => {
        input.value = "";
        storeBtn.textContent = "Store key";
        refreshStoreEnabled();
        setStatusStored();
        announceKeychainChange();
      },
      (e) => {
        storeBtn.textContent = "Store key";
        refreshStoreEnabled();
        setStatusError(String(e));
      },
    );
  });

  clearBtn.addEventListener("click", () => {
    clearBtn.disabled = true;
    clearBtn.textContent = "Clearing…";
    void invoke<void>("clear_secret_key").then(
      () => {
        clearBtn.textContent = "Clear stored key";
        clearBtn.disabled = false;
        setStatusEmpty();
        announceKeychainChange();
      },
      (e) => {
        clearBtn.textContent = "Clear stored key";
        clearBtn.disabled = false;
        setStatusError(String(e));
      },
    );
  });
}
