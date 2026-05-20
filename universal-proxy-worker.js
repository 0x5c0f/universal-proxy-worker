/**
 * ╔══════════════════════════════════════════════════════╗
 * ║     Universal Mirror Proxy — Cloudflare Workers      ║
 * ║  支持 Docker Hub / GHCR / GCR / Quay / npm / PyPI   ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * 部署方式：
 *   方式一（Dashboard）：复制粘贴到 CF Workers 编辑器，Deploy
 *   方式二（Wrangler CLI）：
 *     npm install -g wrangler
 *     wrangler login
 *     wrangler deploy
 *
 * 路由规则（在 CF Dashboard 绑定域名后按子路径分流，或用子域名）：
 *
 *   子路径模式（一个 Worker，一个域名）：
 *     https://mirror.example.com/dockerhub/...  → Docker Hub
 *     https://mirror.example.com/ghcr/...       → ghcr.io
 *     https://mirror.example.com/gcr/...        → gcr.io
 *     https://mirror.example.com/quay/...       → quay.io
 *     https://mirror.example.com/npm/...        → npmjs.org
 *     https://mirror.example.com/pypi/...       → pypi.org
 *     https://mirror.example.com/github/...     → github.com (Releases/Raw)
 *
 *   子域名模式（更通用，推荐）：
 *     需在 CF DNS 为每个子域名建 CNAME → Worker，并在 Worker Routes 绑定
 *     dockerhub.example.com → Docker Hub（可直接配置 registry-mirrors）
 *     ghcr.example.com      → ghcr.io
 *     gcr.example.com       → gcr.io
 *     quay.example.com      → quay.io
 *     npm.example.com       → npmjs
 *     pypi.example.com      → PyPI
 *     github.example.com    → GitHub
 */

// ═══════════════════════════════════════════════════════
// ① 平台配置表
//    每个平台独立配置，新增平台只需在这里追加一项
// ═══════════════════════════════════════════════════════

const REGISTRY_CONFIGS = {

  // ── Docker Hub ─────────────────────────────────────
  // 子域名：docker.51ac.cc
  // registry-mirrors: ["https://docker.51ac.cc"]
  dockerhub: {
    pathPrefix: "/dockerhub",
    subdomainKeywords: ["docker"],
    type: "docker",
    upstream: {
      registry: "https://registry-1.docker.io",
      auth:     "https://auth.docker.io",
      authService: "registry.docker.io",
    },
    redirectBlobs: false,
  },

  // ── GitHub Container Registry ───────────────────────
  // 子域名：ghcr.51ac.cc
  // docker pull ghcr.51ac.cc/<owner>/<image>:<tag>
  ghcr: {
    pathPrefix: "/ghcr",
    subdomainKeywords: ["ghcr"],
    type: "docker",
    upstream: {
      registry: "https://ghcr.io",
      auth:     "https://ghcr.io",
      authService: "ghcr.io",
    },
    redirectBlobs: false,
  },

  // ── Google Container Registry ───────────────────────
  // 子域名：gcr.51ac.cc
  gcr: {
    pathPrefix: "/gcr",
    subdomainKeywords: ["gcr"],
    type: "docker",
    upstream: {
      registry: "https://gcr.io",
      auth:     "https://gcr.io",
      authService: "gcr.io",
    },
    redirectBlobs: false,
  },

  // ── Google Artifact Registry ────────────────────────
  // 子域名：gar.51ac.cc
  gar: {
    pathPrefix: "/gar",
    subdomainKeywords: ["gar"],
    type: "docker",
    upstream: {
      registry: "https://us-docker.pkg.dev",
      auth:     "https://us-docker.pkg.dev",
      authService: "us-docker.pkg.dev",
    },
    redirectBlobs: false,
  },

  // ── Quay.io ─────────────────────────────────────────
  // 子域名：quay.51ac.cc
  quay: {
    pathPrefix: "/quay",
    subdomainKeywords: ["quay"],
    type: "docker",
    upstream: {
      registry: "https://quay.io",
      auth:     "https://quay.io",
      authService: "quay.io",
    },
    redirectBlobs: false,
  },

  // ── npm Registry ─────────────────────────────────────
  // 子域名：npm.51ac.cc
  // npm config set registry https://npm.51ac.cc
  npm: {
    pathPrefix: "/npm",
    subdomainKeywords: ["npm"],
    type: "npm",
    upstream: {
      registry: "https://registry.npmjs.org",
    },
    rewriteTarballUrls: true,
  },

  // ── PyPI ─────────────────────────────────────────────
  // 子域名：pypi.51ac.cc
  // pip config set global.index-url https://pypi.51ac.cc/simple
  pypi: {
    pathPrefix: "/pypi",
    subdomainKeywords: ["pypi"],
    type: "pypi",
    upstream: {
      registry: "https://pypi.org",
      files:    "https://files.pythonhosted.org",
    },
    rewriteDownloadUrls: true,
  },

  // ── GitHub Releases / Raw ────────────────────────────
  // 子域名：gh.51ac.cc
  // https://gh.51ac.cc/<owner>/<repo>/releases/download/<tag>/<file>
  github: {
    pathPrefix: "/github",
    subdomainKeywords: ["gh"],
    type: "github",
    upstream: {
      main:     "https://github.com",
      raw:      "https://raw.githubusercontent.com",
      objects:  "https://objects.githubusercontent.com",
      codeload: "https://codeload.github.com",
    },
  },

};

