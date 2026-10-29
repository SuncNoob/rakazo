// Draws a Wuying cloud desktop with the Wuying Web SDK and reports its state to the app the way
// the /novnc screen pages do, through { rakazoScreen } messages to the parent frame.
(() => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  // The login code works once; keep it out of history and anything that reads the URL later.
  window.history.replaceState(null, "", window.location.pathname);

  const report = (state, detail) =>
    window.parent.postMessage(
      detail ? { rakazoScreen: state, detail } : { rakazoScreen: state },
      "*",
    );

  const desktopId = params.get("desktop_id");
  const regionId = params.get("region_id") || "cn-hangzhou";
  const authCode = params.get("auth_code");
  const viewOnly = params.get("view_only") !== "false";
  if (!desktopId || !authCode || !window.Wuying?.WebSDK) {
    report("failed");
    return;
  }

  report("connecting");
  const session = window.Wuying.WebSDK.createSession("rakazo-desktop", {
    iframeId: "session",
    openType: "inline",
    resourceType: "local",
    connectType: "desktop",
    regionId,
    userInfo: { authCode },
    desktopInfo: { desktopId, loginRegionId: regionId },
  });
  session.addHandle("onConnected", () => {
    // Only the user holding control may type into the desktop; everyone else watches.
    session.enableInput(!viewOnly);
    report("connected");
  });
  session.addHandle("onDisConnected", () => report("disconnected"));
  session.addHandle("getConnectionTicketInfo", (data) => {
    if (data?.status === "error") report("failed", typeof data.Code === "string" ? data.Code : "");
  });
  session.addHandle("onError", () => report("failed"));
  window.addEventListener("message", (event) => {
    if (event.source === window.parent && event.data?.rakazoScreenFocus) {
      document.getElementById("session")?.focus();
    }
  });
  window.addEventListener("pagehide", () => session.stop());
  session.start();
})();
