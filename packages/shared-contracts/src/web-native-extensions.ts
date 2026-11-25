import { z } from "zod";
import {
  desktopExtensionLocalizedTextSchema,
  type DesktopExtensionDispose,
} from "./desktop-extensions.js";
import type { HostExtensionMentionCandidate } from "./host-extensions.js";
import type { JsonObject, JsonValue } from "./json-value.js";

export const WEB_EXTENSION_REGIONS = ["app", "topbar", "sidebar", "conversation"] as const;
export type WebExtensionRegion = (typeof WEB_EXTENSION_REGIONS)[number];
export type WebExtensionDispose = DesktopExtensionDispose;
export type WebExtensionMount = {
  container: HTMLElement;
  dispose: () => void;
};
export type WebExtensionRender = (
  container: HTMLElement,
  signal: AbortSignal,
  /* eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Render may not need a disposer. */
) => void | WebExtensionDispose | Promise<void | WebExtensionDispose>;
export type WebExtensionContribution = {
  id: string;
  title: string | z.infer<typeof desktopExtensionLocalizedTextSchema>;
  render: WebExtensionRender;
};

export const webExtensionPanelGroupSchema = z.strictObject({
  id: z.string().trim().min(1),
  title: z.union([z.string().trim().min(1), desktopExtensionLocalizedTextSchema]),
});
export type WebExtensionPanelGroup = z.infer<typeof webExtensionPanelGroupSchema>;
export const webExtensionPanelBadgeCountSchema = z.number().int().nonnegative();
export type WebExtensionPanel = WebExtensionContribution &
  (
    | { placement: "main" | "sidebar"; groupId?: never; badgeCount?: never }
    | { placement: "main"; groupId: string; badgeCount?: number }
  );

export interface WebExtensionMentionPickerApi {
  readonly sourceId: string;
  /** Include this UUID in background jobs; the Host sends mentions/cancel on close. */
  readonly requestId: string;
  readonly initialQuery: string;
  readonly signal: AbortSignal;
  /** Atomically insert one or more mentions from this source; false if the draft is stale. */
  insert(items: readonly HostExtensionMentionCandidate[]): boolean;
  close(): void;
}
export type WebExtensionMentionPickerRender = (
  container: HTMLElement,
  api: WebExtensionMentionPickerApi,
  /* eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- A picker may not need a disposer. */
) => void | WebExtensionDispose | Promise<void | WebExtensionDispose>;

export interface WebExtensionApi {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly apiVersion: 1;
  dom: {
    /** HTMLElement parent or a stable data-cx-region value. Returns undefined if absent. */
    mount(
      target: HTMLElement | WebExtensionRegion,
      position?: "append" | "prepend",
    ): WebExtensionMount | undefined;
    mark(target: Element, name: string): void;
    unmark(target: Element, name: string): void;
  };
  track(dispose: WebExtensionDispose): void;
  assets: { url(path: string): string };
  storage: {
    get(): Promise<JsonObject>;
    set(values: JsonObject): Promise<JsonObject>;
    onChange(listener: (values: JsonObject) => void): () => void;
  };
  backend: { invoke(method: string, params?: JsonValue): Promise<JsonValue> };
  mentions: {
    registerPicker(sourceId: string, render: WebExtensionMentionPickerRender): () => void;
  };
  settings: { registerPage(page: WebExtensionContribution): () => void };
  panels: {
    registerGroup(group: WebExtensionPanelGroup): () => void;
    register(panel: WebExtensionPanel): () => void;
    setBadgeCount(panelId: string, count?: number): void;
  };
}
export interface WebExtensionModule {
  /* eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- A CSS/DOM-only extension may not need a disposer. */
  activate(api: WebExtensionApi): void | WebExtensionDispose | Promise<void | WebExtensionDispose>;
}