// ═══════════════════════════════════════════════════════
// ② 全局开关
// ═══════════════════════════════════════════════════════

const CONFIG = {
  // 访问日志（在 CF Dashboard → Workers → Logs 查看）
  enableLogs: true,
  // 首页展示使用说明
  showHomePage: true,
};

// ═══════════════════════════════════════════════════════
// ③ 主入口
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// 统计写入：用 ctx.waitUntil 异步批量写 KV，不阻塞响应
// KV 写额度 1000次/天，manifest 事件才写（每次 pull 约触发 1 次）
// ═══════════════════════════════════════════════════════

async function recordStats(kv, event) {
  if (!kv || !event) return;

  // 只统计有意义的事件，跳过内部解析和低价值高频事件
  // manifest-digest: Docker 内部 multi-arch 二次解析，不是用户行为
  // blob / auth: 频率极高，写 KV 会很快耗尽 1000次/天写额度，且易竞态
  const SKIP_EVENTS = new Set(["manifest-digest", "blob", "auth"]);
  if (SKIP_EVENTS.has(event.event)) return;

  const isFailed = event.failed && event.status !== 401;

  try {
    // ── daily 汇总（每天一个 key，竞态窗口：同秒内多个 manifest/npm 请求）──
    // 个人使用场景并发极低，剩余竞态概率可接受
    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = `stats:daily:${today}`;
    const raw = await kv.get(dailyKey);
    const daily = raw ? JSON.parse(raw) : {
      total: 0, pulls: 0, byPlatform: {}, byEvent: {}, errors: 0,
    };

    daily.total += 1;
    daily.byPlatform[event.platform] = (daily.byPlatform[event.platform] || 0) + 1;
    if (event.event) daily.byEvent[event.event] = (daily.byEvent[event.event] || 0) + 1;
    if (isFailed) daily.errors += 1;
    if (event.event === "manifest") daily.pulls += 1;

    await kv.put(dailyKey, JSON.stringify(daily), { expirationTtl: 60 * 60 * 24 * 30 });

    // ── 镜像维度（key 按 image 隔离，天然无竞态）──
    if (event.event === "manifest" && event.image) {
      const imgKey = `stats:image:${event.image}`;
      const imgRaw = await kv.get(imgKey);
      const img = imgRaw ? JSON.parse(imgRaw) : { total: 0, failed: 0, lastPull: "", lastFailed: "" };
      img.total += 1;
      img.lastPull = new Date().toISOString();
      if (isFailed) { img.failed = (img.failed || 0) + 1; img.lastFailed = img.lastPull; }
      await kv.put(imgKey, JSON.stringify(img), { expirationTtl: 60 * 60 * 24 * 90 });
    }

    // ── npm / pypi 包维度（key 按 package 隔离，天然无竞态）──
    if ((event.event === "npm-pkg" || event.event === "pypi-pkg") && event.package) {
      const pkgKey = `stats:pkg:${event.platform}:${event.package}`;
      const pkgRaw = await kv.get(pkgKey);
      const pkg = pkgRaw ? JSON.parse(pkgRaw) : { total: 0, failed: 0, lastAccess: "" };
      pkg.total += 1;
      pkg.lastAccess = new Date().toISOString();
      if (isFailed) pkg.failed = (pkg.failed || 0) + 1;
      await kv.put(pkgKey, JSON.stringify(pkg), { expirationTtl: 60 * 60 * 24 * 90 });
    }
  } catch (e) {
    console.error("stats write error:", e.message);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const selfHost = url.host;
    const t0 = Date.now();

    // 根路径 → 统计首页
    if (url.pathname === "/" && CONFIG.showHomePage) {
      return renderHomePage(selfHost, env.MIRROR_STATS);
    }

    // /api/stats → JSON 统计接口（供首页 fetch）
    if (url.pathname === "/api/stats") {
      return handleStatsApi(env.MIRROR_STATS);
    }

    // /api/debug → 直接dump KV原始数据，用于排查统计问题
    if (url.pathname === "/api/debug") {
      return handleDebugApi(env.MIRROR_STATS);
    }

    // 路由匹配
    const { config, strippedPath } = resolveConfig(url, selfHost);

    if (!config) {
      return new Response(
        JSON.stringify({ error: "No matching proxy config. Check path prefix or subdomain." }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    let resp;
    try {
      switch (config.type) {
        case "docker":
          resp = await handleDocker(request, url, strippedPath, config, selfHost);
          break;
        case "npm":
          resp = await handleNpm(request, url, strippedPath, config, selfHost);
          break;
        case "pypi":
          resp = await handlePypi(request, url, strippedPath, config, selfHost);
          break;
        case "github":
          resp = await handleGithub(request, url, strippedPath, config, selfHost);
          break;
        default:
          return new Response("Unsupported proxy type", { status: 500 });
      }
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), type: config?.type, path: strippedPath, error: e.message }));
      return new Response(`Proxy Error: ${e.message}`, { status: 502 });
    }

    // 异步记录统计（不阻塞响应返回）
    const ms = Date.now() - t0;
    const log = buildLog(config, selfHost, strippedPath, request.method, resp.status, ms);
    if (log) {
      if (CONFIG.enableLogs) console.log(JSON.stringify(log));
      if (env.MIRROR_STATS) ctx.waitUntil(recordStats(env.MIRROR_STATS, log));
    }

    return resp;
  },
};

