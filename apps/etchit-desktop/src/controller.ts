import { applyTheme, loadTheme } from "./theme/theme";
import { mountTabBar } from "./ui/tabBar";
import { TAB_IDS, type TabId } from "./types";
import { mountEtch } from "./tabs/etch";
import { mountPrivate } from "./tabs/private";
import { mountBlogger } from "./tabs/blogger";
import { mountWebsite } from "./tabs/website";
import { mountHistory } from "./tabs/history";
import { mountWallet } from "./tabs/wallet";
import { mountSettings } from "./tabs/settings";
import { mountWalletPill } from "./wallet/statusPill";

const MOUNTERS: Record<TabId, (host: HTMLElement) => void> = {
  etch: mountEtch,
  private: mountPrivate,
  blogger: mountBlogger,
  website: mountWebsite,
  history: mountHistory,
  wallet: mountWallet,
  settings: mountSettings,
};

export function init(): void {
  applyTheme(loadTheme());

  const tabBarHost = need<HTMLElement>("tab-bar");
  const stage = need<HTMLElement>("stage");
  const walletPillHost = need<HTMLElement>("wallet-pill");
  mountWalletPill(walletPillHost);

  const hosts = {} as Record<TabId, HTMLElement>;
  const mounted = new Set<TabId>();

  for (const id of TAB_IDS) {
    const pane = document.createElement("section");
    pane.className = "tab-pane";
    pane.dataset.tab = id;
    pane.setAttribute("role", "tabpanel");
    pane.hidden = true;
    stage.appendChild(pane);
    hosts[id] = pane;
  }

  const lazyMount = (id: TabId): void => {
    if (mounted.has(id)) return;
    MOUNTERS[id](hosts[id]);
    mounted.add(id);
  };

  const initial: TabId = "etch";

  const tabBarApi = mountTabBar(tabBarHost, initial, (id) => {
    for (const key of TAB_IDS) hosts[key].hidden = key !== id;
    lazyMount(id);
  });

  // Cross-tab navigation. The Wallet tab dispatches this to jump to
  // Settings → Advanced when the user has no wallet key configured;
  // we listen at the controller so any tab can hop without coupling.
  window.addEventListener("etchit:goto-tab", (e) => {
    const id = (e as CustomEvent).detail as TabId;
    if (TAB_IDS.includes(id)) tabBarApi.setActive(id);
  });

  hosts[initial].hidden = false;
  lazyMount(initial);
}

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}
