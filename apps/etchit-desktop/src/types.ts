export const TAB_IDS = ["etch", "private", "blogger", "website", "history", "wallet", "settings"] as const;
export type TabId = typeof TAB_IDS[number];
