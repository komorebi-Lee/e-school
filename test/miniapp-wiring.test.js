/**
 * 「接线层」判据：wxml 上绑定的**每一个**事件处理器，都必须在同名 js 的页面对象上**真实存在**。
 *
 * ## 为什么需要单独一个文件
 *
 * `test/miniapp.test.js` 用的是**源码文本断言**（`includes('bindtap="X"')`）。那类断言能证明
 * 「wxml 里有这个字符串」，但证明不了**反方向**的那一半：**wxml 里绑的每个 handler，
 * 页面上是不是真的有**。后者才是「用户点下去会不会炸」。
 *
 * 实测反例（本判据立项的直接原因）：`pages/addresses/addresses.wxml` 的「收起 / 取消」按钮
 * 绑着 `cancelForm`，而 `addresses.js` 里**从来没有这个方法** —— 用户一点就是
 * `undefined is not a function`。全仓 5 个测试文件对此**全绿**，因为没有任何一条断言做过
 * 「wxml → js」这个方向的检查。
 *
 * 为什么不能塞进既有文件：① 本批的硬约束是「根 `test/` **只增不改**」；② 同一时间
 * `test/miniapp.test.js` 与 `test/miniapp-load-failure.test.js` 有他人正在改（#58 在途）。
 * 仓库已有先例 —— `test/miniapp-page-blocks.test.js` 就自带一份 `createHarness()`，
 * 并在头注里解释了为什么必须单独一个文件。
 *
 * ## 为什么方法清单走**运行时**而不是正则
 *
 * 静态正则要认全 4 种定义形态（`name(){}` / `async name(){}` / `name: function(){}` /
 * 简写 `name,`），漏一种就**误报**悬空；而 `Page({ ...mixin })` 这类继承形态静态根本认不出，
 * 会**漏报**（漏报是静默的，比误报危险得多）。
 *
 * 本判据改成把 `Page` / `wx` / 网络层注入进来，直接取 `Object.keys(definition)` ——
 * **运行时真实键集合**，四种形态与全部继承形态一次性覆盖。展开（spread）在对象字面量
 * **求值时**就把键复制进来了，运行时的键集合天然含它们（这一点有正向控制守着，见文件末尾）。
 *
 * ## 三个必须避开的误报源
 *
 * 1. **注释必须先剥**（`<!-- -->`）：`pages/market/mine.wxml:31` 的注释里就写着
 *    `bindtap="goItem"`。不剥会凭空造出一条悬空绑定。
 *    规则与 `miniapp-load-failure.test.js` 的 `commentRanges()` / `insideComment()` 同型 ——
 *    用**区间**判定而不是 `stripComments()` 的 `replace(/<!--[\s\S]*?-->/g, ' ')`。
 *    两者剥掉的注释内容**完全相同**，差别只在：`replace` 成 `' '` 会**改变其后所有字符的
 *    偏移**、行号随之错位；区间判定则偏移与行号都精确。本判据要在断言消息里给出**准确行号**。
 * 2. **事件族不止 `bindtap`**：本仓共 10 族。只扫 `bindtap` 会漏掉 99 条（`bindinput×60` /
 *    `bindchange×20` / `catchtap×11` / …），而那些同样是「点了就炸」的入口。
 * 3. **动态绑定里的比较值不是 handler**：`pages/orders/orders.wxml:90` 写着
 *    `bindtap="{{action.key === 'pay' ? 'runPayment' : …}}"` —— `'pay'` 是**比较值**。
 *    朴素地「取所有字面量」会凭空造出 10 条误报。只取**紧跟 `?` / `:`** 的字面量。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

const miniprogramDirectory = path.join(__dirname, '..', 'miniprogram');
const pagesDirectory = path.join(miniprogramDirectory, 'pages');

/**
 * 事件属性：`bind*="..."` 与 `catch*="..."`（**两个族都要**，`catchtap` 同样会调 handler）。
 *
 * 值里可能含 `{{ }}`（动态绑定），由 `collectBindings` 再拆。
 */
const EVENT_ATTRIBUTE_PATTERN = /\b(bind|catch)([a-zA-Z]+)\s*=\s*"([^"]*)"/g;

