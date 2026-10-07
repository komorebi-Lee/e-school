const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.join(__dirname, '..');
const miniappDirectory = path.join(repositoryRoot, 'miniprogram');

// 客服联系方式的字面量。全仓有**两份**，且**刻意互相独立**：
//   ① 服务端权威值 —— `server/src/store.js` 的 `adminSettings.servicePhone` /
//      `serviceWechat`，管理员可经 `POST /api/admin/settings` 修改；
//   ② 客户端兜底常量 —— `miniprogram/services/business.js` 的
//      `FALLBACK_SERVICE_CONTACT`，仅在配置读取失败时使用。
// 本文件管的是 ②：客户端**不得**再抄第三份。
const SERVICE_CONTACT = '15527111396';
const CONSTANT_NAME = 'FALLBACK_SERVICE_CONTACT';
const CONSTANT_DEFINITION_FILE = 'miniprogram/services/business.js';
const SERVER_SEED_FILE = 'server/src/store.js';

/** 把绝对路径转成稳定的 POSIX 相对路径（报错文案跨平台可读）。 */
function toRelativePath(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join('/');
}

/** 递归列出 `directory` 下所有以 `extension` 结尾的文件（绝对路径，字典序稳定）。 */
function listFilesWithExtension(directory, extension) {
  return fs.readdirSync(directory, { recursive: true })
    .map((item) => String(item))
    .filter((item) => item.endsWith(extension))
    .sort()
    .map((item) => path.join(directory, item));
}

/**
 * ★ 扫描器：返回 `source` 中 `needle` 的**全部**出现位置。
 *
 * 返回 `{ line, column, text }`，行号与列号均从 1 开始，`text` 为所在整行原文。
 *
 * 之所以逐处返回而不是只给一个计数：不变量转红时必须能**点名位置**，
 * 否则「有人又多抄了一份号码」这种缺陷只能靠人再搜一遍。
 */
function findOccurrences(source, needle) {
  const lines = source.split('\n');
  const occurrences = [];
  let index = source.indexOf(needle);
  while (index !== -1) {
    const prefix = source.slice(0, index);
    const line = prefix.split('\n').length;
    occurrences.push({
      line,
      column: index - (prefix.lastIndexOf('\n') + 1) + 1,
      text: lines[line - 1]
    });
    index = source.indexOf(needle, index + needle.length);
  }
  return occurrences;
}

/** 在 `directory` 下所有 `extension` 文件里扫描 `needle`，结果带上文件名。 */
function scanTree(directory, extension, needle) {
  const occurrences = [];
  for (const file of listFilesWithExtension(directory, extension)) {
    for (const occurrence of findOccurrences(fs.readFileSync(file, 'utf8'), needle)) {
      occurrences.push({ file: toRelativePath(file), ...occurrence });
    }
  }
  return occurrences;
}

/** 把位置清单格式化成可直接粘进报错文案的多行文本。 */
function formatOccurrences(occurrences) {
  if (!occurrences.length) return '  （无）';
  return occurrences
    .map((item) => `  ${item.file}:${item.line}:${item.column}  ${item.text.trim()}`)
    .join('\n');
}

/** 读取仓库内任一相对路径文件。 */
function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// ★ 判据自测：先证明扫描器「有牙齿」，再让下面的计数断言依赖它。
// ---------------------------------------------------------------------------

test('★判据自测：扫描器必须能数出合成源码里的 2 处字面量，并报出行号与原文', () => {
  const syntheticSource = [
    `const A = '${SERVICE_CONTACT}';`,
    `const B = '${SERVICE_CONTACT}';`,
    'const C = 1552711139;'
  ].join('\n');

  const occurrences = findOccurrences(syntheticSource, SERVICE_CONTACT);

  assert.equal(
    occurrences.length, 2,
    `扫描器应数出 2 处，实际 ${occurrences.length} 处。`
    + '若为 0，说明扫描器已退化成「永远返回空数组」—— 那时下面「只出现 1 次」'
    + '会因为它什么都没扫到而**假绿**，这正是本条判据自测存在的唯一理由。'
  );
  assert.deepEqual(
    occurrences.map((item) => item.line), [1, 2],
    '扫描器应报出正确的行号（不变量转红时要靠它点名位置）'
  );
  assert.deepEqual(
    occurrences.map((item) => item.column), [12, 12],
    '扫描器应报出正确的列号（1 起算，指向号码首位；行首 `const A = \'` 占 11 列）'
  );
  assert.match(
    occurrences[0].text, /const A = /,
    '扫描器应报出所在整行原文，便于直接定位'
  );
  assert.deepEqual(
    findOccurrences('const D = 1;', SERVICE_CONTACT), [],
    '扫描器对不含字面量的源码必须返回空数组（否则它就是个只会说「有」的钝器）'
  );
});

