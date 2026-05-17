import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";

import { normalizeSecretKey } from "../etch/secretKey";
import {
  clearPasswordSession,
  PASSPHRASE_CHANGED_EVENT,
} from "../private/passwordSession";
import {
  isScreenshotWatchEnabled,
  setScreenshotWatchEnabled,
} from "../screenshot/settings";
import { applyTheme, loadTheme, type Theme } from "../theme/theme";
import { formatErr } from "../util/error";
import { KEYCHAIN_CHANGED_EVENT } from "../wallet/statusPill";

function announceKeychainChange(): void {
  window.dispatchEvent(new CustomEvent(KEYCHAIN_CHANGED_EVENT));
}

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
      </header>

      <section class="settings-section">
        <details class="settings-collapsible">
          <summary><h2>Appearance</h2></summary>
          <p class="settings-desc">
            etch<span class="brand-mark">/</span>it ships dark — pick a softer surface if dark isn&rsquo;t your thing.
          </p>
          <div class="settings-theme-options" role="radiogroup" aria-label="Theme"></div>
        </details>
      </section>

      <section class="settings-section">
        <h2>Etch from clipboard</h2>
        <p class="settings-desc">
          When on, copying an image (or taking a screenshot &mdash;
          most OS screenshot tools drop the capture straight into the
          clipboard) pops a small toast asking if you want to etch it
          publicly. One click and it&rsquo;s on the network.
        </p>
        <div class="settings-warn">
          <p class="settings-warn-title">Public &mdash; not private.</p>
          <p class="settings-warn-body">
            The toast etches publicly. Once on the network, the bytes
            stay there. If your clipboard might hold something
            sensitive (passwords, IDs, work screens), leave this off.
          </p>
        </div>
        <label class="settings-toggle">
          <input type="checkbox" class="settings-clipboard-toggle" />
          <span>Watch the clipboard for images</span>
        </label>
      </section>

      <section class="settings-section">
        <h2>Advanced &mdash; wallet key</h2>
        <p class="settings-desc">
          For etching without WalletConnect. Paste a hex private key and
          etch<span class="brand-mark">/</span>it will use it to pay for uploads, storing it only in
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
        <details class="settings-howto">
          <summary>Where do I get a wallet key?</summary>
          <ol class="settings-howto-list">
            <li>Install an EVM-compatible wallet that lets you export a private key (MetaMask, Rabby, etc.).</li>
            <li>Create a fresh account inside that wallet to use only for etching.</li>
            <li>Switch the wallet to the <strong>Arbitrum One</strong> network.</li>
            <li>Fund the account with a small amount of <strong>ETH</strong> (for gas) and <strong>ANT</strong> (for storage payments).</li>
            <li>Export the private key for that account and paste it below.</li>
          </ol>
          <p class="settings-howto-note">
            Rather not extract a private key at all? Switch to
            <strong>WalletConnect</strong> in the Wallet tab &mdash; the key
            stays inside your wallet app and every etch pops it for an
            explicit signature.
          </p>
        </details>
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
        <h2>Advanced &mdash; private passphrase</h2>
        <p class="settings-desc">
          The passphrase that encrypts every private etch on this
          device. Kept in your OS keychain so the same library opens
          on every launch &mdash; never in a file, never uploaded.
          Clearing it forces a brand-new passphrase on your next
          private etch.
        </p>
        <div class="settings-warn">
          <p class="settings-warn-title">Write your passphrase down.</p>
          <p class="settings-warn-body">
            If the keychain is wiped or you move to another device,
            the passphrase is the only thing that can decrypt your
            library. No one &mdash; including etchit &mdash; can
            recover it for you.
          </p>
        </div>
        <div class="settings-key-actions">
          <button type="button" class="settings-pw-clear" hidden>Clear stored passphrase</button>
        </div>
        <p class="settings-pw-status" role="status" aria-live="polite">checking&hellip;</p>
      </section>

      <section class="settings-section">
        <details class="settings-collapsible">
          <summary><h2>About</h2></summary>
          <p class="settings-desc">
            <strong>etch<span class="brand-mark">/</span>it &mdash; beta software.</strong>
            Dual-licensed under
            <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">AGPL-3.0-only</a>
            and a separate commercial license (see <code>COMMERCIAL.md</code>). Provided
            <em>&ldquo;AS IS&rdquo; without warranty of any kind</em>; see sections
            15 &amp; 16 of the AGPL for the full disclaimer.
          </p>
          <p class="settings-desc settings-desc-muted">
            Companion reader: <strong>fetch<span class="brand-mark">&gt;</span>it</strong>.
          </p>
        </details>
      </section>
    </div>
  `;

  mountAppearance(host);
  mountClipboardWatch(host);
  mountAdvanced(host);
  mountPassphrase(host);
}

function mountClipboardWatch(host: HTMLElement): void {
  const toggle = host.querySelector(".settings-clipboard-toggle") as HTMLInputElement;
  toggle.checked = isScreenshotWatchEnabled();
  toggle.addEventListener("change", () => {
    setScreenshotWatchEnabled(toggle.checked);
  });
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
    (e) => setStatusError(formatErr(e)),
  );

  input.addEventListener("input", refreshStoreEnabled);

  /** Native OS confirm dialog via plugin-dialog. WebView
   *  `window.confirm` is unreliable across Tauri configurations; the
   *  plugin uses GTK / WKWebView / Win32 native dialogs and always
   *  pops.
   *
   *  The wallet key only pays for uploads — private etches are
   *  protected by a separate passphrase, so clearing the key does
   *  NOT affect their decryption. The risk is losing access to the
   *  wallet itself (and any ANT/ETH still on it) if the user
   *  doesn't have it written down somewhere. */
  async function confirmKeyChange(action: "clear" | "replace"): Promise<boolean> {
    const verb = action === "clear" ? "Clear" : "Replace";
    const present = action === "clear" ? "Clearing" : "Replacing";
    const msg = [
      `${present} the wallet key removes it from this device's keychain.`,
      "",
      "Make sure you have this private key written down or saved elsewhere — once cleared from here, etchit can't recover it for you.",
      "",
      "Future etches in Internal mode will need you to paste a key in again, or you can switch to WalletConnect.",
      "",
      `Continue?`,
    ].join("\n");
    return ask(msg, { title: `${verb} wallet key`, kind: "warning" });
  }

  storeBtn.addEventListener("click", () => {
    void (async () => {
      const hadKey = !clearBtn.hidden;
      if (hadKey && !(await confirmKeyChange("replace"))) return;
      const value = input.value;
      storeBtn.disabled = true;
      storeBtn.textContent = "Storing…";
      try {
        await invoke<void>("store_secret_key", { key: value });
        input.value = "";
        storeBtn.textContent = "Store key";
        refreshStoreEnabled();
        setStatusStored();
        announceKeychainChange();
      } catch (e) {
        storeBtn.textContent = "Store key";
        refreshStoreEnabled();
        setStatusError(formatErr(e));
      }
    })();
  });

  clearBtn.addEventListener("click", () => {
    void (async () => {
      if (!(await confirmKeyChange("clear"))) return;
      clearBtn.disabled = true;
      clearBtn.textContent = "Clearing…";
      try {
        await invoke<void>("clear_secret_key");
        clearBtn.textContent = "Clear stored key";
        clearBtn.disabled = false;
        setStatusEmpty();
        announceKeychainChange();
      } catch (e) {
        clearBtn.textContent = "Clear stored key";
        clearBtn.disabled = false;
        setStatusError(formatErr(e));
      }
    })();
  });
}

