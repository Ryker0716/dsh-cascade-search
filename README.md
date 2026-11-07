# dsh-cascade-search

给 DeepSeek Harness 的 `web_search` 加三级降级链的插件：

```
tavily-proxy  →  querit  →  deepseek-search-api
   本地免费      第三方配额      官方计费 5元/1000次
```

前一级不可用（未配置 / 读取凭据失败 / 报错 / 超时 / 返回 0 条且没有摘要）时自动降级到下一级，并写一条不含密钥的 warn 日志。官方 API 是最后一道防线，正常情况下不会产生费用。

每级超时是**单次请求的总等待上限**，包含读取响应正文。用户主动取消搜索会立即停止，不会继续调用后面的后端。

## 为什么需要插件

Harness 的 `ctx.web` 只解析**一个** search provider id，自身没有优先级链：

```js
// dsh-web 的 WebRuntime.search()
const configuredId = this.config.searchProvider.get() ?? this.searchProviderEnv
return capSources(await resolveProvider({ providers: this.searchProviders, configuredId }).search(...))
```

`$DSH_WEB_SEARCH_PROVIDER` 也只是同一个字段的环境变量覆盖，源码注释明确写着 *"NOT a hidden priority chain"*。所以降级逻辑只能放进单个 provider 内部——就是这个插件。

## 安装

### GitHub/npm 安装

这是给社区用户和希望用 `dsh plugin add <包名>` 的安装方式。可选择官方 Git 仓库或 npm 包名：

```bash
# GitHub 安装
dsh plugin add github:Ryker0716/dsh-cascade-search

# npm 安装
dsh plugin add dsh-cascade-search

# 指定 web profile
dsh plugin --profile web add github:Ryker0716/dsh-cascade-search
# 或
dsh plugin --profile web add dsh-cascade-search
```

安装后**重启** DSH；在 **插件 → 已安装插件 → dsh-cascade-search** 进行凭据和链配置。

### 接收压缩包的人

