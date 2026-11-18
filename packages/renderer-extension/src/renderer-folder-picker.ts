import { isCodexServiceRegistry, loadCodexNativeServices } from "./codex-native-services.js";

interface FolderPickerServices {
  fileAttachments: {
    pickFiles(input: {
      kind: "directory";
      allowMultiple: boolean;
      pickerTitle: string;
    }): Promise<unknown>;
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Individual Desktop services are callable RPC stubs; only the registry itself must be plain. */
const serviceStub = (value: unknown): value is object =>
  (typeof value === "object" || typeof value === "function") && value !== null;

function isFolderPickerServices(value: unknown): value is FolderPickerServices {
  // The RPC transport root answers every property read with a function, so accepting a
  // callable container would match both it and the real registry.
  if (!isCodexServiceRegistry(value)) return false;
  try {
    const fileAttachments = value.fileAttachments;
    return (
      serviceStub(fileAttachments) &&
      typeof (fileAttachments as { pickFiles?: unknown }).pickFiles === "function"
    );
  } catch {
    return false;
  }
}

/** Desktop's directory-only native dialog. Empty means canceled; null means unavailable. */
export async function pickDesktopFolders(
  ownerWindow: Window,
  importModule?: (url: string) => Promise<Record<string, unknown>>,
  options: { allowMultiple?: boolean; title?: string } = {},
): Promise<string[] | null> {
  try {
    const services = await loadCodexNativeServices(
      ownerWindow,
      isFolderPickerServices,
      importModule,
    );
    if (!services) return null;
    const picked = await services.fileAttachments.pickFiles({
      kind: "directory",
      allowMultiple: options.allowMultiple ?? true,
      pickerTitle: options.title ?? "选择工作文件夹",
    });
    if (!Array.isArray(picked)) return null;
    const paths: string[] = [];
    for (const entry of picked) {
      if (
        !record(entry) ||
        typeof entry.fsPath !== "string" ||
        !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(entry.fsPath)
      )
        return null;
      if (!paths.includes(entry.fsPath)) paths.push(entry.fsPath);
    }
    return paths;
  } catch {
    return null;
  }
}