// ═══════════════════════════════════════════════════════
// 统计 API：读取 KV 汇总后返回 JSON
// ═══════════════════════════════════════════════════════

async function handleStatsApi(kv) {
  if (!kv) return new Response(JSON.stringify({ error: "KV not configured" }), {
    status: 503, headers: { "Content-Type": "application/json" }
  });

  try {
    // 读最近 7 天数据
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const raw = await kv.get(`stats:daily:${d}`);
      if (raw) days.push({ date: d, ...JSON.parse(raw) });
      else days.push({ date: d, total: 0, byPlatform: {}, byEvent: {}, errors: 0 });
    }

    // 读 Top 10 镜像
    const imgList = await kv.list({ prefix: "stats:image:" });
    const images = await Promise.all(
      imgList.keys.slice(0, 50).map(async (k) => {
        const raw = await kv.get(k.name);
        const data = raw ? JSON.parse(raw) : {};
        return { image: k.name.replace("stats:image:", ""), ...data };
      })
    );
    images.sort((a, b) => (b.total || 0) - (a.total || 0));

    // 读 Top 10 npm/pypi 包
    const pkgList = await kv.list({ prefix: "stats:pkg:" });
    const packages = await Promise.all(
      pkgList.keys.slice(0, 50).map(async (k) => {
        const raw = await kv.get(k.name);
        const data = raw ? JSON.parse(raw) : {};
        const parts = k.name.replace("stats:pkg:", "").split(":");
        return { platform: parts[0], package: parts.slice(1).join(":"), ...data };
      })
    );
    packages.sort((a, b) => (b.total || 0) - (a.total || 0));

    // totalImagePulls 直接从 images 维度累加，比 daily.pulls 更准确
    // （daily.pulls 是后加的字段，旧数据里缺失会导致数字偏低）
    const totalImagePulls = images.reduce((s, i) => s + (i.total || 0), 0);

    return new Response(JSON.stringify({ days, images: images.slice(0, 10), packages: packages.slice(0, 10), totalImagePulls }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}

// ═══════════════════════════════════════════════════════
// Debug API：dump KV 所有原始数据，排查统计异常
// ═══════════════════════════════════════════════════════

async function handleDebugApi(kv) {
  if (!kv) return new Response(JSON.stringify({ error: "KV not configured" }), {
    status: 503, headers: { "Content-Type": "application/json" }
  });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // 读今日和昨日 daily 原始值
    const todayRaw  = await kv.get(`stats:daily:${today}`);
    const yestRaw   = await kv.get(`stats:daily:${yesterday}`);

    // 列出所有镜像 key
    const imgList = await kv.list({ prefix: "stats:image:" });
    const images = {};
    for (const k of imgList.keys) {
      const raw = await kv.get(k.name);
      images[k.name] = raw ? JSON.parse(raw) : null;
    }

    const result = {
      serverTime: new Date().toISOString(),
      daily: {
        [today]:    todayRaw  ? JSON.parse(todayRaw)  : null,
        [yesterday]: yestRaw  ? JSON.parse(yestRaw)   : null,
      },
      images,
      kvBindingOk: true,
    };

    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, kvBindingOk: !!kv }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}

// 根据请求路径提取有意义的日志/统计字段
function buildLog(config, host, path, method, status, ms) {
  // name 是配置表的 key（dockerhub/ghcr/gcr/gar/quay/npm/pypi/github），比 type 更精确
  const base = { ts: new Date().toISOString(), platform: config.name || config.type, host, method, status, ms };

  if (config.type === "docker") {
    const mani = path.match(/^\/v2\/(.+)\/manifests\/([^?]+)/);
    if (mani) {
      const ref = mani[2];
      const image = mani[1];
      if (ref.startsWith("sha256:")) {
        // sha256 形式是 Docker 内部二次查询（multi-arch 解析），不计入"用户拉取次数"
        return { ...base, event: "manifest-digest", image, ref: ref.slice(0, 19) + "…" };
      }
      // tag 形式（latest / alpine / 3.19 等）才是真正的一次用户 pull
      const failed = status >= 400;
      return { ...base, event: "manifest", image, ref, failed };
    }
    const blob = path.match(/^\/v2\/(.+)\/blobs\/(sha256:[a-f0-9]+)/);
    if (blob) {
      // blob 下载失败：上游返回非 200/302 均视为失败
      const failed = status >= 400;
      return { ...base, event: "blob", image: blob[1], digest: blob[2].slice(0, 19) + "…", failed };
    }
    if (path.startsWith("/token")) return { ...base, event: "auth" };
    return null;
  }
  if (config.type === "npm") {
    const pkg = path.match(/^\/(@[^/]+\/[^/?]+|[^/@][^/?]*)/);
    if (pkg) return { ...base, event: "npm-pkg", package: pkg[1], failed: status >= 400 };
  }
  if (config.type === "pypi") {
    const pkg = path.match(/^\/simple\/([^/?]+)/);
    if (pkg) return { ...base, event: "pypi-pkg", package: pkg[1], failed: status >= 400 };
  }
  if (config.type === "github") {
    return { ...base, event: "github-file", path, failed: status >= 400 };
  }
  return null;
}
// ═══════════════════════════════════════════════════════
// ④ 路由解析
// ═══════════════════════════════════════════════════════

function resolveConfig(url, selfHost) {
  const hostname = selfHost.split(":")[0]; // 去掉端口

  // 优先子域名匹配
  for (const [name, cfg] of Object.entries(REGISTRY_CONFIGS)) {
    for (const kw of cfg.subdomainKeywords) {
      if (hostname.startsWith(kw + ".") || hostname === kw) {
        return { config: { ...cfg, name }, strippedPath: url.pathname };
      }
    }
  }

  // 子路径匹配
  for (const [name, cfg] of Object.entries(REGISTRY_CONFIGS)) {
    if (url.pathname.startsWith(cfg.pathPrefix)) {
      const strippedPath = url.pathname.slice(cfg.pathPrefix.length) || "/";
      return { config: { ...cfg, name }, strippedPath };
    }
  }

  return { config: null, strippedPath: "/" };
}

// ═══════════════════════════════════════════════════════
// ⑤ Docker 协议代理（兼容所有 OCI Distribution Spec 平台）
// ═══════════════════════════════════════════════════════

async function handleDocker(request, url, strippedPath, config, selfHost) {
  const { upstream } = config;

  // /token → 代理到上游 auth 端点
  if (strippedPath.startsWith("/token")) {
    const targetUrl = upstream.auth + "/token" + url.search;
    const resp = await fetchUpstream(targetUrl, request, new URL(upstream.auth).host);
    return new Response(resp.body, {
      status: resp.status,
      headers: filterResponseHeaders(resp.headers),
    });
  }

  // /v2/ → 代理到 registry
  if (strippedPath.startsWith("/v2/")) {
    const targetUrl = upstream.registry + strippedPath + url.search;
    const upstreamHost = new URL(upstream.registry).host;

    // blob 层处理：
    // Docker Hub blob 请求会经历两段跳转：
    //   registry-1.docker.io → production.cloudflare.docker.com → S3 预签名 URL
    // S3 预签名 URL 自带签名，不能携带额外的 Authorization/x-amz-* 头，否则签名校验失败
    // 正确做法：用带 token 的头请求 registry，跟随重定向，最终拿到 S3 直链后 302 给客户端
    // 客户端直连 S3 下载，不携带任何额外头（浏览器/Docker 客户端对跨域 302 默认丢弃 Auth 头）
    if (strippedPath.includes("/blobs/sha256:") && request.method === "GET") {
      // 用 registry token 请求，redirect: "manual" 只跟第一跳
      const firstResp = await fetch(targetUrl, {
        method: "GET",
        headers: sanitizeRequestHeaders(request.headers, upstreamHost),
        redirect: "manual",
      });

      // registry 返回 307/302 → CDN/S3
      if (firstResp.status === 307 || firstResp.status === 302 || firstResp.status === 301) {
        const cdnUrl = firstResp.headers.get("Location");
        if (cdnUrl) {
          // 继续跟随，拿到最终 S3 预签名 URL（可能再跳一次）
          // 5s 超时保护，避免 CDN 无响应时 Worker 卡到 30s 全局超时
          const abortCtrl = new AbortController();
          const timer = setTimeout(() => abortCtrl.abort(), 5000);
          let finalUrl = cdnUrl;
          try {
            const secondResp = await fetch(cdnUrl, {
              method: "HEAD",
              redirect: "follow",
              signal: abortCtrl.signal,
            });
            if (secondResp.url && secondResp.url !== cdnUrl) finalUrl = secondResp.url;
          } catch (_) {
            // 超时或网络错误：降级直接用第一跳 CDN URL
          } finally {
            clearTimeout(timer);
          }
          // 302 给 Docker 客户端，客户端直连 S3，不携带 Authorization 头
          return Response.redirect(finalUrl, 302);
        }
      }

      // registry 直接返回数据（无重定向）：流式透传
      if (firstResp.status === 200) {
        return new Response(firstResp.body, {
          status: 200,
          headers: filterResponseHeaders(firstResp.headers),
        });
      }

      // 其他状态（401、404 等）透传
      return new Response(firstResp.body, {
        status: firstResp.status,
        headers: filterResponseHeaders(firstResp.headers),
      });
    }

    const resp = await fetchUpstream(targetUrl, request, upstreamHost);
    const headers = filterResponseHeaders(resp.headers);

    // 改写 WWW-Authenticate — 把 realm 指向我们自己的 /token
    const wwwAuth = resp.headers.get("WWW-Authenticate");
    if (wwwAuth) {
      const rewritten = wwwAuth.replace(
        /realm="https?:\/\/[^"]+\/token"/,
        `realm="https://${selfHost}/token"`
      );
      headers.set("WWW-Authenticate", rewritten);
    }

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  }

  return new Response("Docker proxy: invalid path", { status: 400 });
}

