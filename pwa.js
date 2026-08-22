(function () {
  "use strict";

  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("./service-worker.js").catch(function (error) {
      console.warn("離線支援無法啟用", error);
    });
  });
}());
