(function () {
  const params = new URLSearchParams(location.search);
  const accessToken = params.get("token") || "";

  function withToken(path, extra = {}) {
    const url = new URL(path, location.origin);
    url.searchParams.set("token", accessToken);
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
    return url;
  }

  function link(path, extra = {}) {
    const url = withToken(path, extra);
    return url.pathname + url.search;
  }

  function setupNav() {
    document.querySelectorAll("[data-page]").forEach(anchor => {
      anchor.href = link(anchor.dataset.page);
    });
  }

  window.UnderSound = {
    accessToken,
    withToken,
    link,
    setupNav,
  };

  window.addEventListener("DOMContentLoaded", setupNav);
})();
