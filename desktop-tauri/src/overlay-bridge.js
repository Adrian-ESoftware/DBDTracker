(function () {
  var apiBase = "http://127.0.0.1:8765/api";

  function invoke(command) {
    if (!window.__TAURI__ || !window.__TAURI__.core) {
      return Promise.reject(new Error("Tauri API indisponivel."));
    }
    return window.__TAURI__.core.invoke(command);
  }

  window.dbd = {
    apiBase: apiBase,
    hide: function () { return invoke("hide_overlay"); },
    toggleSize: function () { return invoke("toggle_size"); },
    showLogin: function () { return invoke("show_login"); },
    finishLogin: function () { return invoke("finish_login"); },
    collectNow: function () { return invoke("collect_now"); },
    collectorStatus: function () { return invoke("collector_status"); },
    onStatus: function (callback) {
      if (!window.__TAURI__ || !window.__TAURI__.event) return;
      window.__TAURI__.event.listen("collector-status", function (event) {
        callback(event.payload);
      });
    }
  };
})();