/**
 * 三元分支里的 handler 字面量。
 *
 * ★ **只取紧跟 `?` 或 `:` 的字面量** —— 这一条是误报与不漏报的分水岭：
 * `action.key === 'pay'` 里的 `'pay'` 前面是 `=`，不算 handler；
 * `? 'runPayment'` 里的 `'runPayment'` 前面是 `?`，算 handler。
 */
const TERNARY_BRANCH_PATTERN = /[?:]\s*'([A-Za-z_$][\w$]*)'/g;

/** 本判据**不认识**的写法：`bind:tap="x"`。出现了必须显式失败，不能静默漏掉。 */
const COLON_ATTRIBUTE_PATTERN = /\b(bind|catch):[a-zA-Z]+\s*=/g;

/** 本判据**不认识**的写法：不带引号的 `bindtap=x`。同样必须显式失败。 */
const UNQUOTED_ATTRIBUTE_PATTERN = /\b(bind|catch)[a-zA-Z]+\s*=\s*[^"'\s>]/g;

/**
 * 豁免名单 —— **必须保持为空**。
 *
 * 它真的参与过滤（见 `dangling` 的 `filter`），不是死代码；同时下面有一条
 * `length === 0` 的断言把它钉住。留这个口子的唯一目的是：万一将来真出现「暂时无法修」
 * 的悬空绑定，作者必须**显式登记**并在此处写清理由，而不是把判据改松 —— 改松是静默的，
 * 登记是可见的。任何一次登记都应当在 review 里被追问。
 *
 * @type {Array<{file: string, handler: string, reason: string}>}
 */
const WIRING_EXEMPTIONS = [];

/**
 * 源串里所有注释的区间（`<!--` 到 `-->`）。
 *
 * 与 `test/miniapp-load-failure.test.js` 的 `commentRanges()` 同型 —— 刻意保持一致，
 * 免得同一件事在本仓有两套口径。
 *
 * @param {string} source wxml 全文。
 * @returns {number[][]} `[start, end)` 区间数组。
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

/**
 * `index` 是否落在某个注释区间内。
 *
 * @param {number[][]} ranges 注释区间。
 * @param {number} index 待判定偏移。
 * @returns {boolean} 在注释内为 `true`。
 */
function insideComment(ranges, index) {
  return ranges.some((range) => index >= range[0] && index < range[1]);
}

/**
 * 把 `index` 换算成 1 起的行号。
 *
 * 先建一次行首表，之后二分查找 —— 逐次从头数换行是 O(n²)，34 个文件加起来会明显变慢。
 *
 * @param {string} source 源串。
 * @returns {Function} `(index) => line`。
 */
function lineIndexer(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= index) low = mid; else high = mid - 1;
    }
    return low + 1;
  };
}

/**
 * 递归列出目录下所有指定扩展名的文件（绝对路径，已排序）。
 *
 * @param {string} directory 起始目录。
 * @param {string} extension 扩展名（含点，如 `'.wxml'`）。
 * @returns {string[]} 文件绝对路径。
 */
function listFiles(directory, extension) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full, extension));
    else if (entry.name.endsWith(extension)) found.push(full);
  }
  return found.sort();
}

/** 统一成正斜杠，保证 Windows 下 `Map` 的键与断言消息一致。 */
function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

/**
 * 数出 `pattern` 在**非注释**部分的命中数。
 *
 * 用途是「未覆盖写法」的探针：本判据不认识 `bind:tap` 这类写法，出现了就得**显式红**，
 * 否则那些绑定会被静默跳过 —— 静默跳过正是本判据要消灭的东西。
 *
 * @param {string} source 源串。
 * @param {number[][]} ranges 注释区间。
 * @param {RegExp} pattern 全局正则。
 * @returns {number} 命中数。
 */
function countOutsideComments(source, ranges, pattern) {
  let count = 0;
  pattern.lastIndex = 0;
  let match = pattern.exec(source);
  while (match !== null) {
    if (!insideComment(ranges, match.index)) count += 1;
    match = pattern.exec(source);
  }
  return count;
}

/**
 * 解析一份 wxml，取出全部事件绑定。
 *
 * @param {string} source wxml 全文。
 * @returns {{eventAttributeCount: number, dynamicAttributeCount: number,
 *   families: Map<string, number>, refs: Array<object>}} 解析结果。
 *   `refs` 每项为 `{ line, attribute, handler, dynamic }`。
 */
