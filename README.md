# 竹里集 · 竹编生活美学

跨境电商单页站：一个 Worker 文件里同时提供整站 HTML/CSS/JS、REST API 和 SQLite 数据层。

## 数据层（SQLite）

商品、订单、后台管理员与登录会话全部存在 SQLite 中，不再使用进程内存数组：

| 表 | 用途 |
| --- | --- |
| `products` | 商品主数据，多语言文案与图片列表以 JSON 列存储（`translations_json` / `images_json`） |
| `orders` | 订单，收货人快照存 `customer_json`，行项目存 `items_json`，含连连交易号 |
| `admin_users` | 后台账号，口令为 PBKDF2-SHA256（120k 次迭代 + 16 字节盐），只存哈希 |
| `admin_sessions` | 登录会话，随机 32 字节 token 的 SHA-256 哈希 + 过期时间（默认 12 小时） |

驱动选择：

- 有 `env.DB`（D1 绑定）时走 D1 的 `prepare/bind/all` —— 线上托管推荐路径。
- 否则惰性 `import('node:sqlite')`，落到 `SQLITE_PATH` 指定的本地文件（默认 `data/zhuliji.sqlite`，已加 `.gitignore`）。

首次启动自动建表，并在 `products` 为空时写入 6 条种子商品；`admin_users` 为空时按 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 创建管理员。之后以数据库为准，改密码重设环境变量并重启即可轮换（会同时清掉该账号的历史会话）。

## 商城会员（邮箱密码登录）

商城顶栏「登录」支持邮箱密码注册 / 登录，四语言界面文案齐全：

- 数据表：`customers`（邮箱唯一，PBKDF2-SHA256 口令哈希，与后台同一套算法）、`customer_sessions`（token 哈希 + 过期时间，默认 12 小时）。表结构在 `SCHEMA_SQL` 中，老库重启即自动补表，无需迁移。
- 接口：`POST /api/auth/register`（邮箱 + ≥8 位密码 + 可选昵称，重复邮箱 409）、`POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout`（均带 `x-customer-token` 头）。社交登录占位保留，返回 501 待接 OAuth。
- 前端：登录弹窗含「登录 / 注册」切换，注册态多一个昵称字段且密码 `autocomplete=new-password`；登录后顶栏显示「Hi, 昵称」，点击进入「我的账号」弹窗可退出；刷新页面通过 `/api/auth/me` 恢复会话；登录用户的邮箱 / 姓名会自动预填结算表单。
- 错误提示（弱密码、邮箱格式、密码错误、邮箱已注册等）已按中 / 英 / 德 / 意本地化。

## 后台账号

后台入口 `/admin`。账号不再硬编码，也不再预填在登录表单里：

```bash
ADMIN_EMAIL=owner@yourdomain.com
ADMIN_PASSWORD='用足够长的随机口令'
ADMIN_NAME=竹里集管理员
```

未配置这两项时，`POST /api/admin/login` 返回 503 `admin_not_configured`，页面会直接提示去配环境变量。

会话通过 `x-admin-token` 请求头校验，服务端按哈希查表 + 校验过期时间；`POST /api/admin/logout` 会立即作废当前 token。

后台界面**固定为中文**，没有语言切换器（登录页与顶栏均无），且不会写回商城的语言偏好——前台的四语言切换只影响商城页面。表单里的「文案语言」下拉用于录入商品的多语言文案（内容，非界面语言），保留不变。

## 后台商品管理

「添加商品」与「编辑商品」共用同一套表单组件：

- **多语言文案**：顶部一个「文案语言」下拉（中文 / English / Deutsch / Italiano），下方三组字段（商品名称、简短描述、详情页长描述）随语言切换，各自独立填写。切换语言不会丢失已输入内容；某个语言留空时，保存会自动沿用中文（其次 English）的对应文案，因此四种语言的 `translations` 永远是完整的。
- **封面图**：列表卡片封面，单张，上传前用 canvas 压到最长边 1400px、JPEG 0.82。
- **详情页画廊图**：可多选批量上传（压缩到 1600px），缩略图带「×」可逐张移除，清空后详情页回落到默认大图。第一张排在详情页最前，商品列表里显示张数。
- 图片统一写入 `media` 表（base64），通过 `GET /media/:id` 读取并带 30 天缓存；上传接口 `POST /api/media` 需要 `x-admin-token`，接受 JPEG / PNG / WebP，单张上限 4MB（前端已压缩）。

图片规格（表单里直接标注，且**强制校验**）：

