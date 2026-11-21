import type {
  IpcErrorCode,
  IpcErrorDetails,
  IpcResult,
} from "@bpg/contracts/ipc";

/** Structural subset of Electron's IpcMainInvokeEvent, so this stays testable. */
export interface IpcEventLike {
  readonly sender: { readonly mainFrame: unknown };
  readonly senderFrame: { readonly url: string } | null;
}

export interface SenderPolicy {
  /** The one webContents allowed to call privileged handlers (evaluated per call). */
  expectedSender(): unknown;
  /** True when the frame URL is the app's own renderer. */
  isAllowedUrl(url: string): boolean;
}

/**
 * Sender must be the app window's webContents, the call must come from its
 * top-level frame (not an iframe) and that frame must still be on our renderer
 * URL (dev server origin, or the packaged index.html).
 */
export function isTrustedSender(
  event: IpcEventLike,
  policy: SenderPolicy,
): boolean {
  const expected = policy.expectedSender();
  if (expected === null || expected === undefined) return false;
  if (event.sender !== expected) return false;

  const frame = event.senderFrame;
  if (frame === null || frame !== event.sender.mainFrame) return false;

  return policy.isAllowedUrl(frame.url);
}

/** Matches the renderer URL: dev server origin, or the packaged index.html file. */
export function createRendererUrlMatcher(options: {
  devUrl: string | undefined;
  rendererFileUrl: string;
}): (url: string) => boolean {
  const { devUrl, rendererFileUrl } = options;
  const devOrigin = devUrl ? new URL(devUrl).origin : null;
  const fileTarget = new URL(rendererFileUrl);

  return (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (devOrigin !== null) return parsed.origin === devOrigin;
    return (
      parsed.protocol === "file:" &&
      parsed.host === fileTarget.host &&
      parsed.pathname === fileTarget.pathname
    );
  };
}

/** Structural Zod-compatible schema; avoids a direct zod dependency in the app. */
export interface InputSchema<I> {
  safeParse(value: unknown): { success: true; data: I } | { success: false };
}

/** Throw from a handler to return a specific, already-safe error to the renderer. */
export class IpcFailure extends Error {
  readonly code: IpcErrorCode;
  readonly details: IpcErrorDetails | undefined;

  constructor(code: IpcErrorCode, message: string, details?: IpcErrorDetails) {
    super(message);
    this.name = "IpcFailure";
    this.code = code;
    this.details = details;
  }
}

const fail = (
  code: IpcErrorCode,
  message: string,
  details?: IpcErrorDetails,
): IpcResult<never> => ({
  ok: false,
  error: details ? { code, message, details } : { code, message },
});

/**
 * Wraps a privileged handler: sender check -> exactly-one-argument + Zod
 * validation -> handler -> error mapping. The handler never runs on rejected
 * input, and no stack trace or raw error message leaves this function.
 */
export function createTrustedHandler<I, O>(options: {
  policy: SenderPolicy;
  schema: InputSchema<I>;
  handle: (input: I) => Promise<O> | O;
}): (event: IpcEventLike, ...args: unknown[]) => Promise<IpcResult<O>> {
  const { policy, schema, handle } = options;

  return async (event, ...args) => {
    let trusted = false;
    try {
      trusted = isTrustedSender(event, policy);
    } catch {
      // e.g. a destroyed webContents: fail closed with a generic error.
    }
    if (!trusted) {
      return fail("FORBIDDEN", "IPC sender not authorized");
    }
    if (args.length > 1) {
      return fail("INVALID_INPUT", "Invalid request payload");
    }
    const parsed = schema.safeParse(args[0]);
    if (!parsed.success) {
      return fail("INVALID_INPUT", "Invalid request payload");
    }

    try {
      return { ok: true, data: await handle(parsed.data) };
    } catch (error: unknown) {
      if (error instanceof IpcFailure) {
        return fail(error.code, error.message, error.details);
      }
      // Log the error class only: messages may echo connection parameters.
      console.error(
        "IPC handler failed:",
        error instanceof Error ? error.name : typeof error,
      );
      return fail("INTERNAL", "Internal error");
    }
  };
}
