import type { ProviderCatalog } from "./types.js";

/** Cursor Composer models for the cursor agent type. */
export const CURSOR_CATALOG: ProviderCatalog = {
  provider: "cursor",
  label: "Cursor Composer",
  modelField: "cursorModel",
  models: [
    {
      id: "composer-2.5",
      label: "Composer 2.5",
      family: "composer",
      latest: true,
      source: "baseline",
    },
    {
      id: "composer-2-fast",
      label: "Composer 2 Fast",
      family: "composer",
      source: "baseline",
    },
  ],
  aliases: {
    "composer-2.5-standard": "composer-2.5",
    "composer-2.5-fast": "composer-2.5",
  },
  options: [],
  liveRefreshSupported: false,
};