// ---------------------------------------------------------------------------
// 主不变量：客户端只允许有 1 份字面量，且必须是那个具名常量。
// ---------------------------------------------------------------------------

test('客服电话字面量在 miniprogram/**/*.js 里只出现 1 次，且必须是客户端兜底常量的定义处', () => {
  const occurrences = scanTree(miniappDirectory, '.js', SERVICE_CONTACT);

  assert.equal(
    occurrences.length, 1,
    `客户端只允许有 1 份客服电话字面量（即 \`${CONSTANT_NAME}\` 的定义处），`
    + `实际 ${occurrences.length} 处：\n`
    + formatOccurrences(occurrences)
    + '\n\n每多抄一份，就等于把「权威值在服务端、客户端只是兜底」这个事实又抄了一遍；'
    + `请改为从 \`services/business\` 引入 ${CONSTANT_NAME}。`
  );

  const [onlyOccurrence] = occurrences;
  assert.equal(
    onlyOccurrence.file, CONSTANT_DEFINITION_FILE,
    `唯一一处字面量必须落在客户端兜底常量的定义文件里，实际在 ${onlyOccurrence.file}`
  );
  assert.match(
    onlyOccurrence.text,
    new RegExp(`const\\s+${CONSTANT_NAME}\\s*=\\s*'${SERVICE_CONTACT}'`),
    `唯一一处字面量必须是 \`const ${CONSTANT_NAME} = '${SERVICE_CONTACT}';\` 的定义行，`
    + `实际是：${onlyOccurrence.text.trim()}`
  );
});

test('miniprogram/**/*.wxml 里不得出现客服电话字面量', () => {
  const occurrences = scanTree(miniappDirectory, '.wxml', SERVICE_CONTACT);

  assert.equal(
    occurrences.length, 0,
    '视图层必须绑定变量（由 `loadBusinessConfig()` 提供），不得写死号码。'
    + `实际 ${occurrences.length} 处：\n`
    + formatOccurrences(occurrences)
  );
});

test('客户端兜底常量旁必须写清它的角色：只是兜底，不是权威值', () => {
  const businessSource = readRepositoryFile(CONSTANT_DEFINITION_FILE);

  assert.match(
    businessSource, /不是权威值/,
    `\`${CONSTANT_NAME}\` 的注释必须点明它**不是权威值** —— 否则下一个人会拿它当权威号码用`
  );
  assert.match(
    businessSource, /adminSettings/,
    '常量注释必须指出权威值在服务端 `adminSettings`，否则读者无从知道去哪改'
  );
  assert.match(
    businessSource, /POST \/api\/admin\/settings/,
    '常量注释必须指出权威值可被管理员经 `POST /api/admin/settings` 修改'
  );
});

// ---------------------------------------------------------------------------
// ★ 缺陷防回归：只把字面量收敛成常量还不够 ——
// 页面若仍以号码作 `data` 初值，管理员改号后用户会先看到、甚至拨到**已过期**的号。
// 配置是异步返回的，而页面在配置回来前就已可渲染（`agreement.js` 甚至同步 setData）。
// ---------------------------------------------------------------------------

// 展示 / 拨号用的客服字段所在页面。各页字段命名不同，故逐个列出。
const CONTACT_PAGE_SITES = [
  { file: 'miniprogram/pages/agreement/agreement.js', field: 'contact', why: '客服卡片随正文同步渲染' },
  { file: 'miniprogram/pages/aftersales/aftersales.js', field: 'contact', why: '电话客服按钮' },
  { file: 'miniprogram/pages/consult/consult.js', field: 'contact', why: '页面底部提示行' },
  { file: 'miniprogram/pages/orders/orders.js', field: 'serviceContact', why: '咨询弹窗的拨号链' },
  { file: 'miniprogram/pages/plate/plate.js', field: 'serviceContact', why: '电话咨询按钮' },
  { file: 'miniprogram/pages/profile/profile.js', field: 'customerService', why: '菜单注记 + 拨打/复制' }
];

