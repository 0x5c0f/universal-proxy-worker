# 🌐 Universal Mirror Proxy

基于 Cloudflare Workers 的多平台镜像加速代理，支持 Docker Hub、GHCR、GCR、Quay、npm、PyPI 和 GitHub 文件下载。无需服务器，免费计划即可运行。

## ✨ 功能特性

- **多平台支持**：一个 Worker 覆盖主流镜像源
- **子域名路由**：每个平台独立子域名，Docker 可直接配置 `registry-mirrors`，无需修改 pull 命令
- **拉取统计**：基于 KV 持久化存储，首页实时展示请求量、镜像拉取排行、失败统计
- **零运维**：部署在 Cloudflare 边缘网络，自动 HTTPS，全球加速
- **免费运行**：CF Workers 免费计划每日 10 万次请求，KV 1000 次写入，个人使用完全够用

## 📦 支持平台

| 平台 | 子域名 | 用途 |
|------|--------|------|
| Docker Hub | `docker.your-domain.com` | 拉取 Docker 官方及第三方镜像 |
| GitHub Container Registry | `ghcr.your-domain.com` | ghcr.io 镜像加速 |
| Google Container Registry | `gcr.your-domain.com` | gcr.io 镜像加速 |
| Google Artifact Registry | `gar.your-domain.com` | us-docker.pkg.dev 加速 |
| Quay.io | `quay.your-domain.com` | Red Hat 系镜像加速 |
| npm Registry | `npm.your-domain.com` | npm / yarn / pnpm 加速 |
| PyPI | `pypi.your-domain.com` | pip 加速 |
| GitHub 文件 | `gh.your-domain.com` | Release 附件 / Raw 文件下载加速 |

## 🚀 部署

### 前置条件

- Cloudflare 账号（免费计划即可）
- 域名托管在 Cloudflare（NS 指向 CF）
- Node.js 18+，已安装 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

```bash
npm install -g wrangler
wrangler login
```

### 步骤

**1. 克隆项目**

```bash
git clone https://github.com/0x5c0f/universal-mirror-proxy.git
cd universal-mirror-proxy
```

**2. 初始化配置文件**

```bash
cp wrangler.toml.example wrangler.toml
```

然后编辑 `wrangler.toml`，将所有 `your-domain.com` 替换为你自己的域名：

```toml
[[routes]]
pattern = "docker.your-domain.com/*"
zone_name = "your-domain.com"
# ... 其余平台同理
```

> `wrangler.toml` 已在 `.gitignore` 中排除，真实配置不会被提交。

**3. 创建 KV namespace（统计存储）**

```bash
wrangler kv namespace create MIRROR_STATS
```

将输出的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "MIRROR_STATS"
id = "你的 namespace id"
```

**4. 在 CF DNS 添加子域名记录**

为每个平台添加 CNAME 记录，内容填根域名，**必须开启橙云（Proxied）**：

| 名称 | 类型 | 内容 | 代理状态 |
|------|------|------|---------|
| `docker` | CNAME | `your-domain.com` | 🟠 已代理 |
| `ghcr` | CNAME | `your-domain.com` | 🟠 已代理 |
| `gcr` | CNAME | `your-domain.com` | 🟠 已代理 |
| `gar` | CNAME | `your-domain.com` | 🟠 已代理 |
| `quay` | CNAME | `your-domain.com` | 🟠 已代理 |
| `npm` | CNAME | `your-domain.com` | 🟠 已代理 |
| `pypi` | CNAME | `your-domain.com` | 🟠 已代理 |
| `gh` | CNAME | `your-domain.com` | 🟠 已代理 |

> CNAME 内容填什么不重要，请求会被 Worker Route 拦截，橙云才是关键。

**5. 部署**

```bash
wrangler deploy
```

部署完成后访问 `https://docker.your-domain.com` 查看首页和统计面板。

## 🔧 客户端配置

### Docker Hub（透明加速，无需修改 pull 命令）

```json
// /etc/docker/daemon.json
{
  "registry-mirrors": ["https://docker.your-domain.com"]
}
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart docker
docker pull nginx:latest  # 自动走代理
```

### GHCR / GCR / GAR / Quay（手动指定代理域名）

```bash
docker pull ghcr.your-domain.com/<owner>/<image>:<tag>
docker pull gcr.your-domain.com/google-containers/pause:3.9
docker pull gar.your-domain.com/<project>/<repo>/<image>:<tag>
docker pull quay.your-domain.com/<namespace>/<image>:<tag>
```

### npm

```bash
# 全局配置
npm config set registry https://npm.your-domain.com
# 项目级 .npmrc
echo "registry=https://npm.your-domain.com" > .npmrc
```

### PyPI

```bash
pip install numpy -i https://pypi.your-domain.com/simple
# 永久配置
pip config set global.index-url https://pypi.your-domain.com/simple
pip config set global.trusted-host pypi.your-domain.com
```

### GitHub 文件下载

```bash
# Release 附件：把 github.com 替换为 gh.your-domain.com
https://gh.your-domain.com/<owner>/<repo>/releases/download/<tag>/<file>

# Raw 文件
https://gh.your-domain.com/raw/<owner>/<repo>/<branch>/<path>

# 源码归档
https://gh.your-domain.com/<owner>/<repo>/archive/refs/heads/main.zip
```

## 📊 统计面板

部署完成后访问任意子域名根路径（如 `https://docker.your-domain.com`）即可看到统计面板，包含：

- 近 7 天请求量趋势图
- 今日 / 7 天总请求数、镜像拉取次数、错误数
- 各平台流量分布
- 镜像拉取 Top 8（含失败标记）

统计面板每 30 秒自动刷新，数据持久化存储在 KV，保留 30 天。

## 🔍 实时日志

```bash
wrangler tail --format pretty
```

每次拉取会输出结构化日志，包含平台、镜像名、响应状态和耗时：

```json
{"ts":"2025-05-19T10:00:02Z","platform":"docker","event":"manifest","image":"library/nginx","ref":"latest","status":200,"ms":180}
{"ts":"2025-05-19T10:00:03Z","platform":"docker","event":"blob","image":"library/nginx","digest":"sha256:57fb712460…","status":302,"ms":95}
```

## 🏗️ 扩展新平台

在 `universal-proxy-worker.js` 的 `REGISTRY_CONFIGS` 对象中追加配置即可，无需修改主逻辑：

```js
// 示例：添加 k8s.gcr.io
k8sgcr: {
  pathPrefix: "/k8sgcr",
  subdomainKeywords: ["k8sgcr"],
  type: "docker",   // 复用 Docker OCI 协议处理器
  upstream: {
    registry: "https://k8s.gcr.io",
    auth:     "https://k8s.gcr.io",
    authService: "k8s.gcr.io",
  },
},
```

支持的 `type`：
- `docker`：兼容 OCI Distribution Spec 的所有 registry
- `npm`：npm 兼容 registry
- `pypi`：PyPI 兼容 registry
- `github`：GitHub 文件下载

## ⚠️ 注意事项

- 本项目仅供个人学习和合规使用，请勿用于违反相关服务条款的用途
- CF Workers 免费计划每日 10 万次请求上限，超出后次日自动恢复，不产生额外费用
- `workers.dev` 默认域名在中国大陆可能受 SNI 阻断影响，建议使用自定义域名

## 📄 License

MIT
