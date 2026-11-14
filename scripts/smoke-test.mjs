// 本地冒烟测试：直接调用 worker 的 fetch，不启动 HTTP 服务。
// 使用独立的测试数据库，跑完自动清理。
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const DB_PATH = 'data/smoke-test.sqlite';
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_PATH + suffix)) await rm(DB_PATH + suffix, { force: true });
}

const env = { SQLITE_PATH: DB_PATH, ADMIN_EMAIL: 'admin@smoke.local', ADMIN_PASSWORD: 'smoke-password-123' };
const worker = (await import('../worker/index.js')).default;

const call = async (path, options = {}) => {
  const response = await worker.fetch(new Request('http://127.0.0.1:4173' + path, options), env, {});
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, body };
};

const step = (label, ok) => console.log((ok ? '  ok   ' : '  FAIL ') + label);

// 1. 健康检查与种子数据
const health = await call('/api/health');
assert.equal(health.status, 200);
assert.equal(health.body.database, 'sqlite');
assert.equal(health.body.products, 6);
step('health: sqlite 驱动，已播种 6 个商品', true);

const products = await call('/api/products');
assert.equal(products.body.products.length, 6);
assert.equal(products.body.products[0].translations.en.name, 'Misty Morning Basket');
assert.equal(products.body.products[0].priceCurrency, 'USD');
assert.ok(Array.isArray(products.body.products[0].images));
step('products: 结构与多语言字段正常', true);

// 2. 首页 HTML 的背景图引号
const home = await call('/');
assert.equal(home.status, 200);
assert.ok(home.body.includes('background-image:url(/assets/bamboo-valley.jpg)'));
assert.ok(!home.body.includes('background-image:url("/assets/'));
assert.ok(!home.body.includes('bamboo2026'));
step('home: hero 背景图引号已修复，页面无明文密码', true);

// 2a. 商品列表整卡跳转独立详情页，旧「查看商品详情」按钮已删除
assert.ok(!home.body.includes('class="detail-link"'), '列表不应再有查看商品详情按钮');
assert.ok(!home.body.includes('<button class="detail-link"'), '旧详情按钮应彻底移除');
assert.ok(!home.body.includes('data-detail='), '卡片不应保留 data-detail 弹窗钩子');
assert.ok(home.body.includes('class="card-hit"'), '卡片应有整卡跳转锚点');
assert.ok(home.body.includes('/product/'), '卡片应指向 /product/:id');
assert.ok(home.body.includes('function renderProductPage'), '前端应具备独立详情页渲染');
assert.ok(home.body.includes('detail-page-main'), '详情页应使用独立布局');
const detailPage = await call('/product/p-101');
assert.equal(detailPage.status, 200);
assert.ok(detailPage.body.includes('function renderProductPage'), '/product/:id 由前端路由接管');
step('detail: 商品列表整卡跳转 /product/:id，详情按钮已移除', true);

// 2b. 商城前台不再暴露管理员后台入口（/admin 仍可直接访问）
assert.ok(!home.body.includes('href="/admin"'), '前台不应出现后台入口链接');
assert.ok(!home.body.includes('管理员后台'), '前台不应出现「管理员后台」文案');
assert.ok(!detailPage.body.includes('href="/admin"'), '详情页同样不应出现后台入口');
const adminPage = await call('/admin');
assert.equal(adminPage.status, 200);
assert.ok(adminPage.body.includes('admin-login'), '/admin 后台本身仍可直达');
step('admin-entry: 前台后台入口已移除，/admin 仍可直接访问', true);

// 3. 后台鉴权
const noAuth = await call('/api/orders');
assert.equal(noAuth.status, 401);
const badLogin = await call('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@smoke.local', password: 'wrong' }) });
assert.equal(badLogin.status, 401);
assert.equal(badLogin.body.code, 'invalid_credentials');
const login = await call('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@smoke.local', password: 'smoke-password-123' }) });
assert.equal(login.status, 200);
assert.ok(login.body.token && login.body.token.length > 20);
step('auth: 错误口令 401，正确口令签发随机 token', true);
const auth = { 'x-admin-token': login.body.token, 'content-type': 'application/json' };

// 4. 社交登录不再返回假身份
const social = await call('/api/auth/social', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'google' }) });
assert.equal(social.status, 501);
assert.equal(social.body.code, 'social_login_not_configured');
step('auth: 社交登录返回 501 而不是伪造用户', true);