| 位置 | 要求尺寸 | 最低尺寸 | 比例 | 说明 |
| --- | --- | --- | --- | --- |
| 商品封面图 | 1200 × 800 px | 900 × 600 px | 3:2 横图 | 卡片封面区高 248px、`object-fit: cover`，非 3:2 会裁掉两侧 |
| 详情页画廊图 | 1600 × 1000 px | 1120 × 700 px | 16:10 横图 | 详情主图固定 310px 高、宽度随版心，超出部分居中裁切 |

单张 ≤ 4MB；封面压缩到宽 1400px，详情图压缩到最长边 1600px（JPEG 质量 0.82），均在浏览器端完成。

**不合格的图片直接拒绝上传**（不会入库，也不会写入商品）：比例偏差超过 3% 或宽/高低于最低尺寸时，选图后立即被拦下，规格条下方显示红字原因（同时弹一次 toast），例如：

- 「封面图比例不符：当前 1.33:1，需要 1.50:1（3:2 横图，如 1200 × 800 px），请先裁切再上传」
- 「详情图尺寸不足：当前 1000 × 640 px，至少需要 1120 × 700 px（建议 1600 × 1000 px）」

批量上传详情图时逐张校验，合格的照常入库，被拒的跳过并汇总提示；下一次全部合格后红字自动清除。校验在浏览器端用原图分辨率完成，不会先把大图传上去再退回。

## 后台订单管理

「订单管理」标签页与「经营总览」的最近订单共用同一张表格，每行新增**「详情」**按钮，点开一个订单详情弹窗：

- **收货信息**：收件人、邮箱、电话、国家/地区、详细地址（地址 1 + 地址 2）、城市 · 州省 · 邮编。
- **订单信息**：**支付状态**（待支付 / 已支付 / 已退款）与**发货状态**（待发货 / 已发货 / 已送达）两个独立维度，另有物流单号、结算币种、下单/更新时间、折合美元；弹窗内可分别修改支付状态、发货状态并填写物流单号，点「保存状态」后列表行的徽章与单号同步刷新。
- **商品明细**：逐行显示商品名、商品 ID、结算币种单价（若下单时原币与结算币种不同，附注「原币 ¥xx」）、数量与小计。
- **金额**：合计（币种代码）；商品价格已含运费，不再单列运费行。
- **交易信息**：有连连交易号或商户交易号时显示。
- **复制收货地址**：一键把收件人、电话、地址、订单号复制到剪贴板，方便打包发货。

状态更新与列表共用 `PUT /api/orders/:id`：请求体传 `{ paymentStatus, shippingStatus, trackingNo }`。发货状态设为「已发货 / 已送达」时**必须填写物流单号**，否则接口返回 400。综合状态（保留的 `status` 列）由两维自动推导：已退款→已取消、未支付→待支付、已支付→处理中、已发货→已发货、已送达→已送达。老库在启动时自动补列并按旧状态回填（历史演示单标记为已支付）。

**销售口径**：「经营总览」的累计销售额只统计**支付状态为「已支付」**的订单金额总和（按固定汇率折合 USD）；未支付与已退款不计入。统计卡下方标注「其中已支付 N 笔」与口径说明；订单数量仍显示全部订单。演示模式下没有真实收银台，下单即视为支付成功，与连连支付回调（`payment_status` 置为 `paid`）保持一致。

在使用建议（多语言四栏之一）里填写后，商品详情页会在「关于这件手作」下方增加一个「使用建议」区块（英文页为 How to use & care），支持多段文字（换行分段）；未填写的语言自动沿用中文，全部为空时该区块不显示。

## 商品详情页（独立路由）

商品列表的卡片**整卡可点击**，直接跳转到独立详情页 `/product/:id`（原来的「查看商品详情」弹窗按钮已删除）：

- **路由**：Worker 对所有非 API 路径返回同一份应用 HTML，前端按 `location.pathname` 匹配 `/product/:id` 渲染详情页；`/product/未知id` 显示 404 提示页。
- **详情页内容**：面包屑、主图 + 缩略图画廊、名称 / 分类 / 角标、当前语言档位价格（含币种代码与划线价）、简短描述、立即购买（加购并打开购物车抽屉）与加入购物车、长描述「关于这件手作」、以及最多 3 个「你可能也喜欢」相关商品卡。
- **复用与联动**：详情页复用商城的顶栏 / 页脚 / 购物车抽屉 / 登录与结账弹窗；顶栏语言切换在详情页上原地刷新（保持滚动位置），价格与文案随之切换；`document.title` 会更新为「商品名 · 竹里集」。
- **数据来源**：与商品列表一致（`products` 表 + `translations_json` / `images_json` / `cover_image` / `prices_json`），无额外接口。

