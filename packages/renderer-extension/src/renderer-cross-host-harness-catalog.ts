import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";

/** Snapshot from the renderer binding probe, which owns per-Host availability. */
export interface CrossHostHarnessDirectory {
  plugins: readonly HarnessPluginDescriptor[] | null;
  availability: Readonly<Record<string, string | undefined>>;
  error: string | null;
}

/** Desktop's own name for this Mac, matching the folder bar. */
export function localMachineLabel(locale: string): string {
  return locale === "zh-CN" ? "此计算机" : "This computer";
}
