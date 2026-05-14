import { TAB_IDS, type TabId } from "../types";

export interface TabBarApi {
  setActive(tab: TabId): void;
  getActive(): TabId;
}

const LABELS: Record<TabId, string> = {
  etch: "Etch",
  blogger: "Blogger",
  website: "Website",
  history: "History",
  wallet: "Wallet",
  settings: "Settings",
};

export function mountTabBar(
  host: HTMLElement,
  initial: TabId,
  onChange: (tab: TabId) => void,
): TabBarApi {
  let active: TabId = initial;
  const buttons = {} as Record<TabId, HTMLButtonElement>;

  for (const id of TAB_IDS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = LABELS[id];
    btn.className = "tab-bar-item";
    btn.dataset.tab = id;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", id === initial ? "true" : "false");
    btn.addEventListener("click", () => api.setActive(id));
    host.appendChild(btn);
    buttons[id] = btn;
  }

  const apply = (): void => {
    for (const id of TAB_IDS) {
      const isActive = id === active;
      buttons[id].classList.toggle("is-active", isActive);
      buttons[id].setAttribute("aria-selected", isActive ? "true" : "false");
    }
  };

  const api: TabBarApi = {
    setActive(tab) {
      if (tab === active) return;
      active = tab;
      apply();
      onChange(tab);
    },
    getActive: () => active,
  };

  apply();
  return api;
}