test('★缺陷防回归：客服号码的 data 初值必须是空串，不得写死号码', () => {
  for (const site of CONTACT_PAGE_SITES) {
    const source = readRepositoryFile(site.file);

    assert.match(
      source, new RegExp(`${site.field}\\s*:\\s*(?:''|"")`),
      `${site.file}（${site.why}）的 \`data.${site.field}\` 初值必须是空串。`
      + '配置是异步返回的，页面在配置回来前已可渲染；写死号码会让管理员改号后'
      + '用户先看到、甚至拨到**已过期**的号（本项目原则：宁可没有图，也不能有坏图）。'
    );
    assert.equal(
      new RegExp(`${site.field}\\s*:\\s*['"]\\d{11}['"]`).test(source), false,
      `${site.file}（${site.why}）不得再出现 \`${site.field}\` 的 11 位数字初值`
    );
    assert.ok(
      source.includes(CONSTANT_NAME),
      `${site.file}（${site.why}）的拨打/兜底路径应引用 ${CONSTANT_NAME}，`
      + '而不是各写一份号码，也不该在未取到配置时拨一个空号'
    );
  }
});

test('★缺陷防回归：客服号码的渲染处必须带 wx:if 守卫', () => {
  const markupSites = [
    { file: 'miniprogram/pages/agreement/agreement.wxml', field: 'contact' },
    { file: 'miniprogram/pages/aftersales/aftersales.wxml', field: 'contact' },
    { file: 'miniprogram/pages/consult/consult.wxml', field: 'contact' },
    { file: 'miniprogram/pages/plate/plate.wxml', field: 'serviceContact' },
    { file: 'miniprogram/pages/profile/profile.wxml', field: 'customerService' }
  ];

  for (const site of markupSites) {
    const markup = readRepositoryFile(site.file);

    assert.ok(
      markup.includes(`{{${site.field}}}`),
      `${site.file} 应当渲染 \`{{${site.field}}}\`（若连它都不渲染，号码永远不显示，那是另一种缺陷）`
    );
    assert.ok(
      markup.includes(`wx:if="{{${site.field}}}"`),
      `${site.file} 渲染 \`{{${site.field}}}\` 时必须带 \`wx:if="{{${site.field}}}"\` 守卫：`
      + '未取到配置时该值为空串，裸渲染会留下悬空的「客服电话 / 微信：」或空注记。'
    );
  }
});

// ---------------------------------------------------------------------------
// 服务端权威值：保持独立，且与客户端常量互不引用。
// ---------------------------------------------------------------------------

test('服务端权威种子保持 3 处独立，且与客户端常量互不引用', () => {
  const storeSource = readRepositoryFile(SERVER_SEED_FILE);
  const occurrences = findOccurrences(storeSource, SERVICE_CONTACT);

  assert.equal(
    occurrences.length, 3,
    `${SERVER_SEED_FILE} 应有 3 处字面量`
    + '（演示商家对外电话 1 处 + `adminSettings` 客服电话/微信 2 处），'
    + `实际 ${occurrences.length} 处：\n`
    + formatOccurrences(occurrences.map((item) => ({ file: SERVER_SEED_FILE, ...item })))
  );
  assert.deepEqual(
    occurrences.map((item) => item.line), [115, 354, 355],
    '这 3 处的行号被钉住：改动它们（含挪动上方注释）都必须是有意识的。'
    + `实际行号 ${occurrences.map((item) => item.line).join(', ')}`
  );

  // 反向控制：两侧**刻意独立**。
  // 注意口径 —— 禁的是**代码耦合**（`require` 对方），不是**注释提及**：
  // 常量注释里写明「权威值在服务端 store.js 的 adminSettings」恰恰是我们想要的，
  // 那是文档而不是依赖。所以这里匹配 `require(...)`，不匹配裸文件名。
  const businessSource = readRepositoryFile(CONSTANT_DEFINITION_FILE);

  assert.equal(
    /require\([^)]*server[^)]*\)/.test(businessSource), false,
    '客户端兜底常量不得 require 服务端源码 —— 权威值应经 `GET /api/business-config` 取得，'
    + '而不是把服务端模块拉进小程序包里'
  );
  assert.equal(
    /require\([^)]*miniprogram[^)]*\)/.test(storeSource), false,
    `服务端不得 require 小程序源码 —— ${CONSTANT_NAME} 只是「读取失败时的兜底」，`
    + '不该被跨进程反向定义成权威值'
  );
});
