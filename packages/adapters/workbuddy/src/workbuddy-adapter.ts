import {
  CodeBuddyAcpClient,
  CodeBuddyAdapter,
  type CodeBuddyAdapterOptions,
  type CodeBuddyInvocationFactory,
} from "@codexhost/adapter-codebuddy";
import type {
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessInspectionSchema } from "@codexhost/shared-contracts";
import { workBuddyInvocation } from "./command.js";
import { WORKBUDDY_RUNTIME_PROFILE } from "./common.js";
import {
  loadWorkBuddyProductModels,
  mergeWorkBuddyProductModels,
  type WorkBuddyProductModel,
} from "./product-models.js";

export type WorkBuddyAdapterOptions = Omit<
  CodeBuddyAdapterOptions,
  "profile" | "invocationFactory"
> & {
  productModels?: () => Promise<readonly WorkBuddyProductModel[]>;
  platform?: NodeJS.Platform;
};

export class WorkBuddyAdapter extends CodeBuddyAdapter {
  readonly #productModels: () => Promise<readonly WorkBuddyProductModel[]>;

  constructor(options: WorkBuddyAdapterOptions = {}) {
    const { productModels, platform = process.platform, ...codeBuddyOptions } = options;
    const environment = { ...(codeBuddyOptions.environment ?? process.env) };
    const windowsProfile = {
      ...WORKBUDDY_RUNTIME_PROFILE,
      allowUnlistedModelSelection: true,
    };
    const invocation: CodeBuddyInvocationFactory = (env, ephemeral, args) =>
      workBuddyInvocation(env, ephemeral, args);
    super({
      ...codeBuddyOptions,
      profile: platform === "win32" ? windowsProfile : WORKBUDDY_RUNTIME_PROFILE,
      invocationFactory: invocation,
      clientFactory:
        codeBuddyOptions.clientFactory ??
        ((clientOptions) => new CodeBuddyAcpClient(clientOptions, undefined, invocation)),
    });
    this.#productModels =
      platform === "win32"
        ? (productModels ?? (() => loadWorkBuddyProductModels(environment)))
        : async () => [];
  }

  override async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    const inspection = await super.inspect(input);
    if (inspection.status !== "ready") return inspection;
    const productModels = await this.#productModels().catch(() => []);
    if (productModels.length === 0) return inspection;
    return harnessInspectionSchema.parse({
      ...inspection,
      catalog: mergeWorkBuddyProductModels(inspection.catalog, productModels),
    });
  }

  override async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (
      input.kind === "create" &&
      input.executionPolicy === "unattended-full-access" &&
      input.permissionModeId &&
      input.permissionModeId !== "fullAccess"
    ) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "WorkBuddy: unattended execution requires native fullAccess permissions",
          retryable: false,
        },
      };
    }
    return super.open(input);
  }
}