// ═══════════════════════════════════════════════════════
// ⑥ npm 代理
// ═══════════════════════════════════════════════════════

async function handleNpm(request, url, strippedPath, config, selfHost) {
  const { upstream, rewriteTarballUrls } = config;
  const targetUrl = upstream.registry + strippedPath + url.search;
  const upstreamHost = new URL(upstream.registry).host;

  const resp = await fetchUpstream(targetUrl, request, upstreamHost);
  const headers = filterResponseHeaders(resp.headers);
  const ct = resp.headers.get("Content-Type") || "";

  // JSON 响应（包元数据）中的 tarball URL 需要改写，否则客户端会直接去 npmjs.org 下载
  if (rewriteTarballUrls && ct.includes("application/json")) {
    const text = await resp.text();
    const selfBase = `https://${selfHost}`;
    // 同时替换 https:// 和 http:// 变体，避免旧包元数据里的 http 链接漏掉
    const rewritten = text
      .replaceAll("https://" + new URL(upstream.registry).host, selfBase)
      .replaceAll("http://"  + new URL(upstream.registry).host, selfBase);
    headers.set("Content-Type", "application/json");
    return new Response(rewritten, { status: resp.status, headers });
  }

  return new Response(resp.body, { status: resp.status, headers });
}

// ═══════════════════════════════════════════════════════
// ⑦ PyPI 代理
// ═══════════════════════════════════════════════════════

