#!/usr/bin/env node
/**
 * 竹里集商城 · Cloudflare Workers 一键部署脚本
 *
 * 用法：
 *   node scripts/deploy-cloudflare.mjs                # 默认部署
 *   node scripts/deploy-cloudflare.mjs --dry-run      # 只打包，不上传
 *   node scripts/deploy-cloudflare.mjs --skip-secrets # 跳过密钥写入
 *
 * 依赖的环境变量（本地执行可先 export，CI 里用 GitHub Secrets）：
 *   ADMIN_EMAIL             后台管理员邮箱（必填，secret）
 *   ADMIN_PASSWORD          后台管理员密码（必填，secret）
 *   LIANLIAN_MERCHANT_ID    连连商户号（secret）
 *   LIANLIAN_PRIVATE_KEY    连连商户 RSA 私钥 PEM（secret）
 *   LIANLIAN_PUBLIC_KEY     连连平台公钥 PEM（secret）
 *   SITE_URL                可选，正式域名，写入 LIANLIAN_SITE_URL
 *
 * 鉴权：
 *   本地  -> 先执行 `npx wrangler login`，或设置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
 *   CI    -> 设置 CLOUDFLARE_API_TOKEN（含 Workers Scripts:Edit + D1:Edit 权限）与 CLOUDFLARE_ACCOUNT_ID
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'wrangler.toml');
const WORKER_NAME = 'zhuliji-store';
const D1_NAME = 'zhuliji-db';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const SKIP_SECRETS = args.has('--skip-secrets');

const SECRET_NAMES = [
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'LIANLIAN_MERCHANT_ID',
  'LIANLIAN_PRIVATE_KEY',
  'LIANLIAN_PUBLIC_KEY',
];

const c = {
  step: (msg) => console.log('\n\x1b[36m▶ ' + msg + '\x1b[0m'),
  ok: (msg) => console.log('  \x1b[32m✓\x1b[0m ' + msg),
  warn: (msg) => console.log('  \x1b[33m!\x1b[0m ' + msg),
  fail: (msg) => console.log('  \x1b[31m✗\x1b[0m ' + msg),
};

function die(msg, hint) {
  c.fail(msg);
  if (hint) console.log('\n' + hint + '\n');
  process.exit(1);
}

/** 优先用本地安装的 wrangler，没有则用 npx 临时拉取 */
const localWrangler = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
const WRANGLER = existsSync(localWrangler) ? localWrangler : null;

function wrangler(wranglerArgs, options = {}) {
  const cmd = WRANGLER || 'npx';
  const finalArgs = WRANGLER ? wranglerArgs : ['--yes', 'wrangler@4', ...wranglerArgs];
  const result = spawnSync(cmd, finalArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 20 * 1024 * 1024,
  });
  return result;
}

function mustWrangler(wranglerArgs, options = {}) {
  const r = wrangler(wranglerArgs, options);
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 && !options.allowFail) {
    die('命令失败：wrangler ' + wranglerArgs.join(' '), out.trim().split('\n').slice(-12).join('\n'));
  }
  return { code: r.status, out };
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) die('找不到 wrangler.toml，请在项目根目录执行本脚本');
  return readFileSync(CONFIG_PATH, 'utf8');
}

function patchConfig(replacements) {
  let text = readConfig();
  let changed = false;
  for (const [pattern, replacement] of replacements) {
    const next = text.replace(pattern, replacement);
    if (next !== text) changed = true;
    text = next;
  }
  if (changed) writeFileSync(CONFIG_PATH, text);
  return changed;
}

/** 步骤 1：检查 wrangler 与 Cloudflare 登录状态 */
function checkAuth() {
  c.step('检查 Cloudflare 认证状态');
  const { out } = mustWrangler(['whoami'], { allowFail: true });
  if (/not authenticated|You are not authenticated/i.test(out)) {
    die(
      '未登录 Cloudflare',
      '本地请先运行：npx wrangler login\n或在环境变量中设置 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ACCOUNT_ID'
    );
  }
  // 非交互终端（脚本 / CI / 无 TTY）不会弹 OAuth 登录，必须靠 token
  if (/non-interactive environment|CLOUDFLARE_API_TOKEN environment variable/i.test(out)) {
    die(
      '当前是非交互环境，wrangler 无法走浏览器登录',
      '二选一：\n' +
        '  1) 在终端里手动执行一次 npx wrangler login（需要能打开浏览器）\n' +
        '  2) 设置环境变量后重试：\n' +
        '     export CLOUDFLARE_API_TOKEN=你的token\n' +
        '     export CLOUDFLARE_ACCOUNT_ID=你的account_id\n' +
        '     npm run deploy:cf\n' +
        '  token 创建：https://dash.cloudflare.com/profile/api-tokens（权限需含 Workers Scripts:Edit、D1:Edit）'
    );
  }
  const account = (out.match(/[a-f0-9]{32}/i) || [])[0] || '';
  c.ok('已认证' + (account ? '（account: ' + account.slice(0, 8) + '…）' : ''));
}

