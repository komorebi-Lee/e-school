/**
 * 接线层金标集（click 类）—— 判据主体。
 *
 * ★★ **本文件与 `test/fixtures/golden-click-bindings.json` 共同构成判据。
 *    改那个数据文件 = 改判据** —— 它不是一个可以随手刷新的快照，而是一份
 *    需要 code review 的**期望值**。
 *
 * ## 它守的是哪一格（与 `miniapp-wiring.test.js` 是**两个正交方向**）
 *
 *   - `miniapp-wiring.test.js` 守「**绑定 → 方法**」：wxml 上出现的绑定，
 *     同名 js 的页面对象上必须有对应方法。
 *   - 本文件守「**绑定还在不在**」。
 *
 * ★ **为什么必须单独做**：整行删掉 `bindtap="toggleFavorite"` 之后，wxml 里
 *   **就没有这条绑定了** ⇒ 接线判据**无从检查** ⇒ **静默全绿**，
 *   而用户点下去毫无反应。这类回归**只有**金标集看得见。
 *
 * ## 覆盖范围（**有意收窄，不是遗漏**）
 *
 *   - 只覆盖 `bindtap` / `catchtap`（用户「点击」这一类，行为回归里最要命的一类）；
 *   - 静态绑定：存**三元组 `(file, event, handler)`**，逐条比对；
 *   - 动态绑定（`bindtap="{{...}}"`）：**只断言条数**，不存内容。
 *
 * 其余事件族（`bindinput` 60 / `bindchange` 20 / …）的绑定被删通常表现为
 * 「输入没反应 / 选择没生效」，比「按钮点了没反应」更容易在人工验收里被发现。
 * 收窄换来的是金标文件小、diff 可读、review 成本低。
 * **要扩到全部事件族，改 `CLICK_EVENTS` 即可。**
 *
 * ## ★ 动态绑定为什么降级为「条数断言」
 *
 * 动态绑定的 handler 名由**运行时**的三元条件决定，静态无法穷举。
 * 把三元分支名也存成三元组会得到一个**看起来更严、实则更脆**的东西：
 * 条件改了但分支名没变时抓不到，分支名重排时又误报。
 * ⇒ 这里**只断言条数**：**只保证数量、不保证内容**。
 * （动态绑定的**内容**由 `miniapp-wiring.test.js` 的三条探针 + 主判据覆盖。）
 *
 * ## ★ 不提供任何自动更新入口
 *
 * 本文件**只有校验，没有生成**。生成器刻意放在**套件之外**。
 * 一个「跑一下就把金标刷成当前状态」的入口，会把「有人悄悄删了一条绑定」
 * 变成「有人悄悄跑了一次更新脚本」—— 两者在 diff 里的可见性天差地别。
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const miniprogramDirectory = path.join(__dirname, '..', 'miniprogram');
const pagesDirectory = path.join(miniprogramDirectory, 'pages');
const goldenPath = path.join(__dirname, 'fixtures', 'golden-click-bindings.json');

/** 只覆盖「点击」这一类事件。扩到这里即可扩到全部事件族。 */
const CLICK_EVENTS = ['bindtap', 'catchtap'];

/** 事件属性：`bindtap="X"` / `catchtap="X"`（冒号写法由接线判据的探针负责拦下） */
const EVENT_ATTRIBUTE_PATTERN = /\b(bind|catch)([a-zA-Z]+)\s*=\s*"([^"]*)"/g;