function mountPassphrase(host: HTMLElement): void {
  const clearBtn = host.querySelector(".settings-pw-clear") as HTMLButtonElement;
  const status = host.querySelector(".settings-pw-status") as HTMLParagraphElement;

  const setStored = (): void => {
    status.textContent = "Passphrase stored. Library opens automatically on every launch.";
    status.dataset.tone = "ok";
    clearBtn.hidden = false;
  };
  const setEmpty = (): void => {
    status.textContent = "No passphrase stored yet. One will be set the first time you etch privately.";
    status.dataset.tone = "muted";
    clearBtn.hidden = true;
  };
  const setError = (msg: string): void => {
    status.textContent = msg;
    status.dataset.tone = "error";
  };

  const refresh = (): void => {
    void invoke<boolean>("has_private_passphrase").then(
      (present) => (present ? setStored() : setEmpty()),
      (e) => setError(formatErr(e)),
    );
  };
  refresh();
  window.addEventListener(PASSPHRASE_CHANGED_EVENT, refresh);

  async function confirmClear(): Promise<boolean> {
    const msg = [
      "Clearing the passphrase removes it from this device's keychain.",
      "",
      "WARNING: every private etch in your library — and any backup file you've made — needs this passphrase to decrypt. Without it, the encrypted chunks stay on the network forever but no one (including you) can read them again.",
      "",
      "Have you saved the passphrase somewhere safe (written down, password manager, etc.)?",
      "",
      "Continue?",
    ].join("\n");
    return ask(msg, { title: "Clear private passphrase", kind: "warning" });
  }

  clearBtn.addEventListener("click", () => {
    void (async () => {
      if (!(await confirmClear())) return;
      clearBtn.disabled = true;
      clearBtn.textContent = "Clearing…";
      try {
        clearPasswordSession();
        // clearPasswordSession fires the keychain delete in the
        // background; wait a tick + re-read to surface any error
        // path that might come back.
        const stillThere = await invoke<boolean>("has_private_passphrase");
        if (stillThere) throw new Error("keychain reports the passphrase is still present");
        clearBtn.textContent = "Clear stored passphrase";
        clearBtn.disabled = false;
        setEmpty();
      } catch (e) {
        clearBtn.textContent = "Clear stored passphrase";
        clearBtn.disabled = false;
        setError(formatErr(e));
      }
    })();
  });
}
