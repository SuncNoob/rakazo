import type { WuyingControlPlane, WuyingDesktopStatus } from "./wuying-openapi.js";
import type { WuyingDesktopTools, WuyingToolResult } from "./wuying-sandbox.js";
import { WuyingSandboxProvider, WuyingToolError } from "./wuying-sandbox.js";

export const FAKE_PROFILE = "C:\\Users\\rakazo";
// A tiny real JPEG header is enough: the provider only forwards the bytes.
const SCREEN = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");

type Entry = { path: string } & ({ kind: "directory" } | { kind: "file"; content: Buffer });

/** An in-memory Windows desktop behind the gateway's system tools and the ECD control plane. */
export class FakeWuyingDesktop implements WuyingDesktopTools, WuyingControlPlane {
  status: WuyingDesktopStatus = "Running";
  readonly calls: { tool: string; args: Record<string, unknown> }[] = [];
  readonly control: string[] = [];
  /** Scripted result for the next process_exec, or the default `echo` behaviour. */
  exec?: (args: Record<string, unknown>) => Record<string, unknown>;
  private readonly files = new Map<string, Entry>();

  constructor() {
    for (const dir of ["C:", "C:\\Users", FAKE_PROFILE])
      this.files.set(key(dir), { path: dir, kind: "directory" });
  }

  provider() {
    return new WuyingSandboxProvider(
      { desktopId: "ecd-fake", endUserId: "end-user", regionId: "cn-hangzhou" },
      this,
      this,
    );
  }

  has(path: string) {
    return this.files.has(key(path));
  }

  read(path: string) {
    const entry = this.files.get(key(path));
    return entry?.kind === "file" ? entry.content : undefined;
  }

  async desktopStatus(): Promise<WuyingDesktopStatus | null> {
    return this.status;
  }

  async startDesktop() {
    this.control.push("start");
    this.status = "Running";
  }

  async stopDesktop() {
    this.control.push("stop");
    this.status = "Stopped";
  }

  async authCode() {
    this.control.push("authCode");
    return "one-time-code";
  }

  async call(tool: string, args: Record<string, unknown>): Promise<WuyingToolResult> {
    this.calls.push({ tool, args });
    if (this.status !== "Running") throw new WuyingToolError(tool, "unavailable", "desktop is off");
    const result = (data: unknown, images: WuyingToolResult["images"] = []) => ({ data, images });
    const path = typeof args.path === "string" ? args.path : "";
    switch (tool) {
      case "env_get":
        return result({ name: args.name, value: args.name === "USERPROFILE" ? FAKE_PROFILE : "" });
      case "fs_info": {
        const entry = this.files.get(key(path));
        if (!entry) throw new WuyingToolError(tool, "not_found", "entity not found");
        return result({ kind: entry.kind, path });
      }
      case "fs_mkdir":
        if (!this.files.has(key(parent(path))))
          throw new WuyingToolError(tool, "not_found", "parent missing");
        this.files.set(key(path), { path, kind: "directory" });
        return result({ path });
      case "fs_write": {
        if (!this.files.has(key(parent(path))))
          throw new WuyingToolError(tool, "not_found", "parent missing");
        if (this.files.has(key(path)) && args.overwrite !== true)
          throw new WuyingToolError(tool, "already_exists", "exists");
        const content =
          args.encoding === "base64"
            ? Buffer.from(String(args.data), "base64")
            : Buffer.from(String(args.data), "utf8");
        this.files.set(key(path), { path, kind: "file", content });
        return result({ path, bytes_written: content.length });
      }
      case "fs_read": {
        const entry = this.files.get(key(path));
        if (entry?.kind !== "file")
          throw new WuyingToolError(tool, "not_found", "entity not found");
        const offset = Number(args.offset ?? 0);
        const max = Number(args.max_bytes ?? 1024);
        const slice = entry.content.subarray(offset, offset + max);
        return result({
          data: slice.toString(args.encoding === "base64" ? "base64" : "utf8"),
          bytes_read: slice.length,
          size: entry.content.length,
          truncated: offset + slice.length < entry.content.length,
        });
      }
      case "fs_list": {
        if (this.files.get(key(path))?.kind !== "directory")
          throw new WuyingToolError(tool, "not_found", "entity not found");
        const prefix = `${key(path)}\\`;
        const entries = [...this.files]
          .filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes("\\"))
          .map(([, entry]) => ({
            kind: entry.kind,
            // The gateway answers with extended-length paths.
            path: `\\\\?\\${entry.path}`,
            size: entry.kind === "file" ? entry.content.length : 4096,
          }));
        return result({ entries, truncated: false });
      }
      case "fs_delete":
        for (const name of [...this.files.keys()]) {
          if (name === key(path) || (args.recursive && name.startsWith(`${key(path)}\\`)))
            this.files.delete(name);
        }
        return result({ path });
      case "process_exec": {
        if (this.exec) return result(this.exec(args));
        const argv = [String(args.program), ...((args.args as string[]) ?? [])];
        const echo = argv[0] === "echo" ? argv.slice(1).join(" ") : argv.at(-1);
        return result({ status: "completed", exit_code: 0, stdout: `${echo}\r\n`, stderr: "" });
      }
      case "screen_capture":
        return result(
          {
            image: { width: 1600, height: 1000, mime_type: "image/jpeg" },
            scaled: true,
            source: { width: 3200, height: 2000, x: 0, y: 0 },
          },
          [{ data: SCREEN, mimeType: "image/jpeg" }],
        );
      case "cursor_position":
        return result({ x: 800, y: 400 });
      case "window_active":
        return result({ window_id: "0x1", title: "Explorer" });
      case "window_list":
        return result({ windows: [{ window_id: "0x2", title: "xterm", visible: true }] });
      default:
        return result({});
    }
  }
}

function key(path: string) {
  return path.replace(/\\+$/, "").toLowerCase();
}

function parent(path: string) {
  return path.slice(0, path.lastIndexOf("\\"));
}