// ─────────────────────────────────────────────────────────────
// ★★ 防空过下界（判据坏掉时必须红，不能静默全绿）
//
// ★ 这两条下界**只管「探测器还活着吗」，不管「绑定有没有被删」**。
//   删除由**主判据**负责，且它**逐条点名**（见下方「两条下界各拦什么」）。
//
// ★ 两条下界各拦什么（实测结论，不是推的）：
//   - `wxml 文件数`下界拦「目录遍历坏了 / 页面被整批删掉」；
//     实测：扫到 0 个 wxml ⇒ 红。
//   - `静态绑定条数`下界拦「正则失配 / 解析只认出零星几条」；
//     实测：扫到 0 条 ⇒ 红。
//   - ★ 实测：删掉整个 `pages/search`（文件 34→33、绑定 295→280）时
//     **两条下界都没响**（33 ≥ 30、280 ≥ 280）—— 红的是主判据的 15 条「缺失」。
//     ⇒ 所以下界**故意留大余量**（它不该在正常增删时误响）；
//       而「部分失配」（例如只剩 `bindtap`、丢了 `catchtap`）由**主判据**兜住。
// ─────────────────────────────────────────────────────────────
const MIN_WXML_FILES = 30;
const MIN_STATIC_CLICK_BINDINGS = 200;

/**
 * 报告里**每类**最多列多少条。
 *
 * ★ 为什么要截断：一次大改（例如删掉一批页面）会让缺失清单涨到上百条，
 *   报错撑到 130 行反而**看不清最要紧的那几条**。截断后仍给出**总数**，
 *   所以「很多条」这个信息不会丢，只是不再逐条刷屏。
 */
const MAX_REPORTED = 25;

const SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────────────────────

/**
 * 注释区间 `[start, end)`。
 *
 * ★ 必须是**区间判定**，不能 `replace(/<!--[\s\S]*?-->/g, ' ')` ——
 *   后者会**改变字符串偏移**，行号全错位。
 */
function commentRanges(source) {
  const ranges = [];
  const pattern = /<!--[\s\S]*?-->/g;
  let match = pattern.exec(source);
  while (match !== null) {
    ranges.push([match.index, match.index + match[0].length]);
    match = pattern.exec(source);
  }
  return ranges;
}

function insideComment(ranges, index) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

/** 行号索引器：预建行首表 + 二分查找，避免每个匹配都从头数。 */
function lineIndexer(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (starts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

function listFiles(dir, extension) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, extension));
    else if (entry.name.endsWith(extension)) out.push(full);
  }
  return out;
}

const toPosix = (value) => value.split(path.sep).join('/');

/**
 * 从一个 wxml 里收集 **click 类**绑定。
 *
 * @param {string} source wxml 全文。
 * @returns {{staticBindings: Array<{event: string, handler: string, line: number}>,
 *   dynamicBindings: Array<{event: string, line: number}>}} 保持文件内出现顺序。
 */
function collectClickBindings(source) {
  const ranges = commentRanges(source);
  const lineOf = lineIndexer(source);
  const staticBindings = [];
  const dynamicBindings = [];

  EVENT_ATTRIBUTE_PATTERN.lastIndex = 0;
  let match = EVENT_ATTRIBUTE_PATTERN.exec(source);
  while (match !== null) {
    const event = `${match[1]}${match[2]}`;
    // ★ 注释里的绑定是**开发者写给开发者看**的，微信不会把它接上去 —— 必须跳过（误报源）。
    if (CLICK_EVENTS.includes(event) && !insideComment(ranges, match.index)) {
      const value = match[3].trim();
      const line = lineOf(match.index);
      if (value.includes('{{')) {
        dynamicBindings.push({ event, line });
      } else if (value !== '') {
        staticBindings.push({ event, handler: value, line });
      }
    }
    match = EVENT_ATTRIBUTE_PATTERN.exec(source);
  }
  return { staticBindings, dynamicBindings };
}

/**
 * 扫一棵 miniprogram 树。
 *
 * @param {string} root miniprogram 根目录。
 * @returns {{triples: Array<Array<string>>, dynamicCount: number, wxmlFileCount: number}}
 *   `triples` 已排序，便于稳定比对与报告。
 */