// 5. 下单 → 订单入库 → 改状态
const orderPayload = {
  customer: { fullName: 'Sofia Lin', email: 'sofia@example.com', country: 'United States', address1: '468 Market Street', city: 'San Francisco', region: 'CA', postalCode: '94105', phone: '+1 415 555 0188' },
  items: [{ productId: 'p-101', quantity: 2 }],
  locale: 'en'
};
const created = await call('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(orderPayload) });
assert.equal(created.status, 201);
assert.match(created.body.order.id, /^BB-\d{8}-001$/);
assert.equal(created.body.order.total, 96);
assert.equal(created.body.order.shipping, 0);
step('orders: 下单写库，金额与订单号正确（' + created.body.order.id + '）', true);

const list = await call('/api/orders', { headers: auth });
assert.equal(list.status, 200);
assert.equal(list.body.orders.length, 1);
assert.equal(list.body.orders[0].customer.email, 'sofia@example.com');
assert.equal(list.body.orders[0].paymentStatus, 'paid', '演示下单模拟支付成功');
assert.equal(list.body.orders[0].shippingStatus, 'pending');
// 设为已发货必须带物流单号
const noTracking = await call('/api/orders/' + created.body.order.id, { method: 'PUT', headers: auth, body: JSON.stringify({ shippingStatus: 'shipped' }) });
assert.equal(noTracking.status, 400);
assert.match(noTracking.body.error, /物流单号/);
const updated = await call('/api/orders/' + created.body.order.id, { method: 'PUT', headers: auth, body: JSON.stringify({ shippingStatus: 'shipped', trackingNo: 'SF1234567890' }) });
assert.equal(updated.status, 200);
assert.equal(updated.body.order.shippingStatus, 'shipped');
assert.equal(updated.body.order.trackingNo, 'SF1234567890');
assert.equal(updated.body.order.status, 'shipped');
assert.ok(updated.body.order.updatedAt);
const refundedOrder = await call('/api/orders/' + created.body.order.id, { method: 'PUT', headers: auth, body: JSON.stringify({ paymentStatus: 'refunded' }) });
assert.equal(refundedOrder.body.order.paymentStatus, 'refunded');
assert.equal(refundedOrder.body.order.status, 'cancelled');
// 还原为已支付 + 已发货（物流单号沿用），供后续持久化断言
const restoredOrder = await call('/api/orders/' + created.body.order.id, { method: 'PUT', headers: auth, body: JSON.stringify({ paymentStatus: 'paid', shippingStatus: 'shipped' }) });
assert.equal(restoredOrder.body.order.status, 'shipped');
assert.equal(restoredOrder.body.order.trackingNo, 'SF1234567890');
step('orders: 支付 / 发货状态分开维护，设为已发货必须填物流单号', true);

// 5b. 订单详情：接口返回完整收货地址与商品明细，后台提供详情入口
const detailOrder = list.body.orders[0];
assert.equal(detailOrder.customer.fullName, 'Sofia Lin');
assert.equal(detailOrder.customer.address1, '468 Market Street');
assert.equal(detailOrder.customer.city, 'San Francisco');
assert.equal(detailOrder.customer.region, 'CA');
assert.equal(detailOrder.customer.postalCode, '94105');
assert.equal(detailOrder.customer.phone, '+1 415 555 0188');
assert.equal(detailOrder.items[0].productId, 'p-101');
assert.equal(detailOrder.items[0].quantity, 2);
assert.ok(home.body.includes('data-order-view'), '订单表格应有详情按钮');
assert.ok(home.body.includes('function openOrderDetail'), '应具备订单详情弹窗');
assert.ok(home.body.includes('order-detail-modal'), '应有订单详情容器');
assert.ok(home.body.includes('data-order-copy'), '详情弹窗应支持复制收货地址');
assert.ok(home.body.includes('function saveOrderStatus'), '详情内可分别更新支付 / 发货状态');
assert.ok(home.body.includes('data-order-tracking-input'), '详情内可填写物流单号');
assert.ok(home.body.includes('data-order-pay-badge') && home.body.includes('data-order-ship-badge'), '列表分别展示支付与发货状态');
step('orders: 订单详情可查看收货地址、商品明细与金额', true);

// 6. 商品增改删
const newProduct = await call('/api/products', { method: 'POST', headers: auth, body: JSON.stringify({ name: '测试竹篮', nameEn: 'Test Basket', price: 19.9, stock: 3, category: '收纳' }) });
assert.equal(newProduct.status, 201);
const createdId = newProduct.body.product.id;
const afterCreate = await call('/api/products');
assert.equal(afterCreate.body.products.length, 7);
assert.equal(afterCreate.body.products.find((p) => p.id === createdId).translations.en.name, 'Test Basket');
const edited = await call('/api/products/' + createdId, { method: 'PUT', headers: auth, body: JSON.stringify({ price: 25.5 }) });
assert.equal(edited.body.product.price, 25.5);
const removed = await call('/api/products/' + createdId, { method: 'DELETE', headers: auth });
assert.equal(removed.status, 200);
assert.equal((await call('/api/products')).body.products.length, 6);
step('products: 新建/编辑/删除落库生效', true);

// 6a. 后台多语言文案（下拉切换的四语言）与详情图数组
const multiTranslations = {
  zh: { name: '多语言竹篮', description: '中文简短', detailDescription: '中文详情', usage: '中文使用建议：温水冲洗后晾干。' },
  en: { name: 'Multi Basket', description: 'English short', detailDescription: 'English detail', usage: 'Rinse and air-dry.' },
  de: { name: 'Mehrsprachiger Korb', description: 'Deutsch kurz', detailDescription: 'Deutsch Detail', usage: 'Abspülen und trocknen.' },
  it: { name: 'Cesto multilingue', description: 'Italiano breve', detailDescription: 'Italiano dettaglio', usage: 'Sciacquare e asciugare.' }
};
const multi = await call('/api/products', { method: 'POST', headers: auth, body: JSON.stringify({ name: '多语言竹篮', nameEn: 'Multi Basket', price: 12, stock: 3, translations: multiTranslations }) });
assert.equal(multi.status, 201);
const multiId = multi.body.product.id;
const multiEdit = await call('/api/products/' + multiId, { method: 'PUT', headers: auth, body: JSON.stringify({ images: ['/media/seed-v2-p-101', '/media/seed-v2-p-102'], translations: multiTranslations }) });
assert.equal(multiEdit.status, 200);
assert.equal(multiEdit.body.product.translations.de.name, 'Mehrsprachiger Korb');
assert.equal(multiEdit.body.product.translations.it.detailDescription, 'Italiano dettaglio');
assert.equal(multiEdit.body.product.translations.zh.usage, '中文使用建议：温水冲洗后晾干。');
assert.equal(multiEdit.body.product.translations.en.usage, 'Rinse and air-dry.');
assert.deepEqual(multiEdit.body.product.images, ['/media/seed-v2-p-101', '/media/seed-v2-p-102']);
const clearedImages = await call('/api/products/' + multiId, { method: 'PUT', headers: auth, body: JSON.stringify({ images: [] }) });
assert.deepEqual(clearedImages.body.product.images, []);
await call('/api/products/' + multiId, { method: 'DELETE', headers: auth });
step('products: 四语言文案（含使用建议）与详情图落库、可清空', true);

// 6b. 币种：接口 + 商品保留自身标价币种（不再折算成 USD 入库）
const currencies = await call('/api/currencies');
assert.equal(currencies.status, 200);
assert.equal(currencies.body.base, 'USD');
assert.equal(currencies.body.settlement, 'product_currency');
assert.equal(currencies.body.currencies.length, 8);
const eur = currencies.body.currencies.find((c) => c.code === 'EUR');
const cny = currencies.body.currencies.find((c) => c.code === 'CNY');
assert.ok(eur && eur.rate > 0 && eur.symbol);
assert.ok(cny && cny.rate > 0);
const eurProduct = await call('/api/products', { method: 'POST', headers: auth, body: JSON.stringify({ name: '欧元定价', price: 92, priceCurrency: 'EUR', stock: 5 }) });
assert.equal(eurProduct.status, 201);
assert.equal(eurProduct.body.product.price, 92);
assert.equal(eurProduct.body.product.priceCurrency, 'EUR');
const cnyEdit = await call('/api/products/' + eurProduct.body.product.id, { method: 'PUT', headers: auth, body: JSON.stringify({ price: 715, priceCurrency: 'CNY' }) });
assert.equal(cnyEdit.body.product.price, 715);
assert.equal(cnyEdit.body.product.priceCurrency, 'CNY');
const sameCurrencyEdit = await call('/api/products/' + eurProduct.body.product.id, { method: 'PUT', headers: auth, body: JSON.stringify({ price: 42.5 }) });
assert.equal(sameCurrencyEdit.body.product.price, 42.5);
assert.equal(sameCurrencyEdit.body.product.priceCurrency, 'CNY');
step('currency: 币种接口正常，商品按原币种原价入库', true);

// 6a2. 后台页面：界面固定中文（无语言切换）、商品文案多语言输入、详情图上传
const adminHtml = await (await worker.fetch(new Request('http://127.0.0.1:4173/'), env, {})).text();
assert.ok(adminHtml.includes('data-lang-panel='));
assert.ok(adminHtml.includes('i18n-lang'));
assert.ok(adminHtml.includes('images-upload'));
assert.ok(!adminHtml.includes('currency-select'));
assert.ok(!adminHtml.includes('admin-locale-select'));
assert.ok(!adminHtml.includes('admin-login-locale'));
assert.ok(adminHtml.includes("state.locale = 'zh'"));
assert.ok(adminHtml.includes('price-code'));
assert.ok(adminHtml.includes('priceCurrency'));
assert.ok(!adminHtml.includes('textarea name="images"'));
assert.ok(adminHtml.includes('i18n_\'+l.code+\'_usage') || adminHtml.includes('_usage'), '后台有使用建议输入框');
assert.ok(adminHtml.includes('detail-usage'), '详情页有使用建议区块');
assert.ok(adminHtml.includes("detail_usage:'使用建议'"), '四语言使用建议标题');
assert.ok(products.body.products.some((p) => p.translations.zh && p.translations.zh.usage), '种子商品带使用建议');
step('admin: 界面固定中文，商品文案多语言 + 详情图上传', true);

// 6b. 封面图：种子封面 + 上传
assert.equal(products.body.products[0].coverImage, '/media/seed-v2-p-101');
const coverRes = await worker.fetch(new Request('http://127.0.0.1:4173/media/seed-v2-p-101'), env, {});
assert.equal(coverRes.status, 200);
assert.equal(coverRes.headers.get('content-type'), 'image/jpeg');
assert.ok((await coverRes.arrayBuffer()).byteLength > 20000);
step('media: 种子封面通过 /media 正常返回', true);

const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const uploadNoAuth = await call('/api/media', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl: tinyPng }) });
assert.equal(uploadNoAuth.status, 401);
const upload = await call('/api/media', { method: 'POST', headers: auth, body: JSON.stringify({ dataUrl: tinyPng }) });
assert.equal(upload.status, 201);
assert.match(upload.body.url, /^\/media\/m-/);
const mediaRes = await worker.fetch(new Request('http://127.0.0.1:4173' + upload.body.url), env, {});
assert.equal(mediaRes.status, 200);
assert.equal(mediaRes.headers.get('content-type'), 'image/png');
step('media: 后台上传图片并可通过 /media 访问', true);

