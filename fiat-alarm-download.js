(function () {
  "use strict";

  const output = document.getElementById("fiatAlarmDownloads");
  const label = document.getElementById("fiatAlarmCountLabel");
  if (!output || !label) return;

  const endpoint = "https://api.github.com/repos/kaissymarji/star-mobile-downloads./releases/tags/fiat-alarm-v5.4";
  const filename = "V200_Fiat500_BCM_FI3_v5_4.apk";
  let inFlight = false;
  let lastAttempt = 0;
  let hasCount = false;

  async function refresh(force) {
    if (inFlight || (!force && Date.now() - lastAttempt < 30000)) return;
    inFlight = true;
    lastAttempt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 8000);
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: "application/vnd.github+json" },
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) throw new Error("GitHub HTTP " + response.status);
      const release = await response.json();
      const asset = (release.assets || []).find(function (item) {
        return item.name === filename && item.state === "uploaded";
      });
      if (!asset || !Number.isSafeInteger(asset.download_count) || asset.download_count < 0) {
        throw new Error("Release download count unavailable");
      }
      output.textContent = asset.download_count.toLocaleString("en-US");
      label.textContent = "downloads";
      output.parentElement.title = "GitHub Release downloads since November 14, 2026. Earlier direct-file downloads were not recorded.";
      hasCount = true;
    } catch (_) {
      if (hasCount) {
        label.textContent = "downloads (last checked)";
      } else {
        output.textContent = "—";
        label.textContent = "Download count temporarily unavailable";
      }
    } finally {
      clearTimeout(timeout);
      inFlight = false;
    }
  }

  // Read GitHub's count; never increment locally or delay the APK download.
  const download = document.getElementById("fiatAlarmDownload");
  if (download) download.addEventListener("click", function () {
    setTimeout(function () { refresh(true); }, 5000);
  });
  window.addEventListener("pageshow", function () { refresh(false); });
  window.addEventListener("focus", function () { refresh(false); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") refresh(false);
  });
  refresh(true);
}());
