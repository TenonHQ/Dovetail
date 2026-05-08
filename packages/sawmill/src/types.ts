/**
 * @tenonhq/dovetail-sawmill — type definitions.
 */

export interface SawmillApiConfig {
  instance: string;
  username: string;
  password: string;
}

export interface PromoteRequest {
  sourceInstance: string;
  updateSetName: string;
  commit: boolean;
  skipPreviewErrors?: string[];
}

export interface PreviewError {
  type: string;
  message: string;
  targetTable?: string;
  targetName?: string;
  sysId?: string;
}

export interface PromoteResponse {
  remoteUpdateSetSysId: string;
  previewErrors: PreviewError[];
  committed: boolean;
  elapsedMs: number;
}
