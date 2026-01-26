import { createRequire } from "module";

/**
 * Result of Yellowstone native binding check
 */
export interface YellowstonePreflightResult {
  ok: boolean;
  reason?: string;
}

/**
 * Checks if Yellowstone native bindings are available.
 * 
 * This preflight check attempts to load @triton-one/yellowstone-grpc
 * and detects native binding failures that commonly occur on Windows.
 * 
 * @returns Result indicating if native bindings are available
 */
export function checkYellowstoneNativeBinding(): YellowstonePreflightResult {
  try {
    // In ESM context, use createRequire to access require()
    const require = createRequire(import.meta.url);
    
    // Attempt to load the Yellowstone gRPC module
    require("@triton-one/yellowstone-grpc");
    
    return { ok: true };
  } catch (err) {
    // Check if this is a native binding error
    const errorMessage = err instanceof Error ? err.message : String(err);
    
    if (
      errorMessage.includes("Cannot find native binding") ||
      errorMessage.includes("yellowstone-grpc-napi")
    ) {
      return {
        ok: false,
        reason: "Native bindings for @triton-one/yellowstone-grpc are not available. " +
                "On Windows: (1) Delete node_modules and package-lock.json, then run 'npm install', " +
                "or (2) Use WSL2: 'npm run snapshot:obligations:wsl'. " +
                "Production deployments should target Linux."
      };
    }
    
    // Some other error occurred
    return {
      ok: false,
      reason: `Failed to load @triton-one/yellowstone-grpc: ${errorMessage}`
    };
  }
}
