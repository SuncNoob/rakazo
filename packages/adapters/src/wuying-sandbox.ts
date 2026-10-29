import { setTimeout as sleep } from "node:timers/promises";
import type {
  AdapterContext,
  CommandRequest,
  ComputerAction,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  WorkspaceDirectoryRequest,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import {
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  WorkspaceTooLargeError,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { boundedComputerActions, computerObservation } from "./computer-support.js";
import { normalizeDesktopWorkspacePath } from "./desktop-sandbox-paths.js";
import { McpSession } from "./mcp-transport.js";
import type { WuyingControlPlane } from "./wuying-openapi.js";
import { WuyingOpenApi } from "./wuying-openapi.js";

/** The tool namespace the desktop's MCP gateway serves its native system tools under. */
const SYSTEM_TOOLS = "wuying-system-tool__";
const START_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 120_000;
const POLL_MS = 3_000;
// The gateway's response budget: reads of at most 32 KiB, command output of at most 16 KiB and
// commands of at most one minute per call.
const READ_CHUNK_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const LIST_LIMIT = 1_000;
const OUTPUT_LIMIT = 16 * 1024;
const MAX_COMMAND_MS = 60_000;
const HOME_KEY = /^[A-Za-z0-9_-]+$/;
/** Windows has no executable bit, so each home records which of its files carry one. */
const EXECUTABLES_FILE = ".rakazo-executables.json";

/** A tool the gateway ran and refused, with the gateway's error code such as `not_found`. */
export class WuyingToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "WuyingToolError";
  }
}

export interface WuyingToolResult {
  data: unknown;
  images: { data: string; mimeType: string }[];
}

/** Calls one native system tool on the desktop, such as `process_exec` or `screen_capture`. */
export interface WuyingDesktopTools {
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<WuyingToolResult>;
}

export interface WuyingSandboxOptions {
  accessKeyId: string;
  accessKeySecret: string;
  regionId?: string;
  desktopId: string;
  endUserId: string;
  mcpUrl: string;
  mcpToken: string;
}

export function describeWuyingSandbox() {
  return {
    id: "wuying",
    contractVersion: "1",
    adapterVersion: "0.1.0",
    capabilities: {
      graphical: true,
      pty: false,
      snapshots: false,
      takeover: true,
      persistentHome: true,
      multiScreen: false,
    },
  };
}

/** One MCP session to the desktop's gateway, opened on first use and reopened after a failure. */
export class WuyingMcpTools implements WuyingDesktopTools {
  private session?: Promise<McpSession>;

  constructor(private readonly options: { url: string; token: string }) {}

  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal) {
    const session = await this.connect(signal);
    let result: Awaited<ReturnType<McpSession["callTool"]>>;
    try {
      result = await session.callTool(`${SYSTEM_TOOLS}${tool}`, args, { signal });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      this.reset(session);
      throw new SandboxUnresponsiveError(`The computer did not answer ${tool}`, { cause: error });
    }
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n")
      .trim();
    const structured = result.structuredContent as
      | { data?: unknown; error?: { code?: string; message?: string } }
      | undefined;
    if (result.isError || structured?.error) {
      const message = structured?.error?.message ?? (text.slice(0, 500) || "failed");
      throw new WuyingToolError(tool, structured?.error?.code, `${tool}: ${message}`);
    }
    return {
      data: structured?.data ?? parseData(text),
      images: content.flatMap((item) =>
        item.type === "image" ? [{ data: item.data, mimeType: item.mimeType }] : [],
      ),
    };
  }

  private connect(signal: AbortSignal) {
    this.session ??= (async () => {
      const session = new McpSession({ name: "rakazo-wuying" });
      await session.connectRemote({
        url: this.options.url,
        headerPolicy: { headers: { Authorization: `Bearer ${this.options.token}` } },
        signal,
      });
      return session;
    })();
    const pending = this.session;
    pending.catch(() => {
      if (this.session === pending) this.session = undefined;
    });
    return pending;
  }

  private reset(session: McpSession) {
    void session.close();
    this.session = undefined;
  }
}

/**
 * The gateway reads output as UTF-8, while Windows consoles default to the system code page
 * (GBK on Chinese systems). PowerShell commands switch their output to UTF-8 first.
 */
