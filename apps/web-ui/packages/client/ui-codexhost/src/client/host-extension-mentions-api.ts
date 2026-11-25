import {
  HOST_EXTENSIONS_RPC,
  type HostExtensionsRpcParams,
  type HostExtensionsRpcResult,
} from "@codexhost/shared-contracts";
import { callHostExtensionsRpc } from "./native-extensions/rpc.ts";

export function searchHostExtensionMentions(
  input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.mentionsSearch>,
  signal?: AbortSignal,
): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.mentionsSearch>> {
  return callHostExtensionsRpc(HOST_EXTENSIONS_RPC.mentionsSearch, input, signal);
}

export function cancelHostExtensionMentionSearch(
  input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.mentionsCancel>,
): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.mentionsCancel>> {
  return callHostExtensionsRpc(HOST_EXTENSIONS_RPC.mentionsCancel, input);
}