> 本插件的开发主版本以 GitHub/npm 发布为准；ZIP 只是为了在本机传递或初始导入方便。
>
> **离线 ZIP 接收方**请按这一节安装；其他人用 GitHub/npm 安装见 [GitHub/npm 安装](#githubnpm-安装)。


先解压 ZIP 到一个**固定目录**，例如 `~/dsh-cascade-search`，然后使用对应 profile 的插件管理命令：

```bash
# 只适用于 CLI 管理的 profile；会写入 package.json 并自动登记 bundle。
dsh plugin add ~/dsh-cascade-search
```

如果也在 `web` profile 中使用，再执行：

```bash
dsh plugin --profile web add ~/dsh-cascade-search
```

装完**重启 DeepSeek Harness 桌面端**或对应 Host。macOS/Linux 的路径写成 `$HOME/dsh-cascade-search` 更通用；不能把示例原样用于 Windows。不要只解压而不加进 profile，也不要随意删除或移动已安装的插件目录。

### 在桌面端所在的 profile 手动安装

桌面 profile 不能通过 CLI 修改；把解压目录放在自己选定的位置后，编辑 `~/.dsh/profiles/desktop/package.json`：

```jsonc
{
  "dependencies": {
    // 使用解压后的绝对路径，或按该 package.json 位置计算正确的相对路径。
    "dsh-cascade-search": "link:/绝对路径/dsh-cascade-search"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-cascade-search"] // 保留已有 bundle，追加这一项。
    }
  }
}
```

然后执行：

```bash
cd ~/.dsh/profiles/desktop
CI=true pnpm install --no-frozen-lockfile
```

对方的 `package.json` 可能已经有很多依赖和 bundle，**只追加本插件，不要覆盖整个文件**。安装后不要把原来的 `link:` 指向解压包带走的 `node_modules`；此 ZIP 不含它，宿主提供声明在 package.json 中的 peer 依赖。

## 凭据

插件按 `credentialRef` 到 Harness 的 credentials 服务（`$DSH_HOME/.credentials.yaml`）取密钥，每次搜索现取，不缓存——所以新增密钥无需重启。

| 后端 | 默认 ref |
|---|---|
| tavily-proxy | `TAVILY_PROXY_AUTH_KEY`（代理自己的管理 authKey，不是 `tvly-*` 池 Key） |
| querit | `QUERIT_API_KEY` |
| deepseek | `DEEPSEEK_API_KEY` |

密钥**只能**经由凭据库或设置页写入——config 里没有 `apiKey` 字面量字段，避免密钥落进配置文件。

## 图形化设置

装好后打开 **插件 → 已安装插件 → dsh-cascade-search**，包详情页底部就是本插件的设置面板：

- 降级顺序（逗号分隔，可任意重排）
- 接管网页搜索开关
- 每一级的：启用开关、接口地址、密钥名称、密钥、超时
- 保存后**立刻生效**，不需要重启

密钥框是 `type="password"`，只显示「已配置 / 未配置」，回读时值永不出网；填新值即覆盖，留空则保持原密钥不变。

实现上，设置页是插件的 client 半侧（`lib/client.js`），注册到 `plugins.bundle.config` slot（key 为包名 `dsh-cascade-search`）；它编辑的命名空间是 loader 行 id `cascade-search`。

## 配置（命令行 / 手改）

等价于设置页，直接改 profile 的 `cordis.patch.yml`：

```yaml
- id: cascade-search
  name: dsh-cascade-search
  config:
    order: [tavily, querit, deepseek]      # 优先级，可任意重排
    adopt: true                            # 见下节
    tavilyEnabled: true                    # false = 跳过该级，不删密钥
    tavilyUrl: http://localhost:9100
    tavilyCredentialRef: TAVILY_PROXY_AUTH_KEY
    tavilyTimeoutMs: 10000                 # 该级独立预算
    tavilyDepth: basic                     # basic | advanced
    queritEnabled: true
    queritUrl: https://api.querit.ai/v1/search
    queritCredentialRef: QUERIT_API_KEY
    queritTimeoutMs: 25000
    deepseekEnabled: true
    deepseekUrl: https://api.deepseek.com/v1/tools/search
    deepseekCredentialRef: DEEPSEEK_API_KEY
    deepseekTimeoutMs: 60000
```

> [!note] 为什么字段是扁平的
> 设置页一个控件对应一个字段，写路径只有单段（`path: ['tavilyUrl']`）。嵌套的 `tavily.url` 在 GUI 里不可达，所以字段一律「后端前缀 + 驼峰」。旧版的嵌套写法已不再被 schema 接受。

> [!warning] patch 对 `config` 是整体替换，不是深合并
> 只写 `order` 会让其余字段回到默认值。要改某级参数，把整个 `config` 写全——或者干脆用设置页，它只写被改动的那几个键。

### 不想让官方 API 兜底

把 `deepseekEnabled` 设为 `false`（密钥保留，随时可开回来），或从 `.credentials.yaml` 删掉 `DEEPSEEK_API_KEY`。

## 为什么需要 `adopt`

`dsh.bundle.patch` 属于 bundle 层，**先于**用户 profile 应用。如果 profile 或 GUI 把 `web.config.searchProvider` 钉成别的 id，会静默覆盖插件。

所以插件在 `apply()` 时改写 seam 的 volatile 配置引用，把自己设为选中 provider：

```js
ref[Symbol.for('cosmokit.volatile.write')]('cascade-search')
```

seam 每次搜索都读这个引用，因此在同一次运行会话中，GUI 后来切换搜索源也不会改掉这个选择。副作用是那个单选对搜索不再生效——想改策略请改本插件的 `order`。**adopt 只运行一次，不需要连续监控**；如果操作系统完整重启了宿主，而另一插件随后又把引用改走，修改本插件任一 volatile 字段重启本插件，或完整重启宿主即可恢复。

如果你确实想让 GUI 接管，把 `adopt` 设为 `false`，然后自己保证 `web.config.searchProvider` 指向 `cascade-search`。

## 设计要点

- **`available()` 恒返回 `true`**：返回 `false` 会让 seam 抛 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，把三级各自的失败原因全吞掉——那正是本插件要保留的诊断信息。
- **空结果且无摘要才算失败**：某级返回 0 条且没有 `content` 时继续降级；有摘要但暂时没有来源，保留摘要，不多花一次搜索费用。
- **取消不降级**：调用方取消时立即抛宿主约定的 `WEB_ABORTED`，不会误触下一级的计费请求。凭据读取和网络请求（含响应正文）都服从取消与超时。
- **每级失败隔离**：不存在的凭据可跳过，读取凭据被拒绝会记录为该级错误并降级，不再伪装成「未配置」。
- **快照一致**：每次搜索先同步固定 order、URL、密钥引用和超时，再异步读密钥，避免设置页保存途中把新接口和旧密钥混用。
- **错误类注入**：优先用 seam 自己的 `WebError`，让上游 `instanceof` 判断成立；末级错误码为 `WEB_PROVIDER_ERROR`，并带各级原因。
- **敏感信息脱敏**：上游错误与日志移除实际密钥、常见 token 与授权头，不把完整错误响应当原文转发。
- **`maxResults` 按后端钳制**：tavily 上限 20、querit/deepseek 上限 50，避免把非法值透传出去。

## 测试

```bash
npm test             # 35 个用例，纯本地，不需要 profile 和网络
npm run check        # 检查四个实现文件的 JavaScript 语法
```

引擎 `lib/cascade.js` 不 import 任何宿主包，所以能脱离 Harness 单测；`lib/config.js` 才需要 `@deepseek-ai/schemastery`（宿主提供的 peer）。

## 结构

```
package.json           # dsh.bundle.patch 指向 cordis.patch.yml；dsh.client 声明浏览器半侧
cordis.patch.yml       # 挂载条目
lib/index.js           # Cordis 包装：注册、adopt、取密钥
lib/cascade.js         # 纯降级引擎（无依赖）
lib/config.js          # schemastery 配置 schema（全 volatile）
lib/client.js          # 设置页（浏览器半侧）
test/cascade.test.js   # 引擎、降级、取消、超时和脱敏测试
test/index.test.js     # 注册、凭据读取、配置快照及生效测试
test/config.test.js    # 与宿主同版本 schemastery 的 schema 边界测试
```

浏览器半侧不走 ESM，而是 `window.__ModuleLoader__.load({ id, factory })` 包一层 CJS 风格 bundle，`require` 平台共享模块（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-store`）。`package.json` 必须同时有 `exports["./client"]` 与 `dsh.client.platform: "web"`，Host 才会把 bundle 发到浏览器。

## 排障

三级全失败时会一次性列出所有原因：

```
all search backends failed for "..." — tavily-proxy: HTTP 500: {...Tavily API error 432...};
querit: HTTP 401: bad key; deepseek-search-api: HTTP 404
```

常见情况：

| 现象 | 原因 |
|---|---|
| `tavily-proxy: not configured` | 缺 `TAVILY_PROXY_AUTH_KEY`，或代理没起（`lsof -nP -iTCP:9100 -sTCP:LISTEN`） |
| `tavily-proxy: HTTP 500 ... 432` | Tavily 池里 Key 的套餐超限，换 Key 或让 querit 接管 |
| `deepseek-search-api: HTTP 404` | endpoint 写错，应为 `https://api.deepseek.com/v1/tools/search` |
| 三级全 `not configured` | `ctx.get('credentials')` 取不到服务，或 ref 名字不对 |
