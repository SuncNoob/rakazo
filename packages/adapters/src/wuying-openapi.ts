import { createHmac, randomUUID } from "node:crypto";
import { SandboxRateLimitError, SandboxUnresponsiveError } from "@rakazo/adapter-kit";

/** Desktop states the ECD API reports; anything else is treated as in transition. */
export type WuyingDesktopStatus =
  | "Running"
  | "Stopped"
  | "Starting"
  | "Stopping"
  | "Pending"
  | "Expired"
  | "Deleted"
  | (string & {});

export interface WuyingOpenApiConfig {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
  fetch?: typeof globalThis.fetch;
}

/** The control-plane calls a Wuying computer needs: its state, power and screen login. */
export interface WuyingControlPlane {
  desktopStatus(desktopId: string, signal: AbortSignal): Promise<WuyingDesktopStatus | null>;
  startDesktop(desktopId: string, signal: AbortSignal): Promise<void>;
  stopDesktop(desktopId: string, signal: AbortSignal): Promise<void>;
  /** A one-time, short-lived code the Web SDK exchanges for a screen connection. */
  authCode(endUserId: string, signal: AbortSignal): Promise<string>;
}

const ECD_VERSION = "2020-09-30";
const APPSTREAM_VERSION = "2021-02-18";
const REQUEST_TIMEOUT_MS = 15_000;

/** Alibaba Cloud RPC percent-encoding (RFC 3986, with `*` and `~` adjusted). */
function percentEncode(value: string) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, "~");
}

/** RPC signature version 1.0 over the sorted query of a GET request. */
export function signRpcQuery(params: Record<string, string>, accessKeySecret: string) {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key] ?? "")}`)
    .join("&");
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonical)}`;
  return createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
}

export class WuyingOpenApi implements WuyingControlPlane {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly config: WuyingOpenApiConfig) {
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  async desktopStatus(desktopId: string, signal: AbortSignal) {
    const body = await this.call<{ Desktops?: { DesktopId?: string; DesktopStatus?: string }[] }>(
      "ecd",
      ECD_VERSION,
      "DescribeDesktops",
      { "DesktopId.1": desktopId },
      signal,
    );
    const desktop = body.Desktops?.find((entry) => entry.DesktopId === desktopId);
    return desktop?.DesktopStatus ?? null;
  }

  async startDesktop(desktopId: string, signal: AbortSignal) {
    await this.call("ecd", ECD_VERSION, "StartDesktops", { "DesktopId.1": desktopId }, signal);
  }

  async stopDesktop(desktopId: string, signal: AbortSignal) {
    await this.call("ecd", ECD_VERSION, "StopDesktops", { "DesktopId.1": desktopId }, signal);
  }

  async authCode(endUserId: string, signal: AbortSignal) {
    const body = await this.call<{ AuthModel?: { AuthCode?: string } }>(
      "appstream-center",
      APPSTREAM_VERSION,
      "GetAuthCode",
      { EndUserId: endUserId },
      signal,
    );
    const code = body.AuthModel?.AuthCode;
    if (!code) throw new SandboxUnresponsiveError("Wuying returned no screen login code");
    return code;
  }

  private endpoint(product: "ecd" | "appstream-center") {
    return product === "ecd"
      ? `https://ecd.${this.config.regionId}.aliyuncs.com/`
      : "https://appstream-center.aliyuncs.com/";
  }

  private async call<T>(
    product: "ecd" | "appstream-center",
    version: string,
    action: string,
    params: Record<string, string>,
    signal: AbortSignal,
  ): Promise<T> {
    const query: Record<string, string> = {
      ...params,
      Action: action,
      Version: version,
      Format: "JSON",
      RegionId: this.config.regionId,
      AccessKeyId: this.config.accessKeyId,
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      SignatureNonce: randomUUID(),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    query.Signature = signRpcQuery(query, this.config.accessKeySecret);
    const url = `${this.endpoint(product)}?${new URLSearchParams(query).toString()}`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new SandboxUnresponsiveError(`Wuying ${action} could not be reached`, {
        cause: error,
      });
    }
    const body = (await response.json().catch(() => ({}))) as T & {
      Code?: string;
      Message?: string;
    };
    if (response.ok) return body;
    if (response.status === 429 || /^Throttling/.test(body.Code ?? "")) {
      throw new SandboxRateLimitError({ cause: new Error(body.Code ?? "Throttling") });
    }
    // Never include the request URL: it carries the AccessKey id and signature.
    const error = new Error(`Wuying ${action} failed: ${body.Code ?? response.status}`);
    if (/^InvalidDesktop|DesktopNotFound|NotFound/.test(body.Code ?? "")) {
      error.name = "SandboxNotFoundError";
      throw error;
    }
    if (response.status >= 500) {
      throw new SandboxUnresponsiveError(error.message, { cause: error });
    }
    throw error;
  }
}
