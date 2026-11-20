import { createJarvisService } from "./jarvis-service.js";
import { ModelServiceSettingsStore } from "./model-service-settings.js";
import { ModelService } from "./model-service.js";

export function desktopJarvisServices(environment: NodeJS.ProcessEnv, isLocalHost: boolean) {
  return {
    jarvis: createJarvisService({ environment, isLocalHost }),
    ...(isLocalHost
      ? { modelService: new ModelService(new ModelServiceSettingsStore({ environment })) }
      : {}),
  };
}