function scan(root) {
  const wxmlFiles = listFiles(path.join(root, 'pages'), '.wxml');
  const triples = [];
  let dynamicCount = 0;

  for (const file of wxmlFiles) {
    const relative = toPosix(path.relative(root, file));
    const { staticBindings, dynamicBindings } = collectClickBindings(fs.readFileSync(file, 'utf8'));
    for (const item of staticBindings) triples.push([relative, item.event, item.handler]);
    dynamicCount += dynamicBindings.length;
  }
  triples.sort(compareTriples);
  return { triples, dynamicCount, wxmlFileCount: wxmlFiles.length };
}

function compareTriples(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

const tripleKey = (triple) => `${triple[0]}  ${triple[1]}="${triple[2]}"`;

/**
 * 把三元组列表渲染成报告行（超过 `MAX_REPORTED` 条时截断，但**总数不截断**）。
 *
 * @param {Array<Array<string>>} triples 待渲染的三元组。
 * @param {string} tag 行首标记（如 `✗ **缺失**`）。
 * @param {string} reason 行尾原因。
 * @returns {string[]} 报告行。
 */
function renderTriples(triples, tag, reason) {
  const lines = triples.slice(0, MAX_REPORTED).map((triple) => `  ${tag}  ${tripleKey(triple)}   ← ${reason}`);
  if (triples.length > MAX_REPORTED) {
    lines.push(`  …（另有 ${triples.length - MAX_REPORTED} 条，总数见下方 footer）`);
  }
  return lines;
}

/** 多重集差：返回 `{ missing: 期望有而实测无, added: 实测有而期望无 }`。 */
function diffMultisets(expected, actual) {
  return {
    missing: multisetDifference(expected, actual),
    added: multisetDifference(actual, expected)
  };
}

/**
 * 多重集差 `minuend \ subtrahend`（保持 `minuend` 的输入顺序，报告才稳定）。
 *
 * 用多重集而不是集合：同一条绑定在一个页面里可能出现两次
 * （`pages/search/search.wxml` 就有两个 `bindtap="goItem"`），
 * 用集合会把「两次变一次」这种丢失吃掉。
 */
function multisetDifference(minuend, subtrahend) {
  const pool = new Map();
  for (const triple of subtrahend) {
    const key = tripleKey(triple);
    pool.set(key, (pool.get(key) || 0) + 1);
  }
  const out = [];
  for (const triple of minuend) {
    const key = tripleKey(triple);
    const count = pool.get(key) || 0;
    if (count > 0) pool.set(key, count - 1);
    else out.push(triple);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 主判据
// ─────────────────────────────────────────────────────────────

test('接线绑定金标集：click 类绑定必须与金标集一致（绑定被删 / 改名 / 新增都要看得见）', () => {
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  const { triples: actualTriples, dynamicCount, wxmlFileCount } = scan(miniprogramDirectory);

  // ── 闸门：金标集自检 + 防空过 ──
  const gate = [];
  const goldenBroken = !golden || !Array.isArray(golden.staticClickBindings)
    || golden.staticClickBindings.length === 0;
  if (goldenBroken) {
    gate.push('[金标集] 金标集为空或结构损坏 —— **空的期望值会让校验恒绿**，比没有金标集更危险');
  } else if (golden.schemaVersion !== SCHEMA_VERSION) {
    gate.push(`[金标集] schemaVersion=${golden.schemaVersion}，本判据期望 ${SCHEMA_VERSION} —— 不认识的格式不能当作通过`);
  }
  if (wxmlFileCount < MIN_WXML_FILES) {
    gate.push(`[下界] 只扫到 ${wxmlFileCount} 个 wxml（下界 ${MIN_WXML_FILES}）—— 数不出来说明目录遍历坏了，此时「零漂移」毫无意义`);
  }
  if (actualTriples.length < MIN_STATIC_CLICK_BINDINGS) {
    gate.push(`[下界] 只扫到 ${actualTriples.length} 条静态 click 绑定（下界 ${MIN_STATIC_CLICK_BINDINGS}）—— 数不出来说明解析器失配，此时「零漂移」毫无意义`);
  }

  // ── 主判据：三元组多重集比对 ──
  const expectedTriples = goldenBroken
    ? []
    : golden.staticClickBindings.map((item) => [item[0], item[1], item[2]]).sort(compareTriples);
  const { missing, added } = goldenBroken ? { missing: [], added: [] } : diffMultisets(expectedTriples, actualTriples);

  // ── 动态绑定：**只保证数量、不保证内容** ──
  const dynamicMismatch = !goldenBroken && dynamicCount !== golden.dynamicClickCount
    ? `[动态绑定] 条数不一致：金标集 ${golden.dynamicClickCount} 处 / 实测 ${dynamicCount} 处`
      + '（★ 此处**只保证数量、不保证内容** —— 三元条件的改动不会被这条抓到）'
    : null;

  // ★★ 一次报出：**下界与主判据放在同一条断言里**，两种问题在**同一次失败**里都打印。
  //
  //    为什么必须这样（本队纪律 + 实测教训）：若下界是一条**独立且更早**的断言，
  //    它一红测试就在那里中断 ⇒ **主判据根本没被求值、点名的缺失清单也不会打印**
  //    ⇒ 看到「下界炸了」却看不到「具体少了哪条绑定」，得改一次跑一次。
  //    `miniapp-wiring.test.js` 曾有此问题，已在 `#65` 修掉；本判据从第一天就照抄那个形态。
  const problems = gate.length + missing.length + added.length + (dynamicMismatch ? 1 : 0);
  assert.equal(
    problems, 0,
    '★★ 接线绑定金标集失败 —— 下面两节**同时**给出，便于一次看清全貌：\n'
    + `\n【闸门】金标集自检 + 防空过下界：${gate.length} 条`
    + '（判据「看不到东西」时会静默全绿，所以这几条必须钉住）\n'
    + (gate.length === 0 ? '  （无）\n' : `${gate.map((item) => `  ✗ ${item}`).join('\n')}\n`)
    + `\n【主判据】click 类绑定与金标集不一致：${missing.length + added.length} 条`
    + '（wxml 上的绑定被删除 / 改名 / 新增；被删的绑定用户点下去将毫无反应）\n'
    + (missing.length + added.length === 0
      ? '  （无）\n'
      : renderTriples(missing, '✗ **缺失**', '绑定被删除或改名')
        .concat(renderTriples(added, '✗ **新增**', '新绑定未经 review 收录进金标集'))
        .join('\n') + '\n')
    + (dynamicMismatch ? `\n${dynamicMismatch}\n` : '')
    + `\n（金标集 ${expectedTriples.length} 条 / 实测 ${actualTriples.length} 条`
    + ` / ${wxmlFileCount} 个 wxml / 动态绑定点 金标 ${golden.dynamicClickCount ?? '?'} 处 实测 ${dynamicCount} 处）\n`
    + `金标集生成自：${golden.generatedFrom ?? '?'}`
  );
});

// ─────────────────────────────────────────────────────────────
// 自证（★ 新增一条判据，必须同时新增它的自证用例）
//
// 否则「修 bug 时加的断言」又会变成一个**没被自证过**的东西 ——
// 那正是本批反复踩的坑。
// ─────────────────────────────────────────────────────────────

test('金标集判据自证：合成用例上必须判得出「绑定被删 / 改名 / 新增」（防空过）', () => {
  const expected = [
    ['pages/x/x.wxml', 'bindtap', 'presentHandler'],
    ['pages/x/x.wxml', 'catchtap', 'presentCatch']
  ];
  const actual = [
    ['pages/x/x.wxml', 'bindtap', 'presentHandler'],
    ['pages/x/x.wxml', 'catchtap', 'renamedCatch']
  ];
  const { missing, added } = diffMultisets(expected, actual);
  assert.deepEqual(missing, [['pages/x/x.wxml', 'catchtap', 'presentCatch']], '改名的绑定必须被报成「缺失」');
  assert.deepEqual(added, [['pages/x/x.wxml', 'catchtap', 'renamedCatch']], '改名的绑定必须被报成「新增」');

  // ★ 反向控制：完全一致时必须零漂移，否则判据会天天误报。
  const same = diffMultisets(expected, [...expected]);
  assert.deepEqual(same.missing, [], '一致的输入不得报缺失');
  assert.deepEqual(same.added, [], '一致的输入不得报新增');
});

test('金标集判据自证：★「删一条 + 在别处加一条」（总数不变）也必须判得出来', () => {
  // 这是「只记总数」方案会**静默通过**的那一类 —— 本判据记的是**名单**而不是总数，
  // 所以必须能抓住它。若这条用例红了，说明有人把多重集比对退化成了计数比对。
  const expected = [
    ['pages/a/a.wxml', 'bindtap', 'alpha'],
    ['pages/b/b.wxml', 'bindtap', 'beta']
  ];
  const actual = [
    ['pages/a/a.wxml', 'bindtap', 'alpha'],
    ['pages/b/b.wxml', 'bindtap', 'brandNew']
  ];
  assert.equal(expected.length, actual.length, '前置：两边条数必须相同（否则本用例没验到「总数不变」）');
  const { missing, added } = diffMultisets(expected, actual);
  assert.deepEqual(missing, [['pages/b/b.wxml', 'bindtap', 'beta']], '删掉的那条必须被点名');
  assert.deepEqual(added, [['pages/b/b.wxml', 'bindtap', 'brandNew']], '新增的那条必须被点名');
});

test('金标集判据自证：注释里的 click 绑定不得被计数（否则会误报）', () => {
  const source = [
    '<view class="page">',
    '  <!-- 注释：bindtap="ghostHandler" catchtap="ghostCatch" -->',
    '  <!--',
    '    多行注释：bindtap="ghostMulti"',
    '    catchtap="ghostMultiCatch"',
    '  -->',
    '  <button bindtap="realHandler">在的</button>',
    '</view>'
  ].join('\n');

  const { staticBindings, dynamicBindings } = collectClickBindings(source);
  assert.deepEqual(
    staticBindings.map((item) => item.handler), ['realHandler'],
    '只有注释外的那条算数 —— 注释里的绑定微信不会接上去，算进去就是误报'
  );
  assert.equal(dynamicBindings.length, 0, '注释里没有动态绑定');
  assert.equal(staticBindings[0].line, 7, '行号必须指向注释外那一条（区间判定没改变偏移）');
});

test('金标集判据自证：动态绑定只计条数，且不得被误算成静态绑定', () => {
  const source = [
    '<view class="page">',
    '  <button bindtap="{{form.visible ? \'cancelForm\' : \'startCreate\'}}">三元</button>',
    '  <button bindtap="{{ghostDynamicHandler}}">无三元</button>',
    '  <button bindtap="plainHandler">静态</button>',
    '</view>'
  ].join('\n');

  const { staticBindings, dynamicBindings } = collectClickBindings(source);
  assert.deepEqual(
    staticBindings.map((item) => item.handler), ['plainHandler'],
    '带 {{}} 的一律算动态 —— 绝不能把三元的某个分支当成静态绑定（那样会误报）'
  );
  assert.equal(
    dynamicBindings.length, 2,
    '★ 两个动态绑定点都要计数。**含三元**与**不含三元**都要算进来 ——'
    + '「不含三元」那种（`bindtap="{{handler}}"`）正是接线判据曾经的盲区，'
    + '这里若漏计它，金标集就会对它视而不见。'
  );
});

test('金标集判据自证：非 click 类事件不得被计入（覆盖范围是有意收窄的）', () => {
  const source = [
    '<view class="page">',
    '  <input bindinput="onInput" />',
    '  <picker bindchange="onChange"></picker>',
    '  <button bindtap="onTap">点击</button>',
    '</view>'
  ].join('\n');

  const { staticBindings, dynamicBindings } = collectClickBindings(source);
  assert.deepEqual(staticBindings.map((item) => item.handler), ['onTap'], '只收 click 类');
  assert.equal(dynamicBindings.length, 0, '只收 click 类');
});