function utf8Output(argv: string[]): string[] {
  const command = argv.indexOf("-Command");
  if (!/^(powershell|pwsh)(\.exe)?$/i.test(argv[0] ?? "") || command < 0) return argv;
  if (command + 1 >= argv.length) return argv;
  const next = [...argv];
  next[command + 1] =
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;${argv[command + 1]}`;
  return next;
}

function parseData(text: string): unknown {
  try {
    return (JSON.parse(text) as { data?: unknown }).data;
  } catch {
    return undefined;
  }
}

interface ScreenScale {
  x: number;
  y: number;
}

interface PointerDown {
  x: number;
  y: number;
  button: "left" | "right";
}

/**
 * A bot computer on one Wuying cloud desktop. The ECD control plane powers it on and off and
 * issues screen logins; commands, files, screen and input go through the desktop's MCP gateway.
 * The desktop's disk persists, so each computer's home is a folder under the user profile.
 */
export class WuyingSandboxProvider implements SandboxProvider {
  private profile?: Promise<string>;
  private readonly scales = new Map<string, ScreenScale>();
  private readonly pointers = new Map<string, PointerDown>();

  constructor(
    private readonly options: Pick<WuyingSandboxOptions, "desktopId" | "endUserId"> & {
      regionId: string;
    },
    private readonly control: WuyingControlPlane,
    private readonly tools: WuyingDesktopTools,
  ) {}

  static fromOptions(options: WuyingSandboxOptions) {
    const regionId = options.regionId?.trim() || "cn-hangzhou";
    return new WuyingSandboxProvider(
      { desktopId: options.desktopId, endUserId: options.endUserId, regionId },
      new WuyingOpenApi({
        accessKeyId: options.accessKeyId,
        accessKeySecret: options.accessKeySecret,
        regionId,
      }),
      new WuyingMcpTools({ url: options.mcpUrl, token: options.mcpToken }),
    );
  }

  describe() {
    return describeWuyingSandbox();
  }

  billsWhileRunning() {
    return true;
  }

  async provision(
    request: { botId: string; homePath: string; providerRef?: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    if (!HOME_KEY.test(request.botId)) throw new Error("computer home key is not portable");
    const started = await this.ensureRunning(context.signal);
    const home = await this.home(request.botId, context.signal);
    const existed = await this.exists(home, context.signal);
    return {
      id: this.options.desktopId,
      botId: request.botId,
      kind: "wuying",
      providerRef: this.options.desktopId,
      // A reference to another desktop (the configured one changed) starts over in this one.
      fresh:
        !existed ||
        (request.providerRef !== undefined && request.providerRef !== this.options.desktopId),
      started,
    };
  }

  /** Commands run to completion inside process_exec, so nothing is left running in the background. */
  async inspectBackgroundWork(): Promise<"idle"> {
    return "idle";
  }

  /** process_exec bounds every command by its timeout; there is no detached run work to stop. */
  async cancelRunWork() {}

  async isRunning(computer: ComputerRef, context: AdapterContext) {
    if (computer.providerRef !== this.options.desktopId) return false;
    return (await this.control.desktopStatus(this.options.desktopId, context.signal)) === "Running";
  }

  async isStopped(computer: ComputerRef, context: AdapterContext) {
    if (computer.providerRef !== this.options.desktopId) return false;
    return (await this.control.desktopStatus(this.options.desktopId, context.signal)) === "Stopped";
  }

  async prepare(computer: ComputerRef, context: AdapterContext) {
    await this.mkdirs(await this.home(computer.botId, context.signal), context.signal);
  }

  async environment(computer: ComputerRef, context: AdapterContext) {
    return {
      platform: "win32",
      home: await this.home(computer.botId, context.signal),
      shell: "powershell.exe",
    };
  }

  async workspaceDirectories(
    computer: ComputerRef,
    request: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ): Promise<string[]> {
    if (request.action === "ensure") {
      for (const directory of request.paths) {
        await this.mkdirs(await this.target(computer, directory, context.signal), context.signal);
      }
      return [];
    }
    const parents = request.action === "list" ? ["bots", ".browser-profiles"] : [request.parent];
    const entries: string[] = [];
    for (const parent of parents) {
      if (parent !== "bots" && parent !== ".browser-profiles")
        throw new Error("Path escapes the computer workspace");
      const directory = await this.target(computer, parent, context.signal);
      if (!(await this.exists(directory, context.signal))) continue;
      if (request.action === "list") {
        for (const entry of await this.list(directory, context.signal))
          entries.push(`${parent}/${entry.name}`);
        continue;
      }
      const pattern = parent === "bots" ? /^[A-Za-z0-9_-]+$/ : /^chromium-bot-[0-9a-f]{32}$/;
      if (request.names.some((name) => !pattern.test(name)))
        throw new Error("Path escapes the computer workspace");
      for (const name of request.names) {
        await this.tools.call(
          "fs_delete",
          { path: `${directory}\\${name}`, recursive: true },
          context.signal,
        );
      }
    }
    return entries;
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const [program, ...args] = utf8Output(
      request.argv.length ? request.argv : ["cmd.exe", "/c", "echo ready"],
    );
    const cwd = request.cwd
      ? await this.target(computer, request.cwd, context.signal)
      : await this.home(computer.botId, context.signal);
    await this.mkdirs(cwd, context.signal);
    const env = { ...request.env };
    // The gateway's environment overlay has no unset; an empty value is the closest it offers.
    for (const name of request.unsetEnv ?? []) env[name] = "";
    const { data } = await this.tools.call(
      "process_exec",
      {
        program,
        args,
        cwd,
        env,
        output_limit: OUTPUT_LIMIT,
        timeout_ms: Math.min(boundedSandboxCommandTimeoutMs(request.timeoutMs), MAX_COMMAND_MS),
      },
      context.signal,
    );
    const result = data as {
      stdout?: string;
      stderr?: string;
      exit_code?: number | null;
      status?: string;
      truncated?: boolean;
    };
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    if (result.truncated) yield { type: "stderr", data: "\n[output truncated at 16 KiB]\n" };
    if (result.status === "timed_out" || result.status === "timeout") {
      yield { type: "stderr", data: "command timed out" };
      yield { type: "exit", code: 124 };
      return;
    }
    yield { type: "exit", code: typeof result.exit_code === "number" ? result.exit_code : 1 };
  }

  /**
   * The Web SDK in the app's own page draws the screen, so the session is a `wuying:` reference
   * the app turns into that page. The login code inside it works once and expires in minutes.
   */
  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    if (computer.providerRef !== this.options.desktopId) return this.noScreen();
    const authCode = await this.control.authCode(this.options.endUserId, context.signal);
    const url = new URL("wuying://desktop");
    url.searchParams.set("desktop_id", this.options.desktopId);
    url.searchParams.set("region_id", this.options.regionId);
    url.searchParams.set("auth_code", authCode);
    return { url: url.toString(), mimeType: "text/html", close: async () => undefined };
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    await this.apply(computer, input, context.signal);
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const [capture, cursor, active] = await Promise.all([
      this.tools.call("screen_capture", {}, context.signal),
      this.tools.call("cursor_position", {}, context.signal).catch(() => undefined),
      this.tools.call("window_active", {}, context.signal).catch(() => undefined),
    ]);
    const image = capture.images[0];
    const info = capture.data as {
      image?: { width?: number; height?: number };
      source?: { width?: number; height?: number };
    };
    if (!image) throw new SandboxUnresponsiveError("The computer returned no screenshot");
    const width = info.image?.width ?? info.source?.width ?? 1;
    const height = info.image?.height ?? info.source?.height ?? 1;
    // The preview may be scaled down; actions arrive in its coordinates and map back here.
    const scale = {
      x: (info.source?.width ?? width) / width,
      y: (info.source?.height ?? height) / height,
    };
    this.scales.set(computer.providerRef, scale);
    const point = cursor?.data as { x?: number; y?: number } | undefined;
    const window = active?.data as { window_id?: string; title?: string } | undefined;
    return computerObservation(Uint8Array.from(Buffer.from(image.data, "base64")), {
      mimeType: image.mimeType === "image/png" ? "image/png" : "image/jpeg",
      width,
      height,
      ...(typeof point?.x === "number" && typeof point.y === "number"
        ? { cursor: { x: Math.round(point.x / scale.x), y: Math.round(point.y / scale.y) } }
        : {}),
      ...(window?.window_id
        ? {
            activeWindow: {
              id: window.window_id,
              ...(window.title ? { title: window.title } : {}),
            },
          }
        : {}),
    });
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const actions = boundedComputerActions(request.actions);
    for (const action of actions) await this.apply(computer, action, context.signal);
    if (request.observe === false) return { completed: actions.length };
    if (request.settleMs) await sleep(Math.min(request.settleMs, 5_000), undefined, context);
    return { completed: actions.length, observation: await this.observe(computer, context) };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const relative = normalizeDesktopWorkspacePath(directory, "win32");
    const target = await this.target(computer, relative, context.signal);
    const executables = await this.executables(computer, context.signal);
    return (await this.list(target, context.signal)).flatMap((entry) => {
      if (!relative && entry.name === EXECUTABLES_FILE) return [];
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      return [
        {
          path,
          kind: entry.kind,
          size: entry.size,
          ...(entry.kind === "file" && executables.has(path) ? { executable: true } : {}),
        },
      ];
    });
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const target = await this.target(computer, filePath, context.signal);
    const limit = Math.min(options?.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES);
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const { data } = await this.tools.call(
        "fs_read",
        { path: target, encoding: "base64", offset, max_bytes: READ_CHUNK_BYTES },
        context.signal,
      );
      const read = data as {
        data?: string;
        bytes_read?: number;
        size?: number;
        truncated?: boolean;
      };
      if ((read.size ?? 0) > limit) throw new Error(`computer file exceeds ${limit} bytes`);
      const chunk = Buffer.from(read.data ?? "", "base64");
      chunks.push(chunk);
      offset += chunk.length;
      if (!read.truncated || chunk.length === 0) break;
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    if (file.content.byteLength > MAX_FILE_BYTES)
      throw new Error(`computer file exceeds ${MAX_FILE_BYTES} bytes`);
    const target = await this.target(computer, file.path, context.signal);
    await this.mkdirs(target.slice(0, target.lastIndexOf("\\")), context.signal);
    await this.tools.call(
      "fs_write",
      {
        path: target,
        data: Buffer.from(file.content).toString("base64"),
        encoding: "base64",
        overwrite: true,
      },
      context.signal,
    );
    const path = normalizeDesktopWorkspacePath(file.path, "win32");
    const executables = await this.executables(computer, context.signal);
    if (executables.has(path) === Boolean(file.executable)) return;
    if (file.executable) executables.add(path);
    else executables.delete(path);
    await this.tools.call(
      "fs_write",
      {
        path: await this.target(computer, EXECUTABLES_FILE, context.signal),
        data: JSON.stringify([...executables].sort()),
        encoding: "utf8",
        overwrite: true,
      },
      context.signal,
    );
  }

  private async executables(computer: ComputerRef, signal: AbortSignal) {
    const manifest = await this.target(computer, EXECUTABLES_FILE, signal);
    if (!(await this.exists(manifest, signal))) return new Set<string>();
    const { data } = await this.tools.call(
      "fs_read",
      { path: manifest, encoding: "utf8", max_bytes: READ_CHUNK_BYTES },
      signal,
    );
    try {
      const parsed: unknown = JSON.parse((data as { data?: string }).data ?? "[]");
      return new Set(Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : []);
    } catch {
      return new Set<string>();
    }
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits?: WorkspaceExportLimits,
  ): AsyncIterable<PortableFile> {
    const files: ComputerFileEntry[] = [];
    let bytes = 0;
    const walk = async (relative: string) => {
      for (const entry of await this.listFiles(computer, relative, context)) {
        if (entry.kind === "dir") {
          await walk(entry.path);
          continue;
        }
        bytes += entry.size;
        files.push(entry);
        if (limits && bytes > limits.maxBytes) throw new WorkspaceTooLargeError("bytes");
        if (limits && files.length > limits.maxFiles) throw new WorkspaceTooLargeError("files");
      }
    };
    await walk("");
    for (const file of files) {
      yield {
        path: file.path,
        content: await this.readFile(computer, file.path, context),
        ...(file.executable ? { executable: true } : {}),
      };
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file, context);
  }

  async snapshot(): Promise<never> {
    throw new Error("Snapshots are not available on Wuying computers");
  }

  async stop(computer: ComputerRef, context: AdapterContext) {
    if (computer.providerRef !== this.options.desktopId) return;
    const status = await this.control.desktopStatus(this.options.desktopId, context.signal);
    if (status === "Stopped" || status === null) return;
    if (status !== "Stopping")
      await this.control.stopDesktop(this.options.desktopId, context.signal);
    await this.waitFor("Stopped", STOP_TIMEOUT_MS, context.signal);
  }

  /** The desktop belongs to the account, so only this computer's home folder is removed. */
  async destroy(computer: ComputerRef, context: AdapterContext) {
    if (computer.providerRef !== this.options.desktopId || !HOME_KEY.test(computer.botId)) return;
    const status = await this.control.desktopStatus(this.options.desktopId, context.signal);
    if (status !== "Running") return;
    const home = await this.home(computer.botId, context.signal);
    if (await this.exists(home, context.signal)) {
      await this.tools.call("fs_delete", { path: home, recursive: true }, context.signal);
    }
  }

  private noScreen(): ScreenSession {
    return { url: null, mimeType: "text/html", close: async () => undefined };
  }

  /** Starts the desktop when it is off. True when this call started it. */
  private async ensureRunning(signal: AbortSignal) {
    const status = await this.control.desktopStatus(this.options.desktopId, signal);
    if (status === null) {
      const error = new Error("Wuying desktop not found");
      error.name = "SandboxNotFoundError";
      throw error;
    }
    if (status === "Running") return false;
    if (status === "Stopping") await this.waitFor("Stopped", STOP_TIMEOUT_MS, signal);
    if (status !== "Starting" && status !== "Pending")
      await this.control.startDesktop(this.options.desktopId, signal);
    await this.waitFor("Running", START_TIMEOUT_MS, signal);
    return true;
  }

  private async waitFor(wanted: "Running" | "Stopped", timeoutMs: number, signal: AbortSignal) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.control.desktopStatus(this.options.desktopId, signal)) === wanted) return;
      if (Date.now() >= deadline) throw new SandboxUnavailableError();
      await sleep(POLL_MS, undefined, { signal });
    }
  }

  private async home(homeKey: string, signal: AbortSignal) {
    if (!HOME_KEY.test(homeKey)) throw new Error("computer home key is not portable");
    return `${await this.userProfile(signal)}\\rakazo\\${homeKey}`;
  }

  private userProfile(signal: AbortSignal) {
    this.profile ??= this.tools
      .call("env_get", { name: "USERPROFILE" }, signal)
      .then(({ data }) => {
        const value = (data as { value?: string } | undefined)?.value;
        if (!value || !/^[A-Za-z]:\\/.test(value))
          throw new Error("The computer has no user profile folder");
        return value.replace(/\\+$/, "");
      });
    const pending = this.profile;
    pending.catch(() => {
      if (this.profile === pending) this.profile = undefined;
    });
    return pending;
  }

  /** A workspace-relative path as an absolute Windows path inside this computer's home. */
  private async target(computer: ComputerRef, relative: string, signal: AbortSignal) {
    const normalized = normalizeDesktopWorkspacePath(relative, "win32");
    const home = await this.home(computer.botId, signal);
    return normalized ? `${home}\\${normalized.replace(/\//g, "\\")}` : home;
  }

  private async exists(target: string, signal: AbortSignal) {
    try {
      await this.tools.call("fs_info", { path: target }, signal);
      return true;
    } catch (error) {
      if (error instanceof WuyingToolError && error.code === "not_found") return false;
      throw error;
    }
  }

  /** fs_mkdir makes one level, so walk down from the profile creating what is missing. */
  private async mkdirs(target: string, signal: AbortSignal) {
    if (await this.exists(target, signal)) return;
    const profile = await this.userProfile(signal);
    if (!target.toLowerCase().startsWith(`${profile.toLowerCase()}\\`))
      throw new Error("Path escapes the computer workspace");
    let current = profile;
    for (const segment of target.slice(profile.length + 1).split("\\")) {
      current = `${current}\\${segment}`;
      if (!(await this.exists(current, signal)))
        await this.tools.call("fs_mkdir", { path: current }, signal);
    }
  }

  private async list(directory: string, signal: AbortSignal) {
    const { data } = await this.tools.call(
      "fs_list",
      { path: directory, limit: LIST_LIMIT },
      signal,
    );
    const listing = data as {
      entries?: { kind?: string; path?: string; size?: number }[];
      truncated?: boolean;
    };
    if (listing.truncated) throw new Error(`computer folder has more than ${LIST_LIMIT} entries`);
    return (listing.entries ?? []).flatMap((entry) => {
      const name = entry.path?.split("\\").pop();
      if (!name || entry.kind === "symlink") return [];
      return [
        {
          name,
          kind: entry.kind === "directory" ? ("dir" as const) : ("file" as const),
          size: entry.kind === "directory" ? 0 : (entry.size ?? 0),
        },
      ];
    });
  }

  private native(computer: ComputerRef, x: number, y: number) {
    const scale = this.scales.get(computer.providerRef) ?? { x: 1, y: 1 };
    return { x: Math.round(x * scale.x), y: Math.round(y * scale.y) };
  }

  private async apply(computer: ComputerRef, action: ComputerAction, signal: AbortSignal) {
    if (action.kind === "wait") {
      await sleep(Math.min(Math.max(action.ms, 0), 5_000), undefined, { signal });
      return;
    }
    if (action.kind === "clipboard") {
      await this.tools.call("input_text", { text: action.text }, signal);
      return;
    }
    if (action.kind === "key") {
      // Modifiers cannot be held across calls, so a chord goes as one `ctrl+c` style key.
      const key = [...(action.modifiers ?? []), action.key].join("+");
      await this.tools.call("input_keyboard", { key, action: "press" }, signal);
      return;
    }
    if (action.kind === "pointer") {
      const at = this.native(computer, action.x, action.y);
      if (action.type === "down") {
        this.pointers.set(computer.providerRef, { ...at, button: action.button ?? "left" });
        await this.tools.call("input_mouse", { action: "move", ...at }, signal);
        return;
      }
      if (action.type === "up") {
        // The gateway has no separate button press and release; down then up is a drag or a click.
        const down = this.pointers.get(computer.providerRef);
        this.pointers.delete(computer.providerRef);
        const moved = down && (down.x !== at.x || down.y !== at.y);
        await this.tools.call(
          "input_mouse",
          moved
            ? { action: "drag", button: down.button, x: down.x, y: down.y, to_x: at.x, to_y: at.y }
            : { action: "click", button: down?.button ?? "left", ...at },
          signal,
        );
        return;
      }
      await this.tools.call(
        "input_mouse",
        action.type === "move"
          ? { action: "move", ...at }
          : { action: "click", button: action.button ?? "left", ...at },
        signal,
      );
      return;
    }
    if (action.kind === "scroll") {
      if (action.direction === "left" || action.direction === "right")
        throw new Error("Horizontal scrolling is not available on this computer");
      const amount = Math.max(1, Math.min(Math.round(action.amount ?? 3), 20));
      await this.tools.call(
        "input_mouse",
        {
          action: "scroll",
          scroll: action.direction === "up" ? amount : -amount,
          ...(action.x !== undefined && action.y !== undefined
            ? this.native(computer, action.x, action.y)
            : {}),
        },
        signal,
      );
      return;
    }
    if (action.kind === "open") {
      const target = await this.target(computer, action.path, signal);
      await this.tools.call("app_start", { program: "explorer.exe", args: [target] }, signal);
      return;
    }
    if (action.kind === "launch") {
      await this.tools.call(
        "app_start",
        { program: action.application, args: action.uri ? [action.uri] : [] },
        signal,
      );
      return;
    }
    const { data } = await this.tools.call("window_list", {}, signal);
    const wanted = action.application.toLowerCase();
    const windows =
      (data as { windows?: { window_id?: string; title?: string; visible?: boolean }[] }).windows ??
      [];
    const match = windows.find(
      (window) => window.visible !== false && window.title?.toLowerCase().includes(wanted),
    );
    if (match?.window_id) {
      await this.tools.call(
        "window_update",
        { window_id: match.window_id, action: "activate" },
        signal,
      );
      return;
    }
    await this.tools.call(
      "app_start",
      { program: action.application, args: action.uri ? [action.uri] : [] },
      signal,
    );
  }
}
