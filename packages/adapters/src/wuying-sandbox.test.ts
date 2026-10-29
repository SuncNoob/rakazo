import type * as TimersPromises from "node:timers/promises";
import type { ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { isSandboxGoneError } from "./sandbox-errors.js";
import { assertSandboxWorkspaceContract, provisionPrepared } from "./sandbox-test-support.js";
import { signRpcQuery, WuyingOpenApi } from "./wuying-openapi.js";
import { quoteWindowsArgument } from "./wuying-sandbox.js";
import { FAKE_PROFILE, FakeWuyingDesktop } from "./wuying-sandbox.test-support.js";

// Power polling advances a virtual clock, so start and stop tests run instantly.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  setTimeout: async () => undefined,
}));

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

async function run(desktop: FakeWuyingDesktop, computer: ComputerRef, argv: string[]) {
  const events: ProcessEvent[] = [];
  // Within the gateway's one-minute call, a command runs through process_exec.
  for await (const event of desktop.provider().execute(computer, { argv, timeoutMs: 30_000 }, ctx))
    events.push(event);
  return events;
}

describe("WuyingSandboxProvider", () => {
  it("meets the shared workspace contract", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "portable", homePath: "/h" }, ctx);
    await assertSandboxWorkspaceContract(provider, computer, ctx);
  });

  it("keeps each computer's home in its own folder under the user profile", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot-a", homePath: "/h" }, ctx);
    expect(computer).toMatchObject({ kind: "wuying", providerRef: "ecd-fake", fresh: true });
    expect(desktop.has(`${FAKE_PROFILE}\\rakazo\\bot-a`)).toBe(true);
    expect(await provider.environment(computer, ctx)).toEqual({
      platform: "win32",
      home: `${FAKE_PROFILE}\\rakazo\\bot-a`,
      shell: "powershell.exe",
    });
    const again = await provider.provision({ botId: "bot-a", homePath: "/h" }, ctx);
    expect(again.fresh).toBe(false);
    await expect(provider.listFiles(computer, "../bot-b", ctx)).rejects.toThrow("escapes");
    await expect(provider.provision({ botId: "a/../b", homePath: "/h" }, ctx)).rejects.toThrow();
  });

  it("starts a stopped desktop and reports that it did", async () => {
    const desktop = new FakeWuyingDesktop();
    desktop.status = "Stopped";
    const computer = await desktop.provider().provision({ botId: "bot", homePath: "/h" }, ctx);
    expect(computer.started).toBe(true);
    expect(desktop.control).toEqual(["start"]);
    await desktop.provider().stop(computer, ctx);
    expect(desktop.status).toBe("Stopped");
  });

  it("treats a desktop the control plane no longer lists as gone", async () => {
    const desktop = new FakeWuyingDesktop();
    vi.spyOn(desktop, "desktopStatus").mockResolvedValue(null);
    const error = await desktop
      .provider()
      .provision({ botId: "bot", homePath: "/h" }, ctx)
      .catch((caught: unknown) => caught);
    expect(isSandboxGoneError(error)).toBe(true);
  });

  it("runs commands in the home with UTF-8 PowerShell output", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    desktop.exec = () => ({ status: "completed", exit_code: 3, stdout: "out", stderr: "err" });
    const events = await run(desktop, computer, [
      "powershell.exe",
      "-NoLogo",
      "-Command",
      "Get-Date",
    ]);
    expect(events).toEqual([
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 3 },
    ]);
    const exec = desktop.calls.findLast((call) => call.tool === "process_exec");
    expect(exec?.args).toMatchObject({
      program: "powershell.exe",
      cwd: `${FAKE_PROFILE}\\rakazo\\bot`,
    });
    expect((exec?.args.args as string[] | undefined)?.at(-1)).toMatch(
      /^\[Console\]::OutputEncoding=.*Get-Date$/,
    );
  });

  it("reports a command that ran out of time", async () => {
    const desktop = new FakeWuyingDesktop();
    const computer = await provisionPrepared(
      desktop.provider(),
      { botId: "b", homePath: "/h" },
      ctx,
    );
    desktop.exec = () => ({ status: "timeout", exit_code: 1, stdout: "", stderr: "" });
    expect((await run(desktop, computer, ["ping.exe"])).at(-1)).toEqual({
      type: "exit",
      code: 124,
    });
  });

  it("runs a command allowed over a minute detached and streams its output", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    desktop.background = { stdout: "第 1 行\r\n", stderr: "warn", code: 7, polls: 2 };
    const events: ProcessEvent[] = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["powershell.exe", "-Command", "npm install"], timeoutMs: 600_000 },
      ctx,
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "stdout", data: "第 1 行\r\n" },
      { type: "stderr", data: "warn" },
      { type: "exit", code: 7 },
    ]);
    expect(desktop.calls.some((call) => call.tool === "process_exec")).toBe(false);
    // The command reaches PowerShell through a file, untouched by command-line quoting.
    expect(desktop.backgroundCommand).toMatch(/^\[Console\]::OutputEncoding=.*npm install$/);
    const launch = desktop.calls.find((call) => call.tool === "app_start");
    const dir = /'([^']+)\\run\.ps1'/.exec(
      String((launch?.args.args as string[] | undefined)?.at(-1)),
    )?.[1];
    expect(dir?.startsWith(`${FAKE_PROFILE}\\rakazo\\.runs\\`)).toBe(true);
    expect(desktop.has(dir ?? "")).toBe(false);
  });

  it("stops a detached command when its run is cancelled", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    desktop.background = { stdout: "started", code: null };
    const abort = new AbortController();
    const events: ProcessEvent[] = [];
    await expect(
      (async () => {
        for await (const event of provider.execute(
          computer,
          { argv: ["ping.exe", "-t", "127.0.0.1"], timeoutMs: 600_000 },
          { ...ctx, signal: abort.signal },
        )) {
          events.push(event);
          abort.abort(new Error("cancelled"));
        }
      })(),
    ).rejects.toThrow("cancelled");
    expect(events).toEqual([{ type: "stdout", data: "started" }]);
    expect(desktop.calls.some((call) => call.tool === "app_stop")).toBe(true);
    expect(desktop.calls.at(-1)).toMatchObject({ tool: "fs_delete", args: { recursive: true } });
  });

  it("quotes arguments the way Windows reads them back", () => {
    expect(quoteWindowsArgument("plain")).toBe("plain");
    expect(quoteWindowsArgument("")).toBe('""');
    expect(quoteWindowsArgument("a b")).toBe('"a b"');
    expect(quoteWindowsArgument('c"d')).toBe('"c\\"d"');
    expect(quoteWindowsArgument("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
  });

  it("maps actions from the scaled screenshot back to desktop pixels", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    const observed = await provider.observe(computer, ctx);
    expect(observed).toMatchObject({ width: 1600, height: 1000, cursor: { x: 400, y: 200 } });
    await provider.act(
      computer,
      {
        actions: [
          { kind: "pointer", type: "click", x: 100, y: 50 },
          { kind: "pointer", type: "down", x: 10, y: 10 },
          { kind: "pointer", type: "up", x: 20, y: 30 },
          { kind: "key", key: "c", modifiers: ["ctrl"] },
          { kind: "scroll", direction: "down", amount: 2 },
        ],
        observe: false,
      },
      ctx,
    );
    const input = desktop.calls.filter((call) => call.tool.startsWith("input_"));
    expect(input.map((call) => call.args)).toEqual([
      { action: "click", button: "left", x: 200, y: 100 },
      { action: "move", x: 20, y: 20 },
      { action: "drag", button: "left", x: 20, y: 20, to_x: 40, to_y: 60 },
      { key: "ctrl+c", action: "press" },
      { action: "scroll", scroll: -2 },
    ]);
  });

  it("hands the screen to the app as a one-time Wuying login", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    const screen = await provider.connectScreen(computer, { view: "stream" }, ctx);
    const url = new URL(screen.url ?? "");
    expect(url.protocol).toBe("wuying:");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      desktop_id: "ecd-fake",
      region_id: "cn-hangzhou",
      auth_code: "one-time-code",
    });
  });

  it("removes only the computer's home, never the desktop", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const a = await provisionPrepared(provider, { botId: "a", homePath: "/h" }, ctx);
    await provisionPrepared(provider, { botId: "b", homePath: "/h" }, ctx);
    await provider.destroy(a, ctx);
    expect(desktop.has(`${FAKE_PROFILE}\\rakazo\\a`)).toBe(false);
    expect(desktop.has(`${FAKE_PROFILE}\\rakazo\\b`)).toBe(true);
    expect(desktop.control).not.toContain("stop");
  });

  it("removes only well-formed workspace children", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    await provider.workspaceDirectories(computer, { action: "ensure", paths: ["bots/x"] }, ctx);
    expect(await provider.workspaceDirectories(computer, { action: "list" }, ctx)).toEqual([
      "bots/x",
    ]);
    await expect(
      provider.workspaceDirectories(
        computer,
        { action: "remove", parent: "bots", names: ["..\\other"] },
        ctx,
      ),
    ).rejects.toThrow("escapes");
    await provider.workspaceDirectories(
      computer,
      { action: "remove", parent: "bots", names: ["x"] },
      ctx,
    );
    expect(await provider.workspaceDirectories(computer, { action: "list" }, ctx)).toEqual([]);
  });
});