const tempProduct = await call('/api/products', { method: 'POST', headers: auth, body: JSON.stringify({ name: '封面测试', price: 9.9, stock: 1 }) });
assert.equal(tempProduct.status, 201);
const withCover = await call('/api/products/' + tempProduct.body.product.id, { method: 'PUT', headers: auth, body: JSON.stringify({ price: 25.5, coverImage: upload.body.url }) });
assert.equal(withCover.body.product.coverImage, upload.body.url);
const cleared = await call('/api/products/' + tempProduct.body.product.id, { method: 'PUT', headers: auth, body: JSON.stringify({ coverImage: '' }) });
assert.equal(cleared.body.product.coverImage, null);
await call('/api/products/' + tempProduct.body.product.id, { method: 'DELETE', headers: auth });
step('products: 封面图可设置与清除', true);

// 6c. 按商品币种结算：订单币种沿用商品标价币种，金额不做折算
const settleCustomer = { fullName: 'Lena Weber', email: 'lena@example.com', country: 'Germany', address1: 'Hafenstrasse 8', city: 'Hamburg', region: 'HH', postalCode: '20359', phone: '+49 40 555 0199' };
const cnyProductId = eurProduct.body.product.id;
const cnyOrder = await call('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer: settleCustomer, items: [{ productId: cnyProductId, quantity: 1 }] }) });
assert.equal(cnyOrder.status, 201);
assert.equal(cnyOrder.body.order.currency, 'CNY');
assert.equal(cnyOrder.body.order.subtotal, 42.5);
assert.equal(cnyOrder.body.order.shipping, 0);
assert.equal(cnyOrder.body.order.total, 42.5);
step('settlement: 人民币标价商品直接按 CNY 结算（42.50，商品价已含运费）', true);

const eurSettleProduct = await call('/api/products', { method: 'POST', headers: auth, body: JSON.stringify({ name: '欧元结算商品', price: 50, priceCurrency: 'EUR', stock: 9 }) });
const eurSettleId = eurSettleProduct.body.product.id;
const mixedOrder = await call('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer: settleCustomer, locale: 'en', items: [{ productId: eurSettleId, quantity: 1 }, { productId: 'p-101', quantity: 1 }] }) });
assert.equal(mixedOrder.status, 201);
assert.equal(mixedOrder.body.order.currency, 'EUR');
assert.equal(mixedOrder.body.order.subtotal, 94.16);
assert.equal(mixedOrder.body.order.shipping, 0);
assert.equal(mixedOrder.body.order.items[0].price, 50);
assert.equal(mixedOrder.body.order.items[1].price, 44.16);
assert.equal(mixedOrder.body.order.items[1].originalPrice, 48);
assert.equal(mixedOrder.body.order.items[1].priceCurrency, 'USD');
step('settlement: 混合币种购物车按主币种 EUR 结算并保留原币金额', true);

// 6d. 一个商品多语言多币种定价：前台按语言取对应金额，下单按语言计价
const multiPriceProduct = await call('/api/products', { method: 'POST', headers: auth, body: JSON.stringify({
  name: '多档定价竹篮',
  prices: {
    zh: { currency: 'CNY', amount: 328 },
    en: { currency: 'USD', amount: 48 },
    de: { currency: 'EUR', amount: 46 },
    it: { currency: 'EUR', amount: 46 }
  },
  stock: 6
}) });
assert.equal(multiPriceProduct.status, 201);
const multiPriceId = multiPriceProduct.body.product.id;
assert.deepEqual(multiPriceProduct.body.product.prices.zh, { currency: 'CNY', amount: 328 });
assert.deepEqual(multiPriceProduct.body.product.prices.de, { currency: 'EUR', amount: 46 });
assert.equal(multiPriceProduct.body.product.price, 328);
assert.equal(multiPriceProduct.body.product.priceCurrency, 'CNY');
step('pricing: 一个商品可存多语言多币种金额', true);

const zhOrder = await call('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer: settleCustomer, locale: 'zh', items: [{ productId: multiPriceId, quantity: 1 }] }) });
assert.equal(zhOrder.status, 201);
assert.equal(zhOrder.body.order.currency, 'CNY');
assert.equal(zhOrder.body.order.subtotal, 328);
assert.equal(zhOrder.body.order.shipping, 0);
assert.equal(zhOrder.body.order.total, 328);
assert.equal(zhOrder.body.order.items[0].priceLocale, 'zh');
step('pricing: 中文站点按 ¥328 结算（含运费，不再加收）', true);

const deOrder = await call('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer: settleCustomer, locale: 'de', items: [{ productId: multiPriceId, quantity: 1 }] }) });
assert.equal(deOrder.status, 201);
assert.equal(deOrder.body.order.currency, 'EUR');
assert.equal(deOrder.body.order.subtotal, 46);
assert.equal(deOrder.body.order.shipping, 0);
assert.equal(deOrder.body.order.total, 46);
assert.equal(deOrder.body.order.items[0].priceLocale, 'de');
step('pricing: 德语站点按 €46 结算（含运费，不再加收）', true);

// 缺失该语言价格时回退中文价
const partial = await call('/api/products', { method: 'POST', headers: auth, body: JSON.stringify({ name: '只有中文价', prices: { zh: { currency: 'CNY', amount: 199 } }, stock: 2 }) });
assert.equal(partial.status, 201);
const fallbackOrder = await call('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer: settleCustomer, locale: 'it', items: [{ productId: partial.body.product.id, quantity: 1 }] }) });
assert.equal(fallbackOrder.status, 201);
assert.equal(fallbackOrder.body.order.currency, 'CNY');
assert.equal(fallbackOrder.body.order.items[0].originalPrice, 199);
step('pricing: 缺失语言价格时回退中文价', true);

// 6c. 经营总览销售额口径：只统计支付状态为「已支付」的订单，未支付 / 已退款不计入
assert.ok(adminHtml.includes('function isPaidOrder'), '总览应有已支付订单判定函数');
assert.ok(adminHtml.includes("o.paymentStatus==='paid'"), '销售额判定以支付状态为准');
assert.ok(adminHtml.includes('data.orders.filter(isPaidOrder)'), '销售额只累加已支付订单');
assert.ok(adminHtml.includes('按支付状态＝已支付统计'), '统计卡标注口径');
assert.ok(!adminHtml.includes("data.orders.reduce(function(s,o){return s+usdValue(o.total"), '不应再对所有订单求和');
step('overview: 累计销售额只统计已支付订单', true);
await call('/api/products/' + partial.body.product.id, { method: 'DELETE', headers: auth });
await call('/api/products/' + multiPriceId, { method: 'DELETE', headers: auth });

await call('/api/products/' + eurSettleId, { method: 'DELETE', headers: auth });
await call('/api/products/' + cnyProductId, { method: 'DELETE', headers: auth });

// 7. 商城会员：邮箱密码注册 / 登录
const badEmail = await call('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'not-an-email', password: 'password123' }) });
assert.equal(badEmail.status, 400);
assert.equal(badEmail.body.code, 'invalid_email');
step('auth: 非法邮箱注册被拒（400 invalid_email）', true);

const weakPwd = await call('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'shopper@smoke.local', password: '1234567' }) });
assert.equal(weakPwd.status, 400);
assert.equal(weakPwd.body.code, 'weak_password');
step('auth: 弱密码注册被拒（400 weak_password）', true);

const registered = await call('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'Shopper@Smoke.local', password: 'bamboo-pass-88', name: 'Smoke Shopper' }) });
assert.equal(registered.status, 201);
assert.ok(registered.body.token, '注册应返回 token');
assert.equal(registered.body.customer.email, 'shopper@smoke.local', '邮箱应被规范为小写');
assert.equal(registered.body.customer.name, 'Smoke Shopper');
step('auth: 邮箱注册成功并返回会话 token', true);

const dup = await call('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'shopper@smoke.local', password: 'bamboo-pass-88' }) });
assert.equal(dup.status, 409);
assert.equal(dup.body.code, 'email_taken');
step('auth: 重复邮箱注册返回 409', true);

const wrongPwd = await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'shopper@smoke.local', password: 'wrong-password' }) });
assert.equal(wrongPwd.status, 401);
assert.equal(wrongPwd.body.code, 'invalid_credentials');
step('auth: 密码错误登录返回 401', true);

const loggedIn = await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'shopper@smoke.local', password: 'bamboo-pass-88' }) });
assert.equal(loggedIn.status, 200);
assert.ok(loggedIn.body.token);
const customerToken = loggedIn.body.token;
step('auth: 邮箱密码登录成功', true);

const me = await call('/api/auth/me', { headers: { 'x-customer-token': customerToken } });
assert.equal(me.status, 200);
assert.equal(me.body.customer.email, 'shopper@smoke.local');
const anon = await call('/api/auth/me', { headers: { 'x-customer-token': 'not-a-real-token' } });
assert.equal(anon.status, 401);
step('auth: /api/auth/me 校验会话，无效 token 返回 401', true);

const loggedOut = await call('/api/auth/logout', { method: 'POST', headers: { 'x-customer-token': customerToken } });
assert.equal(loggedOut.status, 200);
const afterLogout = await call('/api/auth/me', { headers: { 'x-customer-token': customerToken } });
assert.equal(afterLogout.status, 401);
step('auth: 退出登录后会话立即失效', true);

// 8. 重启后数据仍在（子进程重新打开同一个 sqlite 文件）
const check = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(${JSON.stringify(DB_PATH)});
  const products = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  const orders = db.prepare('SELECT COUNT(*) AS c FROM orders').get().c;
  const admins = db.prepare('SELECT COUNT(*) AS c FROM admin_users').get().c;
  const customers = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
  const status = db.prepare("SELECT status FROM orders LIMIT 1").get().status;
  console.log(JSON.stringify({ products, orders, admins, customers, status }));
`], { encoding: 'utf8' }).trim();
const persisted = JSON.parse(check);
assert.deepEqual(persisted, { products: 6, orders: 6, admins: 1, customers: 1, status: 'shipped' });
step('persistence: 新进程读到 6 商品 / 6 订单 / 1 管理员 / 1 会员，状态已保留', true);

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_PATH + suffix)) await rm(DB_PATH + suffix, { force: true });
}
console.log('\n冒烟测试全部通过');
