#!/usr/bin/env node
// Opt-in browser verification with the real pinned SDK. Fetch it with wuying-web-sdk.mjs first.
// Uses only a fake login code; no Wuying account or desktop is needed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { contentSecurityPolicyFor } from "../packages/contracts/src/content-security-policy.ts";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const root = new URL("../apps/web/public/", import.meta.url);
const requests = [];
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  requests.push(req.url);
  if (pathname === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(`<script>
      localStorage.setItem('parent-secret','fake');document.cookie='parentSecret=fake';
      window.messages=[];addEventListener('message',event=>{
        if(event.source===document.querySelector('iframe').contentWindow)
          messages.push({data:event.data,origin:event.origin});
      });
      </script><iframe sandbox="allow-scripts allow-pointer-lock" src="/wuying/screen.html#desktop_id=ecd-fake&auth_code=fake-login-code&view_only=true"></iframe>`);
    return;
  }
  if (!pathname.startsWith("/wuying/")) {
    res.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(new URL(`.${pathname}`, root));
    res.setHeader("Content-Type", pathname.endsWith(".html") ? "text/html" : "text/javascript");
    res.setHeader("Content-Security-Policy", contentSecurityPolicyFor(pathname));
    res.end(content);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  const leaked = [];
  page.on("request", (request) => {
    if ((request.headers().referer ?? "").includes("fake-login-code")) leaked.push("Referer");
  });
  page.on("console", (message) => {
    if (message.text().includes("fake-login-code")) leaked.push("console");
  });
  const violations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.addEventListener("securitypolicyviolation", (event) => {
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  page.on("console", (message) => {
    if (message.text().startsWith("CSP violation:")) violations.push(message.text());
  });
  const login = page.waitForRequest((request) => request.url().includes("/GetStsToken"));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await login;
  await page.waitForFunction(() =>
    window.messages.some((message) => message.data.rakazoScreen === "failed"),
  );
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const other = document.createElement("iframe");
        other.sandbox = "allow-scripts";
        other.srcdoc = "<script>parent.postMessage({rakazoScreen:'connected'},'*')</script>";
        other.onload = () =>
          setTimeout(() => {
            other.remove();
            resolve();
          }, 0);
        document.body.append(other);
      }),
  );
  assert.equal(page.frames().length, 3, "outer SDK and nested runtime loaded");
  for (const frame of page.frames().slice(1)) {
    const result = await frame.evaluate(() => {
      const blocked = (read) => {
        try {
          read();
          return false;
        } catch (error) {
          return error.name === "SecurityError";
        }
      };
      // biome-ignore lint/suspicious/noDocumentCookie: exercise the vendor cookie shim.
      document.cookie = "vendorCookie=ignored";
      localStorage.setItem("shim", 123);
      sessionStorage.clear();
      sessionStorage.setItem("session", "ok");
      const stored = localStorage.getItem("shim");
      localStorage.removeItem("shim");
      return {
        parentDocumentBlocked: blocked(() => parent.document),
        parentStorageBlocked: blocked(() => top.localStorage),
        parentCookieBlocked: blocked(() => top.document.cookie),
        parentSecret: localStorage.getItem("parent-secret"),
        cookie: document.cookie,
        stored,
        removed: localStorage.getItem("shim"),
        sessionLength: sessionStorage.length,
        sessionKey: sessionStorage.key(0),
      };
    });
    assert.deepEqual(result, {
      parentDocumentBlocked: true,
      parentStorageBlocked: true,
      parentCookieBlocked: true,
      parentSecret: null,
      cookie: "",
      stored: "123",
      removed: null,
      sessionLength: 1,
      sessionKey: "session",
    });
  }
  // The ASP runtime already constructs blob workers and imports blob decoder scripts.
  for (const frame of page.frames().slice(1)) {
    assert.equal(
      await frame.evaluate(async () => {
        const imported = URL.createObjectURL(
          new Blob(["self.decoderReady = true"], { type: "text/javascript" }),
        );
        const script = URL.createObjectURL(
          new Blob(
            [
              `importScripts(${JSON.stringify(imported)});postMessage(self.decoderReady && new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))) instanceof WebAssembly.Instance)`,
            ],
            { type: "text/javascript" },
          ),
        );
        const worker = new Worker(script);
        try {
          return await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = () => reject(new Error("blob worker failed"));
          });
        } finally {
          worker.terminate();
          URL.revokeObjectURL(script);
          URL.revokeObjectURL(imported);
        }
      }),
      true,
      "blob workers, importScripts and WASM work in opaque frames",
    );
  }
  assert.equal(
    await page.frames()[1].evaluate(() => typeof window.Wuying.WebSDK.createSession),
    "function",
  );
  const messages = await page.evaluate(() => window.messages);
  assert(
    messages.some(
      (message) => message.origin === "null" && message.data.rakazoScreen === "connecting",
    ),
  );
  assert(
    messages.some((message) => message.origin === "null" && message.data.rakazoScreen === "failed"),
  );
  assert(
    requests.every((url) => !url.includes("fake-login-code")),
    "login code stays out of server requests",
  );
  assert(
    !messages.some((message) => message.data.rakazoScreen === "connected"),
    "messages from another source are ignored",
  );
  assert.deepEqual(leaked, [], "login code stays out of console and Referer");
  assert.deepEqual(errors, [], "no uncaught exceptions, including SecurityError");
  assert.deepEqual(violations, [], "no CSP violations before login rejection");
  console.log(
    "Real pinned SDK initialised in two opaque frames and reached fake-code login rejection. Parent DOM, cookies and storage blocked; memory Storage and cookie shim verified; no uncaught exceptions or CSP violations.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