describe("WuyingOpenApi", () => {
  it("signs RPC requests the way Alibaba Cloud documents", () => {
    expect(
      signRpcQuery(
        {
          AccessKeyId: "testid",
          Action: "DescribeRegions",
          Format: "XML",
          SignatureMethod: "HMAC-SHA1",
          SignatureNonce: "3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf",
          SignatureVersion: "1.0",
          Timestamp: "2016-02-23T12:46:24Z",
          Version: "2014-05-26",
        },
        "testsecret",
      ),
    ).toBe("OLeaidS1JvxuMvnyHOwuJ+uX5qY=");
  });

  it("reads desktop state and keeps credentials out of errors", async () => {
    const requests: URL[] = [];
    const respond = (status: number, body: unknown) => async (input: RequestInfo | URL) => {
      requests.push(new URL(String(input)));
      return new Response(JSON.stringify(body), { status });
    };
    const api = (fetch: typeof globalThis.fetch) =>
      new WuyingOpenApi({
        accessKeyId: "AKID",
        accessKeySecret: "secret",
        regionId: "cn-hangzhou",
        fetch,
      });

    const ok = api(
      respond(200, { Desktops: [{ DesktopId: "ecd-1", DesktopStatus: "Running" }] }) as never,
    );
    expect(await ok.desktopStatus("ecd-1", ctx.signal)).toBe("Running");
    expect(requests[0]?.host).toBe("ecd.cn-hangzhou.aliyuncs.com");
    expect(requests[0]?.searchParams.get("Action")).toBe("DescribeDesktops");
    expect(requests[0]?.searchParams.get("DesktopId.1")).toBe("ecd-1");

    const code = api(respond(200, { AuthModel: { AuthCode: "abc" } }) as never);
    expect(await code.authCode("user", ctx.signal)).toBe("abc");
    expect(requests[1]?.host).toBe("appstream-center.aliyuncs.com");

    const denied = await api(respond(403, { Code: "Forbidden.RAM" }) as never)
      .stopDesktop("ecd-1", ctx.signal)
      .catch((error: Error) => error);
    expect(String(denied)).toContain("Forbidden.RAM");
    expect(String(denied)).not.toContain("AKID");

    await expect(
      api(respond(400, { Code: "Throttling.User" }) as never).startDesktop("ecd-1", ctx.signal),
    ).rejects.toBeInstanceOf(SandboxRateLimitError);
  });
});
