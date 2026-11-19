import { stat } from "node:fs/promises";
import path from "node:path";

import type { DesktopProjectCatalogReader } from "./desktop-project-catalog.js";

/** Resolve the current local catalog entry before any DingTalk write. */
export async function readDingTalkDispatchProject(
  catalog: Pick<DesktopProjectCatalogReader, "read">,
  projectId: string,
  readNativeProject: (id: string) => Promise<{ id: string; roots: string[] }>,
): Promise<{ projectId: string; cwd: string; roots: string[] }> {
  const current = await catalog.read({ fresh: true }).catch(() => {
    throw new Error("无法读取工作项目，请在智能体设置里重新选择");
  });
  const project = current.localProjects[projectId];
  if (!project) throw new Error("工作项目已不存在，请在智能体设置里重新选择");
  const roots = [...new Set(project.rootPaths)];
  const cwd = roots[0];
  if (!cwd) throw new Error("工作项目没有可用目录，请在智能体设置里重新选择");
  const valid = await Promise.all(
    roots.map(async (root) =>
      path.isAbsolute(root) && !root.includes("\0")
        ? stat(root).then(
            (entry) => entry.isDirectory(),
            () => false,
          )
        : false,
    ),
  );
  if (valid.some((exists) => !exists)) {
    throw new Error("工作项目目录已不存在或无法访问，请在智能体设置里重新选择");
  }
  const nativeId = current.appServerProjectIds?.[projectId] ?? projectId;
  const native = await readNativeProject(nativeId).catch(() => {
    throw new Error("工作项目尚未与 Desktop 同步，请在智能体设置里重新选择");
  });
  if (
    native.id !== nativeId ||
    roots.length !== native.roots.length ||
    roots.some((root, index) => root !== native.roots[index])
  ) {
    throw new Error("工作项目目录尚未与 Desktop 同步，请稍后重新选择");
  }
  return { projectId: nativeId, cwd, roots };
}