function collectBindings(source) {
  const ranges = commentRanges(source);
  const lineOf = lineIndexer(source);
  const families = new Map();
  const refs = [];
  let eventAttributeCount = 0;
  let dynamicAttributeCount = 0;

  EVENT_ATTRIBUTE_PATTERN.lastIndex = 0;
  let match = EVENT_ATTRIBUTE_PATTERN.exec(source);
  while (match !== null) {
    // ★ 注释里的绑定是**开发者写给开发者看**的，微信不会把它接上去 —— 必须跳过。
    if (!insideComment(ranges, match.index)) {
      const attribute = `${match[1]}${match[2]}`;
      const value = match[3];
      const line = lineOf(match.index);
      eventAttributeCount += 1;
      families.set(attribute, (families.get(attribute) || 0) + 1);
      if (value.includes('{{')) {
        dynamicAttributeCount += 1;
        TERNARY_BRANCH_PATTERN.lastIndex = 0;
        let branch = TERNARY_BRANCH_PATTERN.exec(value);
        while (branch !== null) {
          refs.push({ line, attribute, handler: branch[1], dynamic: true });
          branch = TERNARY_BRANCH_PATTERN.exec(value);
        }
      } else {
        refs.push({ line, attribute, handler: value.trim(), dynamic: false });
      }
    }
    match = EVENT_ATTRIBUTE_PATTERN.exec(source);
  }
  return { eventAttributeCount, dynamicAttributeCount, families, refs };
}

/**
 * 从引用里挑出「页面对象上没有对应方法」的那些。
 *
 * @param {Array<object>} refs `collectBindings` 产出的引用。
 * @param {Set<string>} methodNames 页面对象上的方法名集合。
 * @returns {Array<object>} 悬空引用（保持输入顺序，便于断言消息稳定）。
 */
function findDangling(refs, methodNames) {
  return refs.filter((ref) => !methodNames.has(ref.handler));
}

/** `wx` 的兜底桩：显式给出的按给出行为，其余一律回空函数（与既有 harness 同型）。 */
function createWxStub() {
  return new Proxy({
    getStorageSync: () => undefined,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: () => {},
    showModal: () => {},
    nextTick: (callback) => callback(),
    env: { USER_DATA_PATH: '/tmp' },
    createSelectorQuery: () => ({
      selectAll: () => ({ boundingClientRect: () => ({}) }),
      selectViewport: () => ({ scrollOffset: () => ({}) }),
      exec: () => {}
    })
  }, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (typeof key === 'string') return () => {};
      return undefined;
    }
  });
}

/**
 * 在「页面运行环境已注入」的前提下跑一段逻辑，结束后**无条件**还原全局桩。
 *
 * 只拦截 `miniprogram/services/*` 与 `utils/navigation` —— 其余（含 `utils/load-state`）
 * 用**真模块**。本判据只关心「方法名在不在」，不需要真网络；但保持与既有 harness 相同的
 * 拦截面，免得页面在 `require` 期就因为拿不到 `wx` 而抛错。
 *
 * @param {Function} run 待执行逻辑。
 * @returns {*} `run` 的返回值。
 */
function withPageRuntime(run) {
  const stubs = new Map([
    [require.resolve(path.join(miniprogramDirectory, 'services', 'api.js')), {
      request: () => Promise.resolve({ data: {} }),
      apiRequest: () => Promise.resolve({ data: {} }),
      userId: () => 'user-1'
    }],
    [require.resolve(path.join(miniprogramDirectory, 'services', 'business.js')), {
      loadBusinessConfig: () => Promise.resolve({}),
      FALLBACK_SERVICE_CONTACT: '15527111396'
    }],
    [require.resolve(path.join(miniprogramDirectory, 'services', 'store.js')), {
      getScooter: () => null,
      getScooters: () => []
    }],
    [require.resolve(path.join(miniprogramDirectory, 'services', 'payment.js')), {
      payPaymentOrder: () => Promise.resolve({}),
      payPaymentOrderById: () => Promise.resolve({ data: {} })
    }],
    [require.resolve(path.join(miniprogramDirectory, 'utils', 'navigation.js')), {
      openLink: () => {}
    }]
  ]);

  const originalLoad = Module._load;
  const originalPage = global.Page;
  const originalWx = global.wx;
  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (stubs.has(resolved)) return stubs.get(resolved);
      return originalLoad.apply(this, arguments);
    };
    global.wx = createWxStub();
    return run();
  } finally {
    Module._load = originalLoad;
    global.Page = originalPage;
    global.wx = originalWx;
  }
}