async function handlePypi(request, url, strippedPath, config, selfHost) {
  const { upstream, rewriteDownloadUrls } = config;

  // /packages/ 实际文件由 files.pythonhosted.org 提供，302 重定向最省流量
  if (strippedPath.startsWith("/packages/")) {
    const fileUrl = upstream.files + strippedPath + url.search;
    return Response.redirect(fileUrl, 302);
  }

  const targetUrl = upstream.registry + strippedPath + url.search;
  const upstreamHost = new URL(upstream.registry).host;
  const resp = await fetchUpstream(targetUrl, request, upstreamHost);
  const headers = filterResponseHeaders(resp.headers);
  const ct = resp.headers.get("Content-Type") || "";

  // Simple API（HTML）/ JSON API 中的下载链接改写
  if (rewriteDownloadUrls && (ct.includes("text/html") || ct.includes("application/json") || ct.includes("application/vnd.pypi"))) {
    const text = await resp.text();
    const rewritten = text
      .replaceAll("https://files.pythonhosted.org", `https://${selfHost}`)
      .replaceAll("https://pypi.org", `https://${selfHost}`);
    headers.set("Content-Type", ct);
    return new Response(rewritten, { status: resp.status, headers });
  }

  return new Response(resp.body, { status: resp.status, headers });
}

// ═══════════════════════════════════════════════════════
// ⑧ GitHub 文件代理
// ═══════════════════════════════════════════════════════

async function handleGithub(request, url, strippedPath, config, selfHost) {
  const { upstream } = config;

  // 根据路径特征选择上游
  let targetBase = upstream.main;
  if (strippedPath.startsWith("/raw/")) {
    // 重写为 raw.githubusercontent.com
    const rawPath = strippedPath.replace(/^\/raw/, "");
    targetBase = upstream.raw;
    const targetUrl = targetBase + rawPath + url.search;
    return await proxyGithubFile(request, targetUrl, new URL(targetBase).host);
  }

  if (
    strippedPath.includes("/releases/download/") ||
    strippedPath.includes("/archive/") ||
    strippedPath.includes("/zipball/") ||
    strippedPath.includes("/tarball/")
  ) {
    // Release / archive 文件由 codeload / objects 提供，跟随 302 透传
    const targetUrl = upstream.main + strippedPath + url.search;
    return await proxyGithubFile(request, targetUrl, "github.com");
  }

  // 其他路径直接代理 github.com
  const targetUrl = upstream.main + strippedPath + url.search;
  return await proxyGithubFile(request, targetUrl, "github.com");
}