## 多币种（按语言定价）

一个商品可以有**多组币种与金额**：每个语言档位（中文 / English / Deutsch / Italiano）独立设置币种和价格，前台按访客当前语言显示对应金额，下单也按该语言的价格计价：

- **后台录入**：商品表单的价格区是四行（每个语言一行），每行 = 金额输入框 + 币种下拉（8 种可选，默认按市场预选：中文 CNY、English USD、Deutsch/Italiano EUR）。金额即该市场的实收价格，原样入库（`products.prices_json`，形如 `{"zh":{"currency":"CNY","amount":328},...}`），各档位之间不做换算。下方实时提示四个语言的取价结果。
- **取价顺序**：访客语言档位 → 中文档 → 英文档 → 基础价（`price`/`price_currency`，兼容旧数据）。某个语言留空时自动回退，不会出现无价可显。
- **前台展示**：商品卡与详情页按当前语言显示对应币种金额，附币种代码小字（如中文站 `¥328.00 CNY`、英文站 `$48.00 USD`）。划线原价只在币种与当前档位一致时显示。
- **购物车与下单**：购物车按当前语言的档位价格计算；下单请求带上 `locale`，服务端用同一套取价规则复算，金额与前台所见一致。单一币种直接按该币种收款；混合币种时结算币种 = 「折合 USD 小计最高」的档位币种，其余按固定汇率折算，行项目保留原币金额（`priceCurrency` / `originalPrice` / `priceLocale`）。
- **订单**：订单记录 `locale`（下单语言）与 `currency`；**商品价格已包含运费，订单合计 = 商品小计**，不再计算免邮门槛与运费（历史订单在启动时自动把 `shipping` 归零、`total` 对齐 `subtotal`）；连连支付 `order_currency_code` 使用订单币种，商品行里不再追加 shipping 行。
- **后台展示**：商品列表「售价」列显示全部档位（如「¥328.00 CNY 中文 · $48.00 · €46.00 · €46.00」）；订单列表金额按订单币种显示并附折合 USD 参考值；「累计销售额」统一折合 USD 统计。
- **汇率**：固定汇率表在 `worker/index.js` 的 `CURRENCIES` 常量里（`rate` = 1 USD 可兑换的目标币种数量），仅在混合币种折算与后台参考值时使用。旧库升级自动补 `prices_json` 列，并把历史基础价按汇率回填成四档（后续在后台改价即覆盖）。


## 社交登录

`POST /api/auth/social` 目前返回 501 `social_login_not_configured` —— 之前的实现会直接下发伪造的 `google-demo-session`，已移除。真正接入需要 Google / Apple 的 OAuth 客户端凭据与服务端回调，尚未实现。

## 连连全球收单配置

The site uses the LianLian hosted cashier flow for one-time physical-goods payments. The backend creates a payment order and redirects the customer to the LianLian `payment_url`; fulfillment is driven by the signed asynchronous notification at `/api/lianlian/notify`, not by the browser redirect.

Configure these runtime secrets in Sites before enabling live payment:

- `LIANLIAN_MERCHANT_ID`: the 18-digit LianLian acquiring merchant ID.
- `LIANLIAN_PRIVATE_KEY`: the merchant PKCS#8 RSA private key used to sign API requests. Store it as a multiline secret.
- `LIANLIAN_PUBLIC_KEY`: LianLian’s public key used to verify payment notifications.
- `LIANLIAN_ENV`: `sandbox` (default) or `production`.
- `LIANLIAN_SITE_URL`: optional public site URL used in the order’s website metadata.

The production flow uses `https://gpapi.lianlianpay.com`; sandbox uses `https://celer-api.LianLianpay-inc.com`. Apply for a LianLian test merchant, complete the hosted cashier acceptance tests, and only then switch the environment and merchant ID to production.

If the LianLian secrets are missing, the storefront falls back to the demo order API（订单仍会写入 SQLite）and displays a configuration notice.

## 本地运行

```bash
npm run build      # worker/index.js -> dist/server/index.js
npm run validate   # 校验产物是合法 ESM 且导出 default.fetch
npm run smoke      # 接口冒烟测试，使用独立测试库，跑完自动清理
npm run preview    # 默认 http://127.0.0.1:4173
```

`preview.mjs` 支持 `PORT` 覆盖端口，启动时会打印当前 SQLite 路径。没有支付密钥时结账走演示订单流程，订单同样落库，可在 `/admin` 看到。

如需本地联调连连沙箱：

```bash
cp .env.example .env
# 编辑 .env，填入管理员口令与连连测试商户号、RSA 密钥
node --env-file=.env preview.mjs
```