/**
 * `require` 一个页面 js，返回它传给 `Page()` 的 definition。
 *
 * ★ 必须清缓存：不清的话第二个页面会复用第一个的模块实例，`Page` 再也收不到定义。
 *   页面**间接** require 的工具模块也要一并清（与既有 harness 同因）。
 *
 * @param {string} absoluteJsPath 页面 js 的绝对路径。
 * @returns {object|null} definition；页面没调 `Page()` 时为 `null`。
 */
function captureDefinition(absoluteJsPath) {
  let captured = null;
  global.Page = (definition) => { captured = definition; };
  delete require.cache[require.resolve(absoluteJsPath)];
  for (const name of fs.readdirSync(path.join(miniprogramDirectory, 'utils'))) {
    if (!name.endsWith('.js')) continue;
    delete require.cache[require.resolve(path.join(miniprogramDirectory, 'utils', name))];
  }
  require(absoluteJsPath);
  return captured;
}

/**
 * 载入全部页面，返回 `wxml 相对路径 → 方法名集合`。
 *
 * @returns {Map<string, Set<string>>} 页面方法清单。
 */
function loadPageMethods() {
  return withPageRuntime(() => {
    const methods = new Map();
    for (const file of listFiles(pagesDirectory, '.js')) {
      const relative = toPosix(path.relative(miniprogramDirectory, file));
      const definition = captureDefinition(file);
      assert.ok(definition, `${relative} 应调用 Page() 注册页面（否则接线判据无从判定）`);
      methods.set(
        relative.replace(/\.js$/, '.wxml'),
        new Set(Object.keys(definition).filter((key) => typeof definition[key] === 'function'))
      );
    }
    return methods;
  });
}