async function proxyGithubFile(request, targetUrl, upstreamHost) {
  // 用 GET + redirect:manual 一次请求同时处理两种情况：
  //   - 302/301 → 直接把 Location 作为 302 返回给客户端（大文件不过 Worker）
  //   - 200     → 直接流式透传（raw 文件等小文件）
  // 避免之前 HEAD + GET 两次请求的浪费
  const resp = await fetch(targetUrl, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: sanitizeRequestHeaders(request.headers, upstreamHost),
    redirect: "manual",
  });

  if (resp.status === 301 || resp.status === 302 || resp.status === 307 || resp.status === 308) {
    const location = resp.headers.get("Location");
    if (location) return Response.redirect(location, 302);
  }

  return new Response(resp.body, {
    status: resp.status,
    headers: filterResponseHeaders(resp.headers),
  });
}

// ═══════════════════════════════════════════════════════
// ⑨ 工具函数
// ═══════════════════════════════════════════════════════

async function fetchUpstream(targetUrl, originalRequest, upstreamHost) {
  const req = new Request(targetUrl, {
    method: originalRequest.method,
    headers: sanitizeRequestHeaders(originalRequest.headers, upstreamHost),
    body: ["GET", "HEAD"].includes(originalRequest.method) ? null : originalRequest.body,
    redirect: "follow",
  });
  return await fetch(req);
}

function sanitizeRequestHeaders(original, newHost) {
  const headers = new Headers(original);
  headers.set("Host", newHost);
  // 移除 CF 注入头，避免上游混淆或泄露代理信息
  [
    "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
    "cf-ew-via", "x-forwarded-for", "x-real-ip", "x-forwarded-proto",
  ].forEach((h) => headers.delete(h));
  return headers;
}

function filterResponseHeaders(original) {
  const headers = new Headers();
  // 这些头由 CF / 浏览器自动处理，手动透传会报错或产生歧义
  const skip = new Set([
    "transfer-encoding", "connection", "keep-alive",
    "upgrade", "proxy-authenticate", "proxy-authorization",
    "te", "trailer",
  ]);
  for (const [k, v] of original.entries()) {
    if (!skip.has(k.toLowerCase())) headers.set(k, v);
  }
  return headers;
}

// ═══════════════════════════════════════════════════════
// ⑩ 首页（含实时统计面板）
// ═══════════════════════════════════════════════════════

