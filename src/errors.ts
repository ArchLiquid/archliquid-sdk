export type OwnedSdkErrorCode =
  | "invalid_input"
  | "wrong_cluster"
  | "missing_account"
  | "stale_context"
  | "invalid_snapshot"
  | "rpc_error"
  | "aborted"
  | "timeout"
  | "invalid_serialization"
  | "quote_mismatch";

/** Stable error codes for the optional integration APIs. Legacy math errors are unchanged. */
export class OwnedSdkError extends Error {
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    readonly code: OwnedSdkErrorCode,
    message: string,
    options: Readonly<{ cause?: unknown; context?: Readonly<Record<string, unknown>> }> = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OwnedSdkError";
    this.context = Object.freeze({ ...options.context });
  }
}