test('接线层：wxml 绑定的每一个事件处理器，都必须在页面对象上真实存在', () => {
  const methodsByWxml = loadPageMethods();
  const wxmlFiles = listFiles(pagesDirectory, '.wxml');
  const families = new Map();
  const scanned = [];
  const rawDangling = [];
  let eventAttributeCount = 0;
  let dynamicAttributeCount = 0;
  let checked = 0;
  let colonFormCount = 0;
  let unquotedFormCount = 0;

  for (const file of wxmlFiles) {
    const relative = toPosix(path.relative(miniprogramDirectory, file));
    const methodNames = methodsByWxml.get(relative);
    assert.ok(methodNames, `${relative} 找不到同名 js —— 接线判据无法判定，不能当作通过`);
    const source = fs.readFileSync(file, 'utf8');
    const ranges = commentRanges(source);
    const bindings = collectBindings(source);

    eventAttributeCount += bindings.eventAttributeCount;
    dynamicAttributeCount += bindings.dynamicAttributeCount;
    checked += bindings.refs.length;
    colonFormCount += countOutsideComments(source, ranges, COLON_ATTRIBUTE_PATTERN);
    unquotedFormCount += countOutsideComments(source, ranges, UNQUOTED_ATTRIBUTE_PATTERN);
    for (const [name, count] of bindings.families) {
      families.set(name, (families.get(name) || 0) + count);
    }
    scanned.push(relative);
    for (const ref of findDangling(bindings.refs, methodNames)) {
      rawDangling.push({ file: relative, ...ref });
    }
  }

  const dangling = rawDangling.filter((item) => !WIRING_EXEMPTIONS.some(
    (entry) => entry.file === item.file && entry.handler === item.handler
  ));

  // ★★ 防空过支点 ①：先把「判据确实看到了东西」钉住。
  //    这一组断言的作用是：解析器一旦坏掉（目录遍历空、正则失配、注释规则把整份文件吃掉），
  //    下面的 `dangling.length === 0` 会**静默全绿**。有了下界，坏掉时必须红。
  assert.ok(
    scanned.length >= 30,
    `应扫到 ≥30 个 wxml，实测 ${scanned.length} —— 数不出来说明目录遍历坏了，`
    + '此时「零悬空绑定」毫无意义'
  );
  assert.ok(
    eventAttributeCount >= 380,
    `应数出 ≥380 个事件属性（剥注释后），实测 ${eventAttributeCount} —— `
    + '数不出来说明事件属性正则失配，判据会静默全绿'
  );
  assert.ok(
    checked >= 380,
    `应解析出 ≥380 个 handler 引用，实测 ${checked}`
    + `（其中动态绑定点 ${dynamicAttributeCount} 处、事件属性 ${eventAttributeCount} 个）`
  );

  // ★★ 防空过支点 ②：事件族必须成片覆盖。
  //    只扫 `bindtap` 也能得到「零悬空」，但会漏掉 99 条绑定 —— 这个下界把那种退路堵死。
  assert.ok(
    families.size >= 8,
    `应覆盖 ≥8 种事件族，实测 ${families.size} 种：`
    + [...families.entries()].map(([name, count]) => `${name}×${count}`).join(', ')
    + ' —— 只做 bindtap 会漏掉其余族里的绑定'
  );

  // ★★ 未覆盖写法：出现即显式失败，绝不静默跳过。
  assert.equal(
    colonFormCount, 0,
    `发现 ${colonFormCount} 处 \`bind:\`/\`catch:\` 冒号写法 —— 本判据的正则不认识它，`
    + '会把这些绑定**静默跳过**。请先扩展 EVENT_ATTRIBUTE_PATTERN 再放行。'
  );
  assert.equal(
    unquotedFormCount, 0,
    `发现 ${unquotedFormCount} 处不带引号的事件属性（如 \`bindtap=handler\`）—— `
    + '本判据只认带双引号的写法，其余会被静默跳过。'
  );

  assert.equal(
    WIRING_EXEMPTIONS.length, 0,
    `豁免名单必须为空，实测 ${WIRING_EXEMPTIONS.length} 条：`
    + JSON.stringify(WIRING_EXEMPTIONS)
    + ' —— 悬空绑定要修代码，不是加豁免'
  );

  // ★★ 主判据。必须排在旁证之前：主判据若在旁证之后，变异时会先在旁证上中断，
  //    主判据根本没被求值（本队纪律）。
  assert.equal(
    dangling.length, 0,
    '★★ 悬空绑定：wxml 上绑了、同名 js 的页面对象上却没有这个 handler —— '
    + '用户点下去会直接抛 `undefined is not a function`，而源码文本断言全绿。\n'
    + dangling.map((item) => `  ✗ ${item.file}:${item.line}  ${item.attribute}="${item.handler}"`
      + `（${item.dynamic ? '动态三元分支' : '静态绑定'}）`).join('\n')
    + `\n（已检查 ${checked} 个 handler 引用 / ${scanned.length} 个 wxml）`
  );
});

test('接线层判据自证：合成用例上必须判得出悬空绑定（防空过）', () => {
  const source = [
    '<view class="page">',
    '  <button bindtap="presentHandler">在的</button>',
    '  <button bindtap="missingHandler">不在的</button>',
    '  <input bindinput="missingInput" />',
    '</view>'
  ].join('\n');

  const bindings = collectBindings(source);
  assert.equal(
    bindings.refs.length, 3,
    `应解析出 3 个 handler 引用，实测 ${bindings.refs.length}：`
    + JSON.stringify(bindings.refs.map((item) => item.handler))
  );

  // 正向：页面对象上只有一个方法时，另外两条必须被判为悬空。
  const dangling = findDangling(bindings.refs, new Set(['presentHandler']));
  assert.deepEqual(
    dangling.map((item) => item.handler), ['missingHandler', 'missingInput'],
    '★ 判据必须**判得出来**：这是它非空过的证据。若这里变空，说明判据已经失去分辨力。'
  );
  assert.equal(
    dangling[0].line, 3,
    `悬空绑定的行号必须指向真实行（期望 3），实测 ${dangling[0].line} —— 行号错了会让定位失真`
  );

  // 反向：方法都在时**不得**误报。
  const none = findDangling(bindings.refs, new Set(['presentHandler', 'missingHandler', 'missingInput']));
  assert.equal(
    none.length, 0,
    `方法都在时不得误报，实测 ${none.length} 条：${JSON.stringify(none)}`
  );
});