async function renderHomePage(selfHost, kv) {
  // 从当前访问的 host 推断根域名，自动适配任意部署域名
  // 例：docker.example.com → rootDomain = example.com
  // 例：universal-mirror-proxy.xxx.workers.dev → 直接用 selfHost 作为单域名模式
  const parts = selfHost.split(".");
  const rootDomain = parts.length >= 2 ? parts.slice(-2).join(".") : selfHost;
  const D = {
    docker: `docker.${rootDomain}`,
    ghcr:   `ghcr.${rootDomain}`,
    gcr:    `gcr.${rootDomain}`,
    gar:    `gar.${rootDomain}`,
    quay:   `quay.${rootDomain}`,
    npm:    `npm.${rootDomain}`,
    pypi:   `pypi.${rootDomain}`,
    github: `gh.${rootDomain}`,
  };

  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Universal Mirror Proxy </title>
<style>
:root{--bg:#0f1117;--card:#1a1d27;--card2:#1e2235;--border:#2a2d3e;--accent:#5b8af5;--accent2:#4ade80;--text:#e2e8f0;--muted:#8892a4;--code-bg:#0d1117;--danger:#f87171;--warn:#fbbf24}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;padding:2rem 1rem;line-height:1.6}
.container{max-width:920px;margin:0 auto}
h1{font-size:1.6rem;font-weight:700;color:var(--accent);margin-bottom:.2rem}
.subtitle{color:var(--muted);margin-bottom:1.5rem;font-size:.9rem}
/* 统计面板 */
.stats-panel{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem 1.5rem;margin-bottom:1.5rem}
.stats-panel h2{font-size:.95rem;font-weight:600;margin-bottom:1rem;color:var(--text);display:flex;align-items:center;gap:.5rem}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.75rem;margin-bottom:1.25rem}
.kpi{background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:.85rem 1rem}
.kpi-val{font-size:1.6rem;font-weight:700;color:var(--accent);line-height:1}
.kpi-label{font-size:.75rem;color:var(--muted);margin-top:.3rem}
.chart-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.25rem}
@media(max-width:600px){.chart-row{grid-template-columns:1fr}}
.chart-box{background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:.85rem 1rem}
.chart-title{font-size:.78rem;color:var(--muted);margin-bottom:.6rem;font-weight:500}
.bar-row{display:flex;align-items:center;gap:.5rem;margin-bottom:.4rem;font-size:.8rem}
.bar-label{min-width:90px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.bar-track{flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;background:var(--accent);transition:width .6s ease}
.bar-num{min-width:28px;text-align:right;color:var(--muted)}
.day-chart{display:flex;align-items:flex-end;gap:3px;height:60px;margin-bottom:.4rem}
.day-bar{flex:1;border-radius:3px 3px 0 0;background:var(--accent);opacity:.7;min-height:2px;transition:height .4s ease;cursor:pointer;position:relative}
.day-bar:hover{opacity:1}
.day-bar .tip{display:none;position:absolute;bottom:110%;left:50%;transform:translateX(-50%);background:#1e2235;border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:.72rem;white-space:nowrap;pointer-events:none}
.day-bar:hover .tip{display:block}
.day-labels{display:flex;gap:3px;font-size:.65rem;color:var(--muted)}
.day-label{flex:1;text-align:center}
.status-dot{width:8px;height:8px;border-radius:50%;background:var(--accent2);display:inline-block;margin-right:4px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.loading{color:var(--muted);font-size:.85rem;padding:.5rem 0}
.err{color:var(--danger);font-size:.8rem}
/* 使用说明 */
.section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.1rem 1.4rem;margin-bottom:1rem}
.section h2{font-size:.95rem;font-weight:600;margin-bottom:.85rem;display:flex;align-items:center;gap:.5rem}
.badge{font-size:.68rem;background:var(--accent);color:#fff;border-radius:4px;padding:1px 6px;font-weight:500}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:.65rem .9rem;font-size:.8rem;overflow-x:auto;color:#a8d8a8;margin:.4rem 0}
.note{font-size:.78rem;color:var(--muted);margin-top:.4rem}
table{width:100%;border-collapse:collapse;font-size:.82rem}
td,th{padding:.45rem .7rem;border-bottom:1px solid var(--border);text-align:left}
th{color:var(--muted);font-weight:500;font-size:.75rem;text-transform:uppercase}
code{background:var(--code-bg);border:1px solid var(--border);border-radius:4px;padding:1px 5px;font-size:.8rem;color:#7dd3fc}
</style>
</head>
<body>
<div class="container">
  <h1>🌐 Universal Mirror Proxy </h1>
  <p class="subtitle">Cloudflare Workers · 多平台镜像加速代理</p>

  <!-- 统计面板 -->
  <div class="stats-panel">
    <h2><span class="status-dot"></span>拉取统计 <span style="font-size:.75rem;color:var(--muted);font-weight:400" id="update-time"></span></h2>
    <div id="stats-content"><p class="loading">加载统计数据…</p></div>
  </div>

  <!-- 使用说明 -->
  <div class="section">
    <h2>🐳 Docker Hub <span class="badge">OCI</span></h2>
    <pre># /etc/docker/daemon.json
{
  "registry-mirrors": ["https://${D.docker}"]
}
sudo systemctl daemon-reload && sudo systemctl restart docker
docker pull nginx:latest</pre>
    <p class="note">直接 pull：<code>docker pull ${D.docker}/library/nginx:latest</code></p>
  </div>
  <div class="section">
    <h2>📦 GHCR / GCR / GAR / Quay <span class="badge">OCI</span></h2>
    <pre>docker pull ${D.ghcr}/&lt;owner&gt;/&lt;image&gt;:&lt;tag&gt;
docker pull ${D.gcr}/google-containers/pause:3.9
docker pull ${D.gar}/&lt;project&gt;/&lt;repo&gt;/&lt;image&gt;:&lt;tag&gt;
docker pull ${D.quay}/&lt;namespace&gt;/&lt;image&gt;:&lt;tag&gt;</pre>
  </div>
  <div class="section">
    <h2>📦 npm / PyPI / GitHub <span class="badge">其他</span></h2>
    <pre>npm config set registry https://${D.npm}
pip config set global.index-url https://${D.pypi}/simple
# GitHub 文件：把 github.com 替换为 ${D.github}</pre>
  </div>
  <div class="section">
    <h2>🗺️ 子域名路由</h2>
    <table>
      <tr><th>子域名</th><th>代理目标</th></tr>
      <tr><td><code>${D.docker}</code></td><td>registry-1.docker.io</td></tr>
      <tr><td><code>${D.ghcr}</code></td><td>ghcr.io</td></tr>
      <tr><td><code>${D.gcr}</code></td><td>gcr.io</td></tr>
      <tr><td><code>${D.gar}</code></td><td>us-docker.pkg.dev</td></tr>
      <tr><td><code>${D.quay}</code></td><td>quay.io</td></tr>
      <tr><td><code>${D.npm}</code></td><td>registry.npmjs.org</td></tr>
      <tr><td><code>${D.pypi}</code></td><td>pypi.org</td></tr>
      <tr><td><code>${D.github}</code></td><td>github.com</td></tr>
    </table>
  </div>
</div>

<script>
const PLATFORM_COLORS = {dockerhub:'#5b8af5',docker:'#5b8af5',npm:'#f59e0b',pypi:'#4ade80',github:'#f472b6',ghcr:'#818cf8',gcr:'#34d399',gar:'#fb923c',quay:'#a78bfa'};
const PLATFORM_LABEL = {dockerhub:'Docker Hub',docker:'Docker Hub',npm:'npm',pypi:'PyPI',github:'GitHub',ghcr:'GHCR',gcr:'GCR',gar:'GAR',quay:'Quay'};

async function loadStats() {
  try {
    const r = await fetch('/api/stats');
    const data = await r.json();
    if (data.error) { document.getElementById('stats-content').innerHTML = '<p class="err">⚠ ' + data.error + '</p>'; return; }
    renderStats(data);
    document.getElementById('update-time').textContent = '· 刚刚更新';
  } catch(e) {
    document.getElementById('stats-content').innerHTML = '<p class="err">⚠ 获取统计失败：' + e.message + '</p>';
  }
}

function renderStats(data) {
  const today = data.days[0] || {};
  const total7 = data.days.reduce((s, d) => s + (d.total || 0), 0);
  // 优先用 images 维度累加的 totalImagePulls（最准确，不受 daily 历史字段缺失影响）
  const totalPulls = data.totalImagePulls ?? data.days.reduce((s, d) => s + (d.pulls || d.byEvent?.manifest || 0), 0);
  const totalErrors = data.days.reduce((s, d) => s + (d.errors || 0), 0);

  // 平台汇总（7天）
  const platformTotals = {};
  data.days.forEach(d => { Object.entries(d.byPlatform || {}).forEach(([k,v]) => { platformTotals[k] = (platformTotals[k]||0)+v; }); });
  const maxPlatform = Math.max(...Object.values(platformTotals), 1);

  // 每日柱状图
  const maxDay = Math.max(...data.days.map(d => d.total || 0), 1);
  const dayBars = [...data.days].reverse().map(d => {
    const h = Math.round(((d.total||0) / maxDay) * 56) + 4;
    const label = d.date.slice(5);
    return \`<div class="day-bar" style="height:\${h}px"><span class="tip">\${d.date} · \${d.total||0} 次</span></div>\`;
  }).join('');
  const dayLabels = [...data.days].reverse().map(d => \`<span class="day-label">\${d.date.slice(5)}</span>\`).join('');

  // 镜像 Top 排行
  const maxImg = Math.max(...(data.images||[]).map(i => i.total||0), 1);
  const imgRows = (data.images||[]).slice(0,8).map(i => {
    const pct = Math.round(((i.total||0)/maxImg)*100);
    const failBadge = i.failed ? \`<span style="color:var(--danger);font-size:.72rem;margin-left:4px" title="失败 \${i.failed} 次">✕\${i.failed}</span>\` : '';
    return \`<div class="bar-row"><span class="bar-label" title="\${i.image}">\${i.image.replace('library/','')}\${failBadge}</span><div class="bar-track"><div class="bar-fill" style="width:\${pct}%;background:var(--accent)"></div></div><span class="bar-num">\${i.total}</span></div>\`;
  }).join('') || '<p style="font-size:.8rem;color:var(--muted)">暂无数据</p>';

  // 平台分布
  const platformRows = Object.entries(platformTotals).sort((a,b)=>b[1]-a[1]).map(([k,v]) => {
    const pct = Math.round((v/maxPlatform)*100);
    const color = PLATFORM_COLORS[k] || 'var(--accent)';
    return \`<div class="bar-row"><span class="bar-label">\${PLATFORM_LABEL[k]||k}</span><div class="bar-track"><div class="bar-fill" style="width:\${pct}%;background:\${color}"></div></div><span class="bar-num">\${v}</span></div>\`;
  }).join('') || '<p style="font-size:.8rem;color:var(--muted)">暂无数据</p>';

  document.getElementById('stats-content').innerHTML = \`
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-val">\${total7}</div><div class="kpi-label">7天总请求</div></div>
      <div class="kpi"><div class="kpi-val">\${today.total||0}</div><div class="kpi-label">今日请求</div></div>
      <div class="kpi"><div class="kpi-val">\${totalPulls}</div><div class="kpi-label">7天镜像拉取</div></div>
      <div class="kpi"><div class="kpi-val" style="color:\${totalErrors>0?'var(--danger)':'var(--accent2)'}">\${totalErrors}</div><div class="kpi-label">7天错误数</div></div>
    </div>
    <div class="chart-row">
      <div class="chart-box">
        <div class="chart-title">近7天请求量</div>
        <div class="day-chart">\${dayBars}</div>
        <div class="day-labels">\${dayLabels}</div>
      </div>
      <div class="chart-box">
        <div class="chart-title">平台分布（7天）</div>
        \${platformRows}
      </div>
    </div>
    <div class="chart-row">
      <div class="chart-box">
        <div class="chart-title">镜像拉取 Top 8</div>
        \${imgRows}
      </div>
    </div>
  \`;
}

loadStats();
setInterval(loadStats, 30000); // 每30秒刷新
</script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}