连连异步通知地址必须能被连连服务器访问，`http://127.0.0.1:4173/api/lianlian/notify` 只能用于页面预览，不能用于真实回调联调。联调回调时需要使用 HTTPS 隧道或部署到可访问的测试环境。

## 上线注意

`node:sqlite` 需要可写的持久磁盘。如果托管环境没有持久卷，请改为绑定 D1（`env.DB`），代码无需改动即会自动切换驱动；否则实例重启后数据会回到种子状态。支付回调与订单状态更新都依赖服务端可写存储，这是上线前的硬前提。

## 部署到 Cloudflare Workers

本项目已内置 Cloudflare 部署配置（`wrangler.toml`）与一键部署脚本（`scripts/deploy-cloudflare.mjs`）。

### 一次性准备

1. 登录 Cloudflare（二选一）：

   ```bash
   npx wrangler login                       # 浏览器授权，凭证存在本地
   # 或在 .env / CI 里设置 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ACCOUNT_ID
   ```

   API Token 权限需要 `Workers Scripts:Edit`、`D1:Edit`、`Account Settings:Read`。

2. 准备部署变量（本地可 `cp .env.example .env` 后填入）：

   | 变量 | 类型 | 说明 |
   | --- | --- | --- |
   | `ADMIN_EMAIL` | Secret | 后台管理员邮箱 |
   | `ADMIN_PASSWORD` | Secret | 后台管理员口令（首次建库时写入，之后以数据库为准） |
   | `LIANLIAN_MERCHANT_ID` | Secret | 连连商户号 |
   | `LIANLIAN_PRIVATE_KEY` | Secret | 商户 RSA 私钥（PEM，可整段粘贴） |
   | `LIANLIAN_PUBLIC_KEY` | Secret | 连连平台公钥（PEM，回调验签必需） |
   | `LIANLIAN_ENV` | Var | `production` / `sandbox`，写在 `wrangler.toml` 的 `[vars]` |
   | `LIANLIAN_SITE_URL` | Var | 站点对外地址，留空则用请求域名 |

### 一键部署

```bash
npm run deploy:cf:dry    # 只打包校验，不上传（检查体积与绑定是否正确）
npm run deploy:cf        # 认证 → 建库 → 部署 → 写密钥 → 健康检查
```

脚本会自动完成：

1. 校验 Cloudflare 登录状态；
2. 检查 `zhuliji-db` 这个 D1 数据库是否存在，不存在则创建，并把 `database_id` 回写到 `wrangler.toml`（**首次部署后记得把 wrangler.toml 提交进仓库**）；
3. 执行 `wrangler deploy` 发布 Worker；
4. Worker 存在后把 `ADMIN_*` 与 `LIANLIAN_*` 密钥写入 Worker Secret（未提供的会跳过并提示；Secret 写入后立即生效，无需再次部署）；
5. 访问部署后的首页与 `/api/products` 做健康检查，打印前台与后台地址。

建表与种子数据由 Worker 首次请求时自动完成，**D1 不需要手动跑迁移**。

### GitHub Actions 自动部署

仓库已包含 `.github/workflows/deploy-cloudflare.yml`，推送到 `main` 即自动部署。需在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 同上，需 Workers + D1 编辑权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |
| `D1_DATABASE_ID` | D1 数据库 UUID（首次可用本地脚本创建后复制，用于填充 `wrangler.toml` 占位符） |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 后台账号 |
| `LIANLIAN_MERCHANT_ID` / `LIANLIAN_PRIVATE_KEY` / `LIANLIAN_PUBLIC_KEY` | 连连配置 |

工作流会先做产物校验，再用 `cloudflare/wrangler-action` 部署并写入上述 Secret，最后对线上地址做一次 HTTP 检查。

### 部署后确认

1. 访问 `https://<worker>.workers.dev/`，确认首页、商品详情、多语言切换正常；
2. 用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 登录 `/admin`，商品与订单管理可用；
3. 连连商户后台把异步通知地址登记为 `https://你的域名/api/lianlian/notify`；
4. 沙箱联调时把 `LIANLIAN_ENV` 改为 `sandbox` 并重新部署，验收通过后再切 `production`。

### 体积提示

当前 Worker 打包后约 **2.9 MB（gzip）**，接近 Workers 免费版 3 MB 上限（付费版 10 MB）。主因是 `worker/index.js` 里内嵌的 3 张首页大图与 6 张封面种子图（base64）。若后续还要加内嵌素材，建议把图片改放 Workers Static Assets 或对象存储，可把包体压到 1 MB 以内。