test('接线层判据自证：注释与三元比较值不得被误当成 handler', () => {
  // ① 注释里的绑定必须被剥掉 —— 本仓 `pages/market/mine.wxml:31` 就是这种写法
  //    （注释里写着 `bindtap="goItem"`，那只是解释，不是真绑定）。
  const commented = [
    '<view class="page">',
    '  <!-- 这里提到 bindtap="goItem" 只是解释，不是真绑定 -->',
    '  <button catchtap="realHandler">删</button>',
    '</view>'
  ].join('\n');
  const commentedBindings = collectBindings(commented);
  assert.equal(
    commentedBindings.refs.length, 1,
    `注释里的绑定必须被剥掉，只应剩 1 条，实测 ${commentedBindings.refs.length}：`
    + JSON.stringify(commentedBindings.refs.map((item) => `${item.attribute}=${item.handler}`))
  );
  assert.equal(commentedBindings.refs[0].handler, 'realHandler', '注释外的那条必须留下');
  assert.equal(
    commentedBindings.refs[0].attribute, 'catchtap',
    '`catch*` 与 `bind*` 一样要扫 —— catchtap 同样会调 handler，漏了它等于漏掉 11 条'
  );

  // ② 三元里的**比较值**不是 handler —— 只有紧跟 `?` / `:` 的字面量才是。
  //    这条正是 `pages/orders/orders.wxml:90` 那个 14 分支嵌套三元的缩影。
  const ternary = `<button bindtap="{{key === 'pay' ? 'runPayment' : (key === 'store' ? 'goStore' : 'fallback')}}">去</button>`;
  const ternaryBindings = collectBindings(ternary);
  assert.deepEqual(
    ternaryBindings.refs.map((item) => item.handler).sort(), ['fallback', 'goStore', 'runPayment'],
    '★ 只应取 `?` / `:` 之后的字面量；`\'pay\'` 与 `\'store\'` 是比较值，不得算 handler。'
    + `实际：${JSON.stringify(ternaryBindings.refs.map((item) => item.handler))}`
  );
  assert.equal(
    ternaryBindings.refs.every((item) => item.dynamic), true,
    '动态三元分支必须被标记为 dynamic（断言消息里要能区分它和静态绑定）'
  );
});

test('接线层判据自证：运行时方法清单必须覆盖 spread 继承（静态正则的漏报点）', () => {
  // 本判据**不走静态正则**的关键理由：`Page({ ...mixin })` 这类继承形态，静态解析
  // 认不出 `...` 里带进来什么方法（认不出就会把**合法**绑定误判成悬空，或者反过来
  // 因为认不出而漏掉真实绑定）。运行时取 `Object.keys(definition)` 则天然覆盖 ——
  // 展开在对象字面量**求值时**就已经把键复制进来了。
  //
  // 这条用例把上面那句话变成**可判定的证据**：机制一旦退化（比如有人改成静态解析），
  // 它会立刻红。
  const fixture = [
    '(function () {',
    '  const base = {',
    '    inheritedTap() {},',
    '    async inheritedAsyncTap() {},',
    '    inheritedPropertyStyle: function () {},',
    '  };',
    '  const ownShorthand = function () {};',
    '  Page({',
    '    ...base,',
    '    ownShorthand,',
    '    ownMethod() {},',
    '  });',
    '})();'
  ].join('\n');

  const definition = withPageRuntime(() => {
    let captured = null;
    global.Page = (value) => { captured = value; };
    // 包在 IIFE 里跑：`vm.runInThisContext` 的顶层 `const` 会落进全局词法环境，
    // 重复运行会撞「Identifier has already been declared」。
    vm.runInThisContext(fixture, { filename: 'wiring-spread-fixture.js' });
    return captured;
  });

  const methods = new Set(
    Object.keys(definition).filter((key) => typeof definition[key] === 'function')
  );
  for (const name of [
    'inheritedTap',
    'inheritedAsyncTap',
    'inheritedPropertyStyle',
    'ownShorthand',
    'ownMethod'
  ]) {
    assert.ok(
      methods.has(name),
      `★ 运行时方法清单必须含 ${name} —— 展开（spread）与四种定义形态都应由它覆盖。`
      + `实测清单：${[...methods].sort().join(', ')}`
    );
  }
});