/** 步骤 2：确保 D1 数据库存在，并把 database_id 写回 wrangler.toml */
function ensureD1() {
  c.step('准备 D1 数据库「' + D1_NAME + '」');
  const config = readConfig();
  const existingId = (config.match(/database_id\s*=\s*"([^"]+)"/) || [])[1] || '';
  const isPlaceholder = !existingId || existingId === 'REPLACE_WITH_D1_DATABASE_ID';

  const listed = mustWrangler(['d1', 'list', '--json'], { allowFail: true });
  let databases = [];
  try {
    const parsed = JSON.parse(listed.out.slice(listed.out.indexOf('[')));
    databases = Array.isArray(parsed) ? parsed : [];
  } catch {
    c.warn('无法解析 d1 list 输出，将尝试直接创建');
  }

  const found = databases.find((db) => db.name === D1_NAME);
  let id = found ? found.uuid || found.id : '';

  if (!id && isPlaceholder) {
    c.warn('数据库中不存在，正在创建…');
    const created = mustWrangler(['d1', 'create', D1_NAME, '--json']);
    const jsonStart = created.out.indexOf('{');
    try {
      const info = JSON.parse(created.out.slice(jsonStart));
      id = info.uuid || info.id || (info.d1_databases && info.d1_databases[0] && info.d1_databases[0].uuid) || '';
    } catch {
      const m = created.out.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
      id = m ? m[1] : '';
    }
  }

  if (!id) {
    if (!isPlaceholder) {
      c.ok('wrangler.toml 已配置 database_id：' + existingId.slice(0, 8) + '…');
      return;
    }
    die(
      '未能获取 D1 database_id',
      '请到 Cloudflare 控制台 → Workers & Pages → D1 手动创建数据库「' + D1_NAME + '」，\n' +
        '再把 database_id 填进 wrangler.toml 的 [[d1_databases]] 段后重试。'
    );
  }

  if (isPlaceholder) {
    patchConfig([[/(database_id\s*=\s*")[^"]*(")/, '$1' + id + '$2']]);
    c.ok('已创建数据库并写入 wrangler.toml：' + id.slice(0, 8) + '…');
    c.warn('请把更新后的 wrangler.toml 提交到 Git 仓库，供 CI 复用');
  } else {
    c.ok('数据库已存在：' + id.slice(0, 8) + '…');
  }
}

/** 步骤 3：写入敏感变量（Values 走 toml，Secret 走 wrangler secret put） */
function putSecrets() {
  c.step('同步 Worker 密钥');
  if (SKIP_SECRETS) {
    c.warn('已跳过（--skip-secrets）');
    return;
  }
  const missing = [];
  for (const name of SECRET_NAMES) {
    const value = process.env[name];
    if (!value || !String(value).trim()) {
      missing.push(name);
      continue;
    }
    const r = wrangler(['secret', 'put', name, '--name', WORKER_NAME], { input: String(value) });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status !== 0) {
      c.fail(name + ' 写入失败');
      console.log(out.trim().split('\n').slice(-6).join('\n'));
      process.exit(1);
    }
    c.ok(name + ' 已写入');
  }
  if (missing.length) {
    c.warn('以下变量未提供，已跳过：' + missing.join(', '));
    console.log(
      '     可先 export ' + missing[0] + '=... 再重跑，或稍后用：\n' +
        '     npx wrangler secret put ' + missing[0] + ' --name ' + WORKER_NAME
    );
  }
}

/** 读取 wrangler.toml 里 [[routes]] 配置的自定义域名（如 shop.naturalbamboo.app） */
function customDomain() {
  const match = readConfig().match(/\[\[routes\]\][\s\S]*?pattern\s*=\s*"([^"]+)"/);
  if (!match) return '';
  return match[1].replace(/\/\*$/, '').replace(/^https?:\/\//, '').trim();
}

/** 步骤 4：把正式域名写入 vars.LIANLIAN_SITE_URL（SITE_URL 优先，否则用 [[routes]] 的域名） */
function patchSiteUrl() {
  const explicit = String(process.env.SITE_URL || '').trim();
  const domain = customDomain();
  const siteUrl = explicit || (domain ? 'https://' + domain : '');
  if (!siteUrl) {
    c.warn('未配置站点域名，跳过 LIANLIAN_SITE_URL（支付回调将退化使用请求域名）');
    return;
  }
  c.step('写入站点地址 LIANLIAN_SITE_URL');
  const cleaned = siteUrl.replace(/\/$/, '');
  const changed = patchConfig([/(LIANLIAN_SITE_URL\s*=\s*")[^"]*(")/, '$1' + cleaned + '$2']);
  c.ok((changed ? '已写入：' : '已是当前值：') + cleaned);
}

/** 步骤 5：部署 */
function deploy() {
  c.step(DRY_RUN ? '打包验证（--dry-run，不上传）' : '部署到 Cloudflare Workers');
  const started = Date.now();
  const { out } = mustWrangler(DRY_RUN ? ['deploy', '--dry-run'] : ['deploy']);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    out
      .split('\n')
      .filter((line) => /Upload|Deployed|workers\.dev|Binding|D1|Environment|Total Upload/i.test(line))
      .map((line) => '  ' + line.trim())
      .join('\n')
  );
  c.ok('完成，用时 ' + seconds + 's');

  const url = (out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i) || [])[0];
  const domain = customDomain();
  if (domain) c.ok('自定义域名：https://' + domain);
  return url;
}

/** 步骤 6：部署后健康检查（自定义域名优先，证书未就绪时降级提示） */
async function healthCheck(url) {
  if (DRY_RUN) return;
  const domain = customDomain();
  const targets = [];
  if (domain) targets.push('https://' + domain);
  if (url) targets.push(url);
  if (!targets.length) return;

  for (const base of targets) {
    c.step('健康检查 ' + base);
    try {
      const home = await fetch(base + '/', { headers: { 'user-agent': 'deploy-script' } });
      c.ok('首页 HTTP ' + home.status);
      const api = await fetch(base + '/api/products', { headers: { 'user-agent': 'deploy-script' } });
      const data = await api.json();
      const count = Array.isArray(data.products) ? data.products.length : 0;
      c.ok('商品接口 HTTP ' + api.status + '，返回 ' + count + ' 件商品');
    } catch (err) {
      c.warn(
        '健康检查失败：' + err.message +
          (domain ? '（自定义域名首次绑定需要 1-3 分钟签发证书，稍后重试即可）' : '')
      );
    }
  }

  const primary = (domain ? 'https://' + domain : url).replace(/\/$/, '');
  console.log('\n  商城前台：' + primary + '/');
  console.log('  后台管理：' + primary + '/admin');
  console.log('  支付回调：' + primary + '/api/lianlian/notify\n');
}

async function main() {
  console.log('\x1b[1m竹里集 · Cloudflare Workers 部署\x1b[0m');
  console.log('配置：' + CONFIG_PATH + (DRY_RUN ? '  [dry-run]' : ''));

  if (!DRY_RUN) {
    checkAuth();
    ensureD1();
    // vars 属于部署配置，必须在 deploy 前写进 toml；Secret 则要等 Worker 存在后写入
    patchSiteUrl();
  }

  const url = deploy();

  if (!DRY_RUN) {
    putSecrets();
    await healthCheck(url);
  }

  if (!DRY_RUN) {
    const domain = customDomain();
    const base = domain ? 'https://' + domain : 'https://你的域名';
    console.log(
      '\n\x1b[1m后续检查清单\x1b[0m\n' +
        '  1. 首次访问会自动建表并写入 6 件示例商品（D1 无需手动迁移）\n' +
        '  2. 用 ADMIN_EMAIL / ADMIN_PASSWORD 登录 ' + base + '/admin 确认后台可用\n' +
        '  3. 连连商户后台把异步通知地址登记为 ' + base + '/api/lianlian/notify\n' +
        '  4. LIANLIAN_ENV 已设为 production（沙箱调试时改成 sandbox 并重新部署）\n' +
        (domain
          ? '  5. 自定义域名 ' + domain + ' 首次绑定需 1-3 分钟签发证书，期间访问报 522/526 属正常\n'
          : '  5. 尚未配置自定义域名，可在 wrangler.toml 的 [[routes]] 中添加\n')
    );
  }
}

main();
