/**
 * 「失败即空态」类的回归测试（T49）。
 *
 * ## 这一批修的是什么
 *
 * 页面在**接口失败**时把数据字段清空（`setData({list: []})` / `{store: null}`），
 * 于是 wxml 里的空态分支成立，页面渲染出一句关于**现实**的陈述：
 * 「店铺不存在或未通过平台核准」「商品不存在或已下架」「暂无订单」「0 条待回复」…
 * 而事实是「我们没取到」。两者对用户的意义完全不同 —— 后者是**假陈述**。
 *
 * ## 判别式（比清单重要）
 *
 * T23–T26 的修法可以抽象成一个模式：**引入一个专用的失败标志，并让空态分支带上它**。
 *
 * ```html
 * <view wx:if="{{recordsError}}" class="load-error card">…重试…</view>
 * <view wx:if="{{!loading && !recordsError && filtered.length === 0}}">还没有服务记录</view>
 * ```
 *
 * 反过来：**凡是 wxml 里根本没有失败标志的页面，就必然是「失败即空态」**。
 * 这把「逐个读代码找缺陷」变成了**可枚举的类**，也就是本文件第 2 节的两条判据。
 *
 * ## 本文件的三节
 *
 * 1. `utils/request-error.js` 的纯函数判据（404 与网络失败必须能分开）。
 * 2. **扫描式不变量**：全仓每个空态块的条件必须引用失败标志；
 *    外加**正向控制**、**判据自测**、**负向自测**、**页面集合 + 逐条理由**。
 * 3. **harness 行为验证**：把 `Page` / `wx` / 网络层注入进来，让页面真跑一遍，
 *    并**按 wxml 的条件求值把整页文案渲染出来** —— 这样「失败时不显示空态文案」
 *    才是被证明的，而不是被相信的。
 *
 * ## 与 T47 变异 ② 的关系
 *
 * T47 的教训是：`count === 0` 形态的负向断言，在**扫描器失效**时会静默通过。
 * 所以本文件的判据本体（第 3 条）**必须**配一条正向控制（第 2 条），
 * 且第 5 条用一个可注入的「扫描器坏掉」开关**实测**这个空过现象，把它钉进测试。
 *
 * ## 本判据**不覆盖**什么（把局限也钉住）
 *
 * 它只覆盖「失败渲染出假**文案**」这一类。失败导致**区块静默消失**（没有文案可说错，
 * 但用户看不到任何东西）不在判据范围内 —— 那类的根因相同（catch 里清空数据），
 * 但表现形式没有可检索的文案，因此无法用文案词表扫描。本批已手工修掉 4 处
 * （`home` 收藏/推荐、`checkout` 常用地址、`plate` 购车订单 picker），
 * 它们由第 3 节的 harness 用例逐个验证，而不是由扫描器覆盖。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const miniprogramDirectory = path.join(__dirname, '..', 'miniprogram');
const pagesDirectory = path.join(miniprogramDirectory, 'pages');
const requestError = require(path.join(miniprogramDirectory, 'utils', 'request-error.js'));

// ---------------------------------------------------------------------------
// 第 1 节：utils/request-error.js —— 404 与网络失败必须能分开
// ---------------------------------------------------------------------------

test('request-error：HTTP 404 与 *_NOT_FOUND 错误码都判为「资源不存在」', () => {
  assert.equal(requestError.isNotFoundError(Object.assign(new Error('x'), { statusCode: 404 })), true);
  assert.equal(requestError.isNotFoundError(Object.assign(new Error('x'), { code: 'STOREFRONT_NOT_FOUND' })), true);
  assert.equal(requestError.isNotFoundError(Object.assign(new Error('x'), { code: 'PRODUCT_NOT_FOUND' })), true);
  assert.equal(requestError.isNotFoundError(Object.assign(new Error('x'), { code: 'FORUM_POST_NOT_FOUND' })), true);
  // `statusCode` 是字符串 '404' 时也要认（不假定调用方一定给数字）。
  assert.equal(requestError.isNotFoundError(Object.assign(new Error('x'), { statusCode: '404' })), true);
});

test('request-error：网络失败 / 5xx 一律判为「可重试」，不得判成 404', () => {
  // ★ 这条是本模块存在的理由：`wx.cloud.callContainer` 网络失败时抛出的是
  //   **只有 errMsg 的普通对象**（见 lib/cloud-request.js —— `await callContainer(...)`
  //   的 rejection 直接向上传播，不经过 responseError()），既没有 statusCode 也没有 code。
  assert.equal(requestError.isNotFoundError({ errMsg: 'cloud.callContainer:fail timeout' }), false);
  assert.equal(requestError.isNotFoundError(Object.assign(new Error('x'), { statusCode: 500 })), false);
  assert.equal(requestError.isNotFoundError(Object.assign(new Error('x'), { statusCode: 503 })), false);
  assert.equal(requestError.isNotFoundError(Object.assign(new Error('x'), { code: 'INTERNAL_ERROR' })), false);
});

test('request-error：非对象入参一律判为「可重试」，不得抛错', () => {
  for (const value of [undefined, null, 0, '', 'boom', 404, true]) {
    assert.equal(requestError.isNotFoundError(value), false, `isNotFoundError(${JSON.stringify(value)}) 应为 false`);
  }
});

test('request-error：isRetryableError 与 isNotFoundError 严格互补', () => {
  const samples = [
    undefined, null, 0, 'x',
    { errMsg: 'fail' },
    Object.assign(new Error('x'), { statusCode: 404 }),
    Object.assign(new Error('x'), { code: 'ORDER_NOT_FOUND' }),
    Object.assign(new Error('x'), { statusCode: 500 })
  ];
  for (const sample of samples) {
    assert.equal(
      requestError.isRetryableError(sample),
      !requestError.isNotFoundError(sample),
      `互补性在 ${JSON.stringify(sample)} 上不成立`
    );
  }
});

// ---------------------------------------------------------------------------
// 第 2 节：扫描式不变量
// ---------------------------------------------------------------------------

/**
 * 空态文案词表。
 *
 * 判据按**文案**而不是按 class 取名，理由：`class="empty card"` 在本仓同时被
 * 「加载中」占位（「正在加载店铺信息」）使用，按 class 判会把加载态也扫进来。
 * 词表本身是判据的一部分，改动它必须同时改自测样本。
 */
const ABSENCE_WORDS = ['暂无', '不存在', '没有匹配', '这个筛选下', '还没', '未找到', '没有符合'];

/** 加载态文案词表：命中的块是「加载中」，不是「空态」，不参与判据。 */
const LOADING_WORDS = ['正在加载', '正在搜索', '正在同步', '正在获取', '加载中', '稍等'];

/**
 * 失败标志的命名口径。
 *
 * - `error` / `Error` —— 可重试的失败（错误占位 + 重试按钮）。
 * - `notFound` / `NotFound` —— 已确认的 404（`storeNotFound` / `itemNotFound` / `postNotFound`）。
 *
 * 两者**都允许**渲染空态文案：前者说明「我们没取到」，后者说明「服务端明确说这东西不存在」。
 * 真正禁止的是**没有任何标志** —— 也就是「数据为空」这个隐式条件，它在失败时同样成立。
 */
const FAILURE_FLAG_PATTERN = /error|notfound/i;

/** 正向控制只认「可重试失败」这一类标志（`addressesError` / `recordsError` / `*.error`）。 */
const RETRYABLE_FLAG_PATTERN = /error/i;

/** 这些标签常写成 `<image ... />`，也可能不写 `/`，一律按自闭合处理。 */
const VOID_TAGS = new Set([
  'image', 'input', 'import', 'include', 'wxs', 'icon', 'progress', 'switch',
  'slider', 'checkbox', 'radio', 'camera', 'open-data', 'ad', 'live-player', 'live-pusher', 'web-view'
]);

/** 标签扫描：`<name attrs>` / `</name>` / `<name attrs />`。 */
const TAG_PATTERN = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/** 第 `index` 个字符所在的行号（从 1 开始）。 */
function lineAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === '\n') line += 1;
  }
  return line;
}

/**
 * 解析一个标签的属性串（`name="value"` / `name='value'` / `name=value` / **裸 `name`**）。
 *
 * ★ 裸属性必须收进来。第一版只认 `name="value"`，于是 `wx:else`（WXML 里就写成裸的）
 * 被整条丢掉 —— `branchVisible` 看不到它，把「只有前面分支都为假才渲染」的块当成
 * **无条件渲染**，`merchant/apply.wxml:84` 那张空白入驻表单因此在失败时照样渲染出来。
 * `wx:else="{{...}}"` 也是合法写法，所以带值形态一并支持。
 *
 * @param {string} rawAttributes 标签名之后的原始属性串。
 * @returns {object} 属性名 → 属性值（裸属性为 `''`）。
 */
function parseAttributes(rawAttributes) {
  const attributes = {};
  const pattern = /([\w:.-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match = pattern.exec(rawAttributes);
  while (match !== null) {
    const value = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]);
    attributes[match[1]] = value === undefined ? '' : value;
    match = pattern.exec(rawAttributes);
  }
  return attributes;
}

/**
 * 源串里所有注释的区间（`<!--` 到 `-->`）。
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

/** `index` 是否落在某个注释区间内。 */
function insideComment(ranges, index) {
  return ranges.some((range) => index >= range[0] && index < range[1]);
}

/**
 * 把 wxml 解析成一棵元素树（忽略注释与文本节点，文本按需从源串切出来）。
 *
 * 为什么需要一个真解析器而不是逐行正则：空态块**经常跨行**，例如
 * `search.wxml:88` 的条件在第 88 行、文案在第 89 行 —— 逐行判会漏掉它。
 *
 * ★ 注释内部**一律不解析**：注释里写示例代码是常事，例如
 * ``<!-- 这段在 <block wx:if="{{scooter}}"> 外面 -->``。第一版没跳过它，
 * 于是注释里那个 `<block>` 被当成真元素，注释被切成两半、另一半还被重复渲染
 * 一次 —— 注释里的文案（往往正好含「暂无」这类词）就漏进了渲染结果，
 * 让「不得渲染出 X」的断言在**没修代码**时也命中。
 *
 * @param {string} source wxml 全文。
 * @returns {object} 伪根元素（`name === '#root'`）。
 */
function parseDocument(source) {
  const root = { name: '#root', attrs: {}, line: 1, index: 0, openEnd: 0, endIndex: source.length, parent: null, children: [] };
  const comments = commentRanges(source);
  const stack = [root];
  TAG_PATTERN.lastIndex = 0;
  let match = TAG_PATTERN.exec(source);
  while (match !== null) {
    if (insideComment(comments, match.index)) {
      match = TAG_PATTERN.exec(source);
      continue;
    }
    const [raw, closing, name, rawAttributes, selfClosing] = match;
    if (closing) {
      for (let cursor = stack.length - 1; cursor > 0; cursor -= 1) {
        if (stack[cursor].name === name) {
          stack[cursor].endIndex = match.index;
          // ★ `closeEnd` = 闭合标签之后一个字符。渲染文本时必须用它，不能用 `endIndex`：
          // `endIndex` 指向闭合标签的 `<`，拿它当「下一个片段的起点」会把 `</button>`
          // 这类闭合标签当成正文收集进去（第一版 renderText 就是这么漏出标签的）。
          stack[cursor].closeEnd = match.index + raw.length;
          stack.length = cursor;
          break;
        }
      }
      match = TAG_PATTERN.exec(source);
      continue;
    }
    const element = {
      name,
      attrs: parseAttributes(rawAttributes),
      line: lineAt(source, match.index),
      index: match.index,
      openEnd: match.index + raw.length,
      endIndex: match.index + raw.length,
      closeEnd: match.index + raw.length,
      parent: stack[stack.length - 1],
      children: []
    };
    element.parent.children.push(element);
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(element);
    match = TAG_PATTERN.exec(source);
  }
  return root;
}

/**
 * 元素的**整棵子树**文本（注释与标签全部剥掉，空白折叠）。
 *
 * 必须先剥注释再剥标签：注释里的示例代码（`<block wx:if="...">`）会被
 * `<[^>]*>` 只吃掉一半，剩下的注释正文 —— 往往正好含「暂无」这类词 ——
 * 会污染 `ABSENCE_WORDS` 判定，凭空造出一个空态块。
 */
function subtreeText(source, element) {
  return stripComments(source.slice(element.openEnd, element.endIndex))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把 wxml 注释从源串里抹掉。
 *
 * 两处都需要它，理由不同但同样必要：
 * - `renderText`：注释是**开发者写给开发者看**的，用户看不到。第一版渲染器把注释
 *   当成正文收集，于是「不得渲染出『商品不存在或已下架』」这条断言命中的其实是
 *   我写在注释里的那句解释 —— 断言在**没修代码**时也会「通过」（假绿）。
 * - 页面集合用例：`FAILURE_FLAG_PATTERN` 直接扫全文，注释里出现 `error` 一词就会
 *   让一个**没有失败标志**的页面看起来有标志，从而漏出枚举。
 *
 * @param {string} source wxml 全文。
 * @returns {string} 去掉注释后的源串。
 */
function stripComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * 把一个「元素与元素之间」的片段变成真正的文本节点内容。
 *
 * 按 `parseDocument` 的区间切出来的片段里不含子元素（子元素已被单独 walk），
 * 但仍可能含注释与（畸形嵌套下的）残留标签，一律剥掉。
 *
 * @param {string} fragment 源串片段。
 * @returns {string} 纯文本。
 */
function textOfFragment(fragment) {
  return stripComments(fragment).replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
}

/** 元素自身是否在某个 `wx:for` 里（逐项文案不是页面级空态）。 */
function insideForEach(element) {
  let cursor = element.parent;
  while (cursor) {
    if (typeof cursor.attrs['wx:for'] === 'string') return true;
    cursor = cursor.parent;
  }
  return false;
}

/** `b` 是否在 `a` 的子树里（用源串下标区间判定，与行号无关）。 */
function isInside(inner, outer) {
  return inner.index > outer.index && inner.endIndex <= outer.endIndex;
}

/**
 * 取一个元素所在的 `wx:if` / `wx:elif` / `wx:else` **链**上的全部条件（链头 → 本元素）。
 *
 * 为什么必须链式看：`wx:elif` 的守卫可能挂在链头的 `wx:if` 上。实例
 * `merchant/index.wxml` 的 `:293 wx:if="{{notificationsBlock.error}}"` →
 * `:297 wx:elif="{{notificationsBlock.data.items.length}}"` →
 * `:305 wx:elif="{{!notificationsBlock.loading}}"`：最后一支自己的条件里
 * **没有**失败标志，但它永远不会在失败时被求值，因为链头已经拦住了。
 * 只看本元素自己的条件会把它误判成违规（T48 勘察里正是这么误判过一次）。
 *
 * ★ `wx:else` 是**同一个坑的第二种形态**，第一版判据漏了它：`wx:else` 的语义是
 * 「前面所有分支都为假」，而 `wx:if="{{list.length}}"` 在**接口失败**时同样为假 ——
 * 于是 `wx:if="{{list.length}}"` / `wx:else`（空态）这一对，在失败时会渲染出
 * 「暂无数据」。实测就漏掉了 `checkout.wxml:40` 的「还没有常用地址」。
 * 所以 `wx:else` 也必须进候选，它的条件取**它前面的整条链**。
 *
 * @param {object} element 目标元素。
 * @returns {string[]} 从链头到本元素的条件；本元素不在链上时为空数组。
 */
function chainConditions(element) {
  const siblings = element.parent ? element.parent.children : [];
  const index = siblings.indexOf(element);
  if (index < 0) return [];
  const isElse = Object.prototype.hasOwnProperty.call(element.attrs, 'wx:else');
  const ownIf = typeof element.attrs['wx:if'] === 'string' ? element.attrs['wx:if'] : null;
  const ownElif = typeof element.attrs['wx:elif'] === 'string' ? element.attrs['wx:elif'] : null;
  if (!isElse && ownIf === null && ownElif === null) return [];
  // `wx:if` 是链头，它自己的条件就是整条链。
  if (ownIf !== null) return [ownIf];

  const conditions = ownElif !== null ? [ownElif] : [];
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const sibling = siblings[cursor];
    if (typeof sibling.attrs['wx:if'] === 'string') {
      conditions.unshift(sibling.attrs['wx:if']);
      break;
    }
    if (typeof sibling.attrs['wx:elif'] === 'string') {
      conditions.unshift(sibling.attrs['wx:elif']);
      continue;
    }
    break;
  }
  return conditions;
}

/**
 * 块**自己**在文案里把失败分流了 —— 例如 `home.wxml:13`：
 *
 * ```wxml
 * <text wx:else class="price-retry" catchtap="reloadCatalog">
 *   {{catalogError ? '价格加载失败，点击重试' : '暂无报价'}}
 * </text>
 * ```
 *
 * 这是「失败即空态」的**第三种**修法，也是最轻的一种：条件一个字不动，让**文案**
 * 在失败时说别的话。判据必须认它 —— 否则这种**已经正确**的写法会被误报，而误报
 * 会逼人把对的代码改坏，或者干脆把判据关掉。
 *
 * 判定是**求值**出来的，不是靠正则猜的：把表达式里所有形如 `xxxError` / `xxxNotFound`
 * 的标识符置成一句失败文案、其余标识符留 `undefined`（与 WXML 对未定义变量的处理一致），
 * 然后真求值。只要求值结果**不含任何空态词**，就说明「失败时它会说别的话」。
 *
 * ★ 已知局限（钉在这里，不藏在注释外）：本函数只检查「失败标志为真时这块说什么」，
 *   不检查那个标志是不是**本块**的失败标志。若有人拿另一个块的 `error` 来做三元条件，
 *   本判据会被骗过去。实测全仓没有这种写法；真出现时，行为用例（第 3 节）仍会抓到。
 *
 * @param {string} text 块的子树文本（含 `{{...}}` 原文）。
 * @returns {boolean} 失败时是否会改说别的话。
 */
function failureDivertedInText(text) {
  for (const raw of text.match(/\{\{[^{}]*\}\}/g) || []) {
    const expression = stripBraces(raw).trim();
    const identifiers = [...new Set(expression.match(/[A-Za-z_$][\w$]*/g) || [])];
    if (!identifiers.some((name) => FAILURE_FLAG_PATTERN.test(name))) continue;
    const values = identifiers.map((name) => (FAILURE_FLAG_PATTERN.test(name) ? '加载失败，请重试' : undefined));
    let rendered;
    try {
      // eslint-disable-next-line no-new-func
      rendered = new Function(...identifiers, `return (${expression});`)(...values);
    } catch (error) {
      continue;
    }
    if (typeof rendered === 'string' && !ABSENCE_WORDS.some((word) => rendered.includes(word))) return true;
  }
  return false;
}

/**
 * 扫描一段 wxml，找出所有「空态块」并判定它们是否被失败标志守卫。
 *
 * 一个元素算「空态块」需要同时满足：
 * 1. 带 `wx:if` / `wx:elif` / `wx:else`（是状态分支，不是无条件渲染）；
 * 2. 子树文本里含 {@link ABSENCE_WORDS} 里的词；
 * 3. 子树文本里**不含** {@link LOADING_WORDS} 里的词（那是加载态）；
 * 4. 不在 `wx:for` 里（逐项文案不是页面级空态）；
 * 5. **没有**同样满足 1~4 的后代 —— 取最内层，那才是真正的渲染点。
 *    没有这条，`store.wxml` 的 `<block wx:if="{{store}}">` 会因为**内部**那两个
 *    已被守卫的空态而被误报。
 *
 * ★ 第 1 条里的 `wx:else` 是第一版漏掉的（见 {@link chainConditions} 的注释）：
 *   `wx:if="{{list.length}}"` / `wx:else`（空态）这一对在失败时同样会渲染出「暂无数据」。
 *
 * @param {string} source wxml 全文。
 * @param {string} relativePath 用于报错的相对路径。
 * @returns {{blocks: object[], violations: object[], guarded: object[], retryableGuarded: object[]}}
 */
function scanSource(source, relativePath) {
  const root = parseDocument(source);
  const lines = source.split(/\r?\n/);
  const candidates = [];
  const collect = (element) => {
    const isElse = Object.prototype.hasOwnProperty.call(element.attrs, 'wx:else');
    const condition = typeof element.attrs['wx:if'] === 'string'
      ? element.attrs['wx:if']
      : (typeof element.attrs['wx:elif'] === 'string'
        ? element.attrs['wx:elif']
        : (isElse ? '(wx:else)' : null));
    if (condition !== null) {
      const text = subtreeText(source, element);
      const hasAbsence = ABSENCE_WORDS.some((word) => text.includes(word));
      const isLoading = LOADING_WORDS.some((word) => text.includes(word));
      if (hasAbsence && !isLoading && !insideForEach(element)) {
        const chain = chainConditions(element);
        const chainGuarded = chain.some((item) => FAILURE_FLAG_PATTERN.test(item));
        const divertedInText = failureDivertedInText(text);
        candidates.push({
          file: relativePath,
          line: element.line,
          condition,
          chain,
          text,
          sourceLine: (lines[element.line - 1] || '').trim(),
          // 三种合规形态：链上有失败标志、或本块自己在文案里分流了失败。
          guarded: chainGuarded || divertedInText,
          chainGuarded,
          divertedInText,
          retryableGuarded: chain.some((item) => RETRYABLE_FLAG_PATTERN.test(item)),
          index: element.index,
          endIndex: element.endIndex
        });
      }
    }
    element.children.forEach(collect);
  };
  root.children.forEach(collect);

  // 只保留最内层的候选（真正的渲染点）。
  const blocks = candidates.filter((candidate) => (
    !candidates.some((other) => other !== candidate && isInside(other, candidate))
  ));

  return {
    blocks,
    violations: blocks.filter((block) => !block.guarded),
    guarded: blocks.filter((block) => block.guarded),
    retryableGuarded: blocks.filter((block) => block.retryableGuarded)
  };
}

/** 列出 `miniprogram/pages/` 下所有 wxml 的相对路径（相对 `miniprogram/`）。 */
function listPageWxmlFiles() {
  const files = [];
  const walk = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = `${prefix}/${name}`;
      if (fs.statSync(absolute).isDirectory()) walk(absolute, relative);
      else if (name.endsWith('.wxml')) files.push(relative);
    }
  };
  walk(pagesDirectory, 'pages');
  return files;
}

/**
 * 扫描全仓 wxml。
 *
 * @param {object} [options] 入参。
 * @param {boolean} [options.brokenAlwaysEmpty] **仅供变异自测**：模拟「扫描器永远返回空数组」。
 * @returns {object} 扫描结果。
 */
function scanTree(options = {}) {
  const files = listPageWxmlFiles();
  if (options.brokenAlwaysEmpty === true) {
    return { blocks: [], violations: [], guarded: [], retryableGuarded: [], files };
  }
  const blocks = [];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(miniprogramDirectory, relative), 'utf8');
    blocks.push(...scanSource(source, relative).blocks);
  }
  return {
    blocks,
    violations: blocks.filter((block) => !block.guarded),
    guarded: blocks.filter((block) => block.guarded),
    retryableGuarded: blocks.filter((block) => block.retryableGuarded),
    files
  };
}

/**
 * 判据自测用的人造样本。刻意覆盖五类形态，让「扫描器坏掉」无法悄悄通过：
 * 1. 无守卫的空态（**唯一一处违规**，第 3 行）；
 * 2. 带 `error` 守卫的空态（合规，第 4 行）；
 * 3. `wx:elif` 链、守卫挂在链头的 `wx:if` 上（合规，第 7 行 —— 最易误判的一类）；
 * 4. `wx:for` 里的逐项文案（应被排除，第 8 行）；
 * 5. 加载态文案（应被排除，第 2 行）。
 */
const SAMPLE_WXML = [
  '<view class="page">',
  '  <view wx:if="{{loading}}" class="empty card"><view class="muted">正在加载…</view></view>',
  '  <view wx:elif="{{!items.length}}" class="empty card"><view class="muted">暂无数据</view></view>',
  '  <view wx:if="{{itemsError}}" class="load-error card"><view class="muted">暂无数据（加载失败）</view></view>',
  '  <view wx:if="{{listError}}" class="load-error card">加载失败</view>',
  '  <view wx:elif="{{list.length}}" class="list">有内容</view>',
  '  <view wx:elif="{{!list.loading}}" class="empty card"><view class="muted">暂无记录</view></view>',
  '  <view wx:for="{{rows}}" wx:key="id" class="row"><view class="muted">该商品暂无库存</view></view>',
  '</view>'
].join('\n');

test('判据自测：人造样本上必须数出恰好 1 处违规，并报出 文件:行 + 整行原文', () => {
  const result = scanSource(SAMPLE_WXML, 'sample.wxml');
  const summary = result.violations.map((item) => `${item.file}:${item.line} ${item.sourceLine}`).join('\n');
  assert.equal(result.violations.length, 1, `应恰好数出 1 处违规，实际 ${result.violations.length} 处：\n${summary}`);
  assert.equal(result.violations[0].line, 3, '违规应在第 3 行（`wx:elif="{{!items.length}}"` 那句）');
  assert.match(result.violations[0].sourceLine, /wx:elif="\{\{!items\.length\}\}"/, '报出的整行原文必须是那一行的原文');
  assert.match(result.violations[0].text, /暂无数据/, '报出的文案应能被看见');

  assert.equal(result.blocks.length, 3, '样本里应只有 3 个空态块（1 违规 + 2 合规）');
  assert.equal(result.guarded.length, 2, '应认出 2 处合规空态');
  assert.equal(result.retryableGuarded.length, 2, '2 处合规空态都应带 error 守卫');
  assert.ok(
    !result.blocks.some((block) => block.text.includes('该商品暂无库存')),
    '`wx:for` 里的逐项文案必须被排除'
  );
  assert.ok(
    !result.blocks.some((block) => block.text.includes('正在加载')),
    '加载态文案必须被排除'
  );
});

/**
 * 正向控制：必须能数出 ≥4 处**带 error 守卫**的空态分支。
 *
 * ★ 这是 T47 变异 ② 立下的纪律：`count === 0` 形态的负向断言（「不得出现 X」）
 *   在扫描器失效时会**静默通过**。所以要配一条「能数出 X」的正向控制 ——
 *   扫描器一旦坏掉，这一条先红。
 */
test('正向控制：必须能数出 ≥4 处带 error 守卫的空态分支（防空过）', () => {
  const result = scanTree();
  const found = result.retryableGuarded.map((block) => block.file);
  assert.ok(
    result.retryableGuarded.length >= 4,
    `扫描器应至少数出 4 处带 error 守卫的空态分支，实际 ${result.retryableGuarded.length} 处（文件：${[...new Set(found)].join(', ')}）`
  );
  // 控制点必须点名 T23–T26 已经修好的四处，否则「≥4」可能被新写的代码凑数满足。
  for (const expected of ['pages/addresses/addresses.wxml', 'pages/orders/orders.wxml', 'pages/aftersales/aftersales.wxml', 'pages/merchant/index.wxml']) {
    assert.ok(found.includes(expected), `正向控制里应包含 ${expected}（T23–T26 的既有成果）`);
  }
});

/** 块的稳定标识（不含行号 —— 插一行注释就会让行号漂移，键会假红）。 */
function blockKey(block) {
  return `${block.file} :: ${block.condition}`;
}

/** 判据本体的核心：从扫描结果里去掉**显式豁免**，剩下的才是真违规。 */
function unexemptedViolations(result) {
  return result.violations.filter((block) => !EXEMPT_ABSENCE_BLOCKS.has(blockKey(block)));
}

/**
 * 判据本体**整体**是否成立 —— 两层：
 * 1. 去掉显式豁免后没有违规；
 * 2. 实际被标红的集合与豁免清单**逐项一致**（不能有僵尸豁免，也不能有未登记的标红）。
 *
 * 第 2 层是本轮新加的，它给判据本体一个**非空**的期望值 —— 于是扫描器坏掉时
 * 判据本体不再空过（见「负向自测」用例）。T47 变异 ② 的教训就在这里被关掉。
 */
function criterionBodyHolds(result) {
  const flagged = result.violations.map(blockKey).sort().join('|');
  const exempt = [...EXEMPT_ABSENCE_BLOCKS.keys()].sort().join('|');
  return unexemptedViolations(result).length === 0 && flagged === exempt;
}

/**
 * 判据的**显式豁免**清单 —— 每条都要写清「为什么在这里引用失败标志是不可能 / 会是说谎」。
 *
 * 为什么要有它，而不是放宽判据：判据的措辞是「条件必须引用失败标志」。有一类块
 * **结构上**满足不了它 —— 它断言的那个集合与页面主对象同源于**一次**请求，而那次
 * 请求失败时页面会**离开**当前页。此时既没有「停在工作台」的稳定状态，也没有一个
 * 属于本块的失败标志可引用；硬造一个，等于为满足判据而说谎。
 *
 * ★ 但「豁免」不是「不管」：每条豁免都由**行为用例**独立验证（见本节末尾的
 *   「豁免验证」用例）—— 真的把该页跑一遍、让所有请求失败、渲染整页文案，
 *   断言里面没有任何空态词。所以豁免的是**判据的措辞**，不是**用户看到的东西**。
 *
 * ★ 而且豁免清单本身**同时充当判据本体的正向控制**：判据本体会断言
 *   「实际被标红的块」与「豁免清单」逐项一致。扫描器一旦坏掉（返回空数组），
 *   实际集合变成空集 ≠ 期望的豁免集合 → 判据本体**红**。
 *   这正是 T47 变异 ② 那个教训的进一步加固：判据本体不再空过。
 */
const EXEMPT_ABSENCE_BLOCKS = new Map([
  ['pages/merchant/index.wxml :: {{merchant && !orders.length}}', {
    reason: '`orders` 与页面主对象 `merchant` 同源于**一次** `/api/merchant/overview`'
      + '（`merchant/index.js:301-317` 的同一次 setData）；该请求失败时 `.catch`（`merchant/index.js:424-432`）'
      + '会把页面 redirectTo 到入驻页 —— 不存在「停在工作台、订单却取不到」的稳定状态，'
      + '也就没有一个属于本块的失败标志可引用。'
      + '已改成 `{{merchant && !orders.length}}` 做行为兜底（商家数据没加载出来就绝不断言「暂无订单」），'
      + '但它引用的是数据对象、不是失败标志，故在此登记。'
  }]
]);

test('判据本体：全仓每个空态块的 wx:if|wx:elif|wx:else 条件都必须引用失败标志', () => {
  const result = scanTree();
  const violations = unexemptedViolations(result);
  const detail = violations
    .map((item) => `  ${item.file}:${item.line}\n    条件：${item.condition}\n    原文：${item.sourceLine}`)
    .join('\n');
  assert.deepEqual(
    violations,
    [],
    `有 ${violations.length} 处空态块的条件里没有失败标志 —— 这些块在接口失败时会把「没取到」渲染成「不存在」：\n${detail}`
  );
  assert.ok(result.blocks.length > 0, '判据本体必须真的扫到空态块（否则它与「没有空态块」无法区分）');

  // ★ 豁免清单必须**正好**覆盖当前被标红的那些块：
  //   - 多一条 → 代码已经修好却还挂着豁免（僵尸豁免），红；
  //   - 少一条 → 有新块无声地掉进这个坑，红。
  const flaggedKeys = result.violations.map(blockKey).sort();
  const exemptKeys = [...EXEMPT_ABSENCE_BLOCKS.keys()].sort();
  assert.deepEqual(
    flaggedKeys,
    exemptKeys,
    '豁免清单必须与实际被标红的块逐项一致（不能有僵尸豁免，也不能有未登记的标红）'
  );
  // 每个豁免键必须**恰好**命中一个块，否则键太粗，会连带豁免掉别的块。
  for (const key of EXEMPT_ABSENCE_BLOCKS.keys()) {
    assert.equal(
      flaggedKeys.filter((item) => item === key).length,
      1,
      `豁免键「${key}」应恰好命中 1 个块（键太粗会连带豁免别的块）`
    );
  }
});

test('负向自测：扫描器永远返回空数组时，正向控制必须红，而判据本体的第一层仍然空过', () => {
  const healthy = scanTree();
  const broken = scanTree({ brokenAlwaysEmpty: true });

  // 前置：健康扫描器确实有东西可数（与「当前这棵树是否干净」无关）。
  assert.ok(healthy.retryableGuarded.length >= 4, '前置条件：健康扫描器应能数出 ≥4 处');
  assert.ok(healthy.blocks.length > 0, '前置条件：健康扫描器应能数出空态块');

  // ★ 正向控制会红（这就是它存在的理由）。
  assert.ok(broken.retryableGuarded.length < 4, '扫描器坏掉时正向控制必须红（数不出 ≥4 处）');
  assert.equal(broken.retryableGuarded.length, 0, '扫描器坏掉时它数出的必然是 0 处');

  // ★★ 判据本体**第一层**空过 —— 这是 T47 变异 ② 的结论，在这里被实测钉住。
  assert.deepEqual(broken.violations, [], '扫描器坏掉时判据本体是「通过」的（空过），而不是红的');
  assert.deepEqual(unexemptedViolations(broken), [], '去掉豁免后同样是空集 —— 这一层确实还在空过');
  assert.deepEqual(broken.blocks, [], '扫描器坏掉时连空态块都数不出来');

  // ★★★ 本轮（T49）的加固：判据本体**整体不再空过**。
  //
  // 上一版判据本体只有一条断言（「违规集合为空」），扫描器坏掉时它必然通过 ——
  // 这正是 T47 变异 ② 的教训。现在判据本体多了**第二层**：实际被标红的集合必须与
  // 豁免清单逐项一致。它给判据一个**非空**的期望值，于是扫描器坏掉时第二层必红。
  // 换句话说：**豁免清单本身充当了判据本体的正向控制**。
  assert.equal(
    criterionBodyHolds(broken),
    false,
    '★ 判据本体整体必须红（第一层空过，但第二层的豁免一致性断言给出非空期望值）'
  );
});

/**
 * 「wxml 里不含失败标志」的页面集合 —— **逐个显式枚举 + 附理由**。
 *
 * ★ 为什么锁集合而不是锁数字：锁「=== N」会因为合法的新增/删除而**假红**，
 *   也会因为同时增一减一而**假绿**。锁集合并给每个成员写理由，可以让
 *   将来新加的页面**转红**，逼迫一次有意识的决定：要么加失败标志，
 *   要么在这里登记一条能站得住的理由。
 *
 * 理由不是散文：下面每条都由「该页 wxml 里没有任何空态文案」这一**可验证事实**支撑，
 * 用例会真的去数一遍。理由站不住时用例会红，而不是让人相信注释。
 */
const PAGES_WITHOUT_FAILURE_FLAG = new Map([
  ['pages/map/map', '禁区（团队约定：地图相关文件不改）；且 wxml 里没有任何空态文案，失败不会渲染出「不存在」类陈述。'],
  ['pages/consult/consult', '咨询表单页：唯一的提交 catch 走 showModal 报错，不驱动任何空态。'],
  ['pages/edit-order/edit-order', '改约表单页：加载失败直接 toast + navigateBack 退出，页面不会停留在空态。'],
  ['pages/agreement/agreement', '静态协议文档：正文来自本地常量，没有网络加载路径。'],
  ['pages/recharge/detail', '充值详情页：两个 catch 都是提交 / 支付动作失败（modal / toast），不驱动空态。'],
  ['pages/forum/publish', '发布表单页：两个 catch 是图片上传与发布提交失败，不驱动空态。']
]);

test('页面集合：wxml 不含失败标志的页面必须逐个登记理由，且理由必须成立', () => {
  const pages = JSON.parse(fs.readFileSync(path.join(miniprogramDirectory, 'app.json'), 'utf8')).pages;
  const withoutFlag = [];
  for (const page of pages) {
    const file = path.join(miniprogramDirectory, `${page}.wxml`);
    if (!fs.existsSync(file)) continue;
    // ★ 先剥注释再判：注释里写一句 `error` 不该让一个没有失败标志的页面「看起来有」。
    if (!FAILURE_FLAG_PATTERN.test(stripComments(fs.readFileSync(file, 'utf8')))) withoutFlag.push(page);
  }
  withoutFlag.sort();

  const registered = [...PAGES_WITHOUT_FAILURE_FLAG.keys()].sort();
  const unregistered = withoutFlag.filter((page) => !PAGES_WITHOUT_FAILURE_FLAG.has(page));
  const stale = registered.filter((page) => !withoutFlag.includes(page));
  assert.deepEqual(
    unregistered,
    [],
    `这些页面的 wxml 里没有任何失败标志，却没有在 PAGES_WITHOUT_FAILURE_FLAG 里登记理由：\n  ${unregistered.join('\n  ')}\n`
    + '要么给它加失败标志（空态块的条件必须引用它），要么在枚举里写明一条能站得住的理由。'
  );
  assert.deepEqual(
    stale,
    [],
    `这些页面已经在枚举里登记过，但现在已经有了失败标志，请把登记项删掉：\n  ${stale.join('\n  ')}`
  );
  assert.deepEqual(withoutFlag, registered, '枚举必须与实际集合逐项一致');

  // ★ 理由必须成立：逐个页面真的去数一遍空态文案，一条都没有才算「不需要失败标志」。
  for (const page of withoutFlag) {
    const source = stripComments(fs.readFileSync(path.join(miniprogramDirectory, `${page}.wxml`), 'utf8'));
    const hits = ABSENCE_WORDS.filter((word) => source.includes(word));
    assert.deepEqual(
      hits,
      [],
      `${page} 登记的理由是「wxml 里没有任何空态文案」，但实际出现了：${hits.join('、')} —— 理由站不住了，必须改代码或改理由`
    );
  }
});

// ---------------------------------------------------------------------------
// 第 3 节：harness 行为验证 —— 让页面真跑一遍，并渲染出这一屏的文案
// ---------------------------------------------------------------------------

/** 把 `{ 'a.b.c': value }` 形式的补丁写进对象，与微信 `setData` 的路径语义一致。 */
function applyPatch(data, patch) {
  for (const key of Object.keys(patch)) {
    const parts = key.split('.');
    let target = data;
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (typeof target[parts[index]] !== 'object' || target[parts[index]] === null) target[parts[index]] = {};
      target = target[parts[index]];
    }
    target[parts[parts.length - 1]] = patch[key];
  }
}

/** 等一个宏任务，确保 Promise 链跑完。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 取 `data` 上的 `a.b` 路径值。 */
function resolvePath(data, expression) {
  const parts = expression.split('.');
  let value = data;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

/** 去掉 `{{ }}`。 */
function stripBraces(value) {
  return String(value).replace(/^\{\{|\}\}$/g, '');
}

/**
 * 求值一个 wxml 表达式。
 *
 * 只用来把页面**真实状态**映射成「这一屏会渲染出什么文案」，因此必须真求值而不是近似 ——
 * 否则「网络失败时不显示空态文案」这条断言就没有证据。
 * 标识符按名注入为函数形参；未在 `data` 上的名字取 `undefined`，
 * 与 WXML 对未定义变量的处理一致。
 *
 * @param {string} expression 不含 `{{ }}` 的表达式。
 * @param {object} data 页面数据。
 * @returns {unknown} 求值结果；求值失败时返回 `undefined`。
 */
function evaluateExpression(expression, data) {
  try {
    const identifiers = [...new Set(expression.match(/[A-Za-z_$][\w$]*/g) || [])];
    const values = identifiers.map((name) => resolvePath(data, name));
    // eslint-disable-next-line no-new-func
    return new Function(...identifiers, `return (${expression});`)(...values);
  } catch (error) {
    return undefined;
  }
}

/** 把 `{{ }}` 替换成求值结果。 */
function interpolate(text, data) {
  return text.replace(/\{\{([^}]*)\}\}/g, (full, expression) => {
    const value = evaluateExpression(expression.trim(), data);
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * 判断一个元素在当前 `data` 下是否渲染（`wx:if` / `wx:elif` / `wx:else` 链语义）。
 *
 * ★ `wx:if` / `wx:elif` / `wx:else` 是一条**有序链**：从链头开始逐个求值，
 *   **第一个为真的分支渲染，其余全都不渲染**。所以三者的语义分别是：
 *   - `wx:if`   —— 开链，只看自己的条件；
 *   - `wx:elif` —— 前面所有分支都为假 **且** 自己为真；
 *   - `wx:else` —— 前面所有分支都为假。
 *
 * ★ 这里修的是一个**真实缺陷**（T50 决策 1）。旧实现的循环写成
 *   `for (let cursor = index; …) { … if (cursor === index) return value; }` ——
 *   第一轮就 `return`，于是**返回的是本元素自己的条件，前面的兄弟分支从未被检查**，
 *   `wx:elif` 被当成了 `wx:if`。（`wx:else` 走的是另一条分支、本来就正确，
 *   所以**只有 `wx:elif` 错**。）
 *
 *   实测（T50 勘察）：`merchant/orders.wxml` 在 `loading === true` 时会被旧实现
 *   渲染成「正在加载… **暂无订单**」—— 而 `:8 wx:if="{{loading}}"` 为真时，
 *   `:12 wx:elif` 在 WXML 里**根本不求值**，这两句不可能同屏。
 *
 *   影响面要说清：旧行为让 `renderText` **多渲染**，对「不得渲染出 X」这类断言
 *   属**保守方向**（更容易红，不产生假绿），所以它没有掏空 T49 的既有断言；
 *   但它**不能**用来回答「首屏到底渲染什么」—— 而本文件第 4 节的首屏判据要的
 *   正是后者，所以必须修正。
 *
 * ★ 链断了（`wx:elif` / `wx:else` 前面找不到紧邻的链头，或链中间夹了非链元素）时
 *   一律返回 `true`：那是 WXML 编译器会直接报错的写法，本仓没有；真出现时宁可
 *   **多渲染**（让「不得渲染出 X」的断言更容易红），也不要少渲染而放过缺陷。
 *
 * @param {object} element 元素。
 * @param {object} data 页面数据。
 * @returns {boolean} 是否渲染。
 */
function branchVisible(element, data) {
  const hasIf = typeof element.attrs['wx:if'] === 'string';
  const hasElif = typeof element.attrs['wx:elif'] === 'string';
  const hasElse = Object.prototype.hasOwnProperty.call(element.attrs, 'wx:else');
  if (!hasIf && !hasElif && !hasElse) return true;

  const siblings = element.parent ? element.parent.children : [];
  const index = siblings.indexOf(element);
  if (index < 0) return true;

  // 找链头：`wx:if` 自己就是链头；否则往前找**紧邻**的 `wx:if`。
  let head = index;
  if (!hasIf) {
    head = -1;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const sibling = siblings[cursor];
      if (typeof sibling.attrs['wx:if'] === 'string') { head = cursor; break; }
      const isChainMember = typeof sibling.attrs['wx:elif'] === 'string'
        || Object.prototype.hasOwnProperty.call(sibling.attrs, 'wx:else');
      if (!isChainMember) break;
    }
    if (head < 0) return true;
  }

  // 从链头走到本元素：第一个为真的分支渲染，其余都不渲染。
  for (let cursor = head; cursor <= index; cursor += 1) {
    const sibling = siblings[cursor];
    const siblingIf = typeof sibling.attrs['wx:if'] === 'string';
    const siblingElif = typeof sibling.attrs['wx:elif'] === 'string';
    const siblingElse = Object.prototype.hasOwnProperty.call(sibling.attrs, 'wx:else');
    if (!siblingIf && !siblingElif && !siblingElse) return true;
    const value = siblingElse
      ? true
      : Boolean(evaluateExpression(
        stripBraces(siblingIf ? sibling.attrs['wx:if'] : sibling.attrs['wx:elif']), data
      ));
    if (cursor === index) return value;
    if (value) return false;
  }
  return false;
}

/**
 * 把一页 wxml 在当前 `data` 下**渲染成一段纯文本**（从磁盘读该页 wxml）。
 *
 * 这是第 3 / 4 节所有「不得渲染出 X」断言的证据来源：不是断言状态字段，
 * 而是断言**用户实际会看到的那段文字**。
 *
 * ★ 这里**只负责读文件**，渲染本体在 `renderTextFromSource`。
 *   T50 收尾把这段 walk 抽了出去：原先 `renderTextFromSource` 是它的**逐行副本**，
 *   两处各有一份 walk。副本一旦漂移，用**人造样本**自测出来的结论就**不再能代表**
 *   那二十余条跑在**真实页面**上的断言 —— 而「判据自测」的全部价值就在于
 *   「自测跑的东西与真断言跑的东西是同一套」。现在两者共用同一份实现，
 *   结构上不可能分家。
 *
 * @param {string} relativeWxmlPath 相对 `miniprogram/` 的 wxml 路径。
 * @param {object} data 页面数据。
 * @returns {string} 渲染出的文案。
 */
function renderText(relativeWxmlPath, data) {
  const source = fs.readFileSync(path.join(miniprogramDirectory, relativeWxmlPath), 'utf8');
  return renderTextFromSource(source, data);
}

/** 这一屏是否会出现某段文字。 */
function renders(relativeWxmlPath, data, needle) {
  return renderText(relativeWxmlPath, data).includes(needle);
}

/**
 * 从**源码串**渲染一屏文案 —— **渲染本体**（`renderText` 只负责读文件后调它）。
 *
 * 人造样本（`ELIF_SEMANTICS_SAMPLE` / `FIRST_SCREEN_SAMPLE`）靠它渲染，
 * 所以**判据自测**与**真实页面的断言**走的是同一份实现。
 *
 * `wx:for` 只渲染第一项（我们关心的是页面级空态文案，它们都在循环之外）；
 * 列表为空时整棵子树跳过。
 *
 * 片段先剥注释 / 残留标签，再插值 —— 顺序不能反：注释里若写了 `{{...}}`，
 * 先插值就会把它渲染出来。
 *
 * @param {string} source wxml 全文。
 * @param {object} data 页面数据。
 * @returns {string} 渲染出的文案。
 */
function renderTextFromSource(source, data) {
  const root = parseDocument(source);
  const chunks = [];
  const walk = (element, scope) => {
    if (!branchVisible(element, scope)) return;
    let currentScope = scope;
    const forExpression = element.attrs['wx:for'];
    if (typeof forExpression === 'string') {
      const list = evaluateExpression(stripBraces(forExpression), scope);
      if (!Array.isArray(list) || list.length === 0) return;
      currentScope = { ...scope, item: list[0], index: 0 };
    }
    let cursor = element.openEnd;
    for (const child of element.children) {
      chunks.push(interpolate(textOfFragment(source.slice(cursor, child.index)), currentScope));
      cursor = child.closeEnd;
      walk(child, currentScope);
    }
    chunks.push(interpolate(textOfFragment(source.slice(cursor, element.endIndex)), currentScope));
  };
  for (const child of root.children) walk(child, data);
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * ★ 决策 1 要求的**判据自测**：把 `wx:if` / `wx:elif` / `wx:else` 的**链语义**钉死。
 *
 * 为什么要专门钉它：T50 勘察发现 `branchVisible` 的旧实现从**本元素自己的下标**起步，
 * 第一轮就 `return` 了自己的条件 —— 于是 `wx:elif` 被当成 `wx:if` 求值，
 * **前面的兄弟分支从未被检查**。后果是 `renderText` **多渲染**：
 * `merchant/orders.wxml` 在首屏被渲染成「正在加载… 暂无订单」（两句不可能同屏）。
 *
 * 这个 bug 是**隐蔽**的：多渲染只会让「不得渲染出 X」的断言**更容易红**，所以 T49
 * 那批断言没有因此假绿；它甚至让 `merchant/apply` 那条「结构上不可能成立」的断言
 * **恰好通过**。换句话说，**本文件原有的任何一条断言都发现不了它** ——
 * 这条自测就是补上这个缺口的：人造一份最小 wxml，逐种取值断言**只有一个分支被渲染**。
 *
 * ★ 旧实现（T50 前）在本用例的取值 ① 与 ④ 下必红 —— 它会把「乙分支」也渲染出来。
 *   这正是决策 1 说的「把 `wx:elif` 的语义改回旧行为 → 本自测必须红」。
 */
const ELIF_SEMANTICS_SAMPLE = [
  '<view class="page">',
  '  <view wx:if="{{flag}}" class="a">甲分支</view>',
  '  <view wx:elif="{{other}}" class="b">乙分支</view>',
  '  <view wx:else class="c">丙分支</view>',
  '</view>'
].join('\n');

test('判据自测：wx:elif 只在前面的分支都为假时才渲染（链语义，钉住 branchVisible 的修复）', () => {
  // ① `wx:if` 为真 → 只有甲分支；`wx:elif` 自己也为真，但**不得**渲染（旧实现正是在这里错）。
  const first = renderTextFromSource(ELIF_SEMANTICS_SAMPLE, { flag: true, other: true });
  assert.ok(first.includes('甲分支'), `正向控制：wx:if 为真时甲分支必须渲染，实际：${first}`);
  assert.equal(first.includes('乙分支'), false, `★ wx:if 为真时 wx:elif 不得渲染，实际：${first}`);
  assert.equal(first.includes('丙分支'), false, `wx:if 为真时 wx:else 不得渲染，实际：${first}`);

  // ② `wx:if` 为假、`wx:elif` 为真 → 只有乙分支。
  const second = renderTextFromSource(ELIF_SEMANTICS_SAMPLE, { flag: false, other: true });
  assert.equal(second.includes('甲分支'), false, `wx:if 为假时甲分支不得渲染，实际：${second}`);
  assert.ok(second.includes('乙分支'), `正向控制：wx:elif 为真时乙分支必须渲染，实际：${second}`);
  assert.equal(second.includes('丙分支'), false, `wx:elif 为真时 wx:else 不得渲染，实际：${second}`);

  // ③ 前两个分支都为假 → 只有丙分支。
  const third = renderTextFromSource(ELIF_SEMANTICS_SAMPLE, { flag: false, other: false });
  assert.equal(third.includes('甲分支'), false, `两个分支都为假时甲分支不得渲染，实际：${third}`);
  assert.equal(third.includes('乙分支'), false, `两个分支都为假时乙分支不得渲染，实际：${third}`);
  assert.ok(third.includes('丙分支'), `正向控制：wx:else 必须渲染，实际：${third}`);

  // ④ 链被**非链元素**打断（`wx:elif` 前面不再是紧邻的链成员）→ `branchVisible`
  //    保守返回「渲染」。这是有意的取舍：真出现这种写法（WXML 编译器本会报错）
  //    时，宁可**多渲染**（让「不得渲染出 X」的断言更容易红），也不要少渲染而放过缺陷。
  //    旧实现在这里返回自己的条件（假）→ 本组取值下也会红。
  const brokenChain = [
    '<view class="page">',
    '  <view wx:if="{{flag}}" class="a">甲分支</view>',
    '  <view class="divider">分隔</view>',
    '  <view wx:elif="{{other}}" class="b">乙分支</view>',
    '</view>'
  ].join('\n');
  const fourth = renderTextFromSource(brokenChain, { flag: true, other: false });
  assert.ok(
    fourth.includes('乙分支'),
    `链被非链元素打断时 branchVisible 保守返回 true（多渲染），实际：${fourth}`
  );
});

/**
 * 搭好页面运行环境。
 *
 * 只拦截 `miniprogram/services/*` 与 `utils/navigation`；
 * `utils/load-state` / `utils/request-error` / `utils/product-view` 用**真模块** ——
 * 测的是真实接线，不是替身。
 *
 * @returns {object} 测试用的控制面。
 */
function createHarness() {
  const storage = {};
  const toasts = [];
  const modals = [];
  const wxStub = new Proxy({
    getStorageSync: (key) => storage[key],
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: (key) => { delete storage[key]; },
    showToast: (options) => { toasts.push(options); },
    showModal: (options) => { modals.push(options); },
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

  let apiHandler = () => Promise.resolve({ data: {} });
  let cachedScooter = null;
  const stubs = new Map([
    [require.resolve(path.join(miniprogramDirectory, 'services', 'api.js')), {
      request: (requestPath, options) => apiHandler(requestPath, options),
      apiRequest: (requestPath, options) => apiHandler(requestPath, options),
      userId: () => 'user-1'
    }],
    [require.resolve(path.join(miniprogramDirectory, 'services', 'business.js')), {
      loadBusinessConfig: () => Promise.resolve({}),
      FALLBACK_SERVICE_CONTACT: '15527111396'
    }],
    [require.resolve(path.join(miniprogramDirectory, 'services', 'store.js')), {
      getScooter: () => cachedScooter,
      getScooters: () => (cachedScooter ? [cachedScooter] : [])
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
  let captured = null;

  Module._load = function patchedLoad(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (stubs.has(resolved)) return stubs.get(resolved);
    return originalLoad.apply(this, arguments);
  };
  global.Page = (definition) => { captured = definition; };
  global.wx = wxStub;

  return {
    setApiHandler(handler) { apiHandler = handler; },
    setCachedScooter(value) { cachedScooter = value; },
    getToasts() { return toasts.slice(); },
    getModals() { return modals.slice(); },
    loadPage(relativePath) {
      captured = null;
      const file = path.join(miniprogramDirectory, relativePath);
      delete require.cache[require.resolve(file)];
      // ★ 页面**间接** require 的工具模块也必须从缓存里清掉，否则它会继续持有
      //   上一个 harness 的桩（详见 test/miniapp-page-blocks.test.js 的同名注释）。
      for (const name of fs.readdirSync(path.join(miniprogramDirectory, 'utils'))) {
        if (!name.endsWith('.js')) continue;
        delete require.cache[require.resolve(path.join(miniprogramDirectory, 'utils', name))];
      }
      require(file);
      assert.ok(captured, `${relativePath} 应调用 Page() 注册页面`);
      const definition = captured;
      const instance = {
        data: JSON.parse(JSON.stringify(definition.data)),
        setData(patch) { applyPatch(this.data, patch); }
      };
      for (const key of Object.keys(definition)) {
        if (typeof definition[key] === 'function') instance[key] = definition[key].bind(instance);
      }
      return instance;
    },
    restore() {
      Module._load = originalLoad;
      global.Page = originalPage;
      global.wx = originalWx;
    }
  };
}

/** 网络失败的形态：`wx.cloud.callContainer` 抛出的是只有 `errMsg` 的普通对象。 */
const NETWORK_FAILURE = { errMsg: 'cloud.callContainer:fail timeout' };

/** 构造一个带 code / statusCode 的服务端错误，形态与 `lib/cloud-request.js` 一致。 */
function serverError(code, statusCode, message) {
  return Object.assign(new Error(message || code), { code, statusCode });
}

const STORE_PAYLOAD = {
  data: {
    merchant: { id: 'merchant_001', name: '狮山校园车行' },
    productCount: 1,
    totalSalesCount: 0,
    deliveryResponseHours: 24,
    products: [{ id: 'p1', name: '轻风 通勤版', priceInCents: 239900, stock: 8, category: 'E_BIKE_NEW' }],
    reviews: [{ id: 'r1', rating: 5, content: '很省心', createdAt: '2026-09-01T10:20:00.000Z' }],
    reviewSummary: { count: 1, averageRating: 5, positiveRate: 1 }
  }
};

test('store：网络失败 → 错误占位 + 可重试，且三个渲染点都不落空态文案', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    const page = harness.loadPage('pages/store/store.js');
    page.onLoad({ id: 'merchant_001' });
    await settle();
    await settle();

    assert.equal(page.data.storefrontError, '加载失败，请重试', '网络失败必须落成可见的错误占位');
    assert.equal(page.data.storeNotFound, false, '网络失败**不得**被当成 404');
    assert.equal(page.data.loading, false);
    assert.equal(page.data.store, null, '首屏失败本来就没有数据，这里不涉及清空');
    assert.equal(harness.getToasts().length, 0, '不再用会消失的 toast 承载这个失败');

    const rendered = renderText('pages/store/store.wxml', page.data);
    assert.ok(rendered.includes('加载失败，请重试'), `应渲染错误占位，实际渲染：${rendered}`);
    for (const falseStatement of ['店铺不存在或未通过平台核准', '这家店暂无在售商品', '这家店暂无已购评价']) {
      assert.equal(
        rendered.includes(falseStatement),
        false,
        `网络失败时不得渲染「${falseStatement}」，实际渲染：${rendered}`
      );
    }
    assert.equal(typeof page.retryStorefront, 'function', 'wxml 上绑定的重试入口必须存在');
  } finally {
    harness.restore();
  }
});

test('store：真 404 → 常驻「店铺不存在或未通过平台核准」，且不渲染错误占位', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.reject(serverError('STOREFRONT_NOT_FOUND', 404, '店铺不存在或未通过平台核准')));
    const page = harness.loadPage('pages/store/store.js');
    page.onLoad({ id: 'merchant_002' });
    await settle();
    await settle();

    assert.equal(page.data.storeNotFound, true, '404 必须落成 storeNotFound');
    assert.equal(page.data.storefrontError, '', '404 不得落成可重试错误（重试一百次也还是 404）');
    const rendered = renderText('pages/store/store.wxml', page.data);
    assert.ok(rendered.includes('店铺不存在或未通过平台核准'), `404 时应渲染常驻文案，实际渲染：${rendered}`);
    assert.equal(rendered.includes('加载失败，请重试'), false);
    assert.equal(harness.getToasts().length, 0, '404 也不该弹会消失的 toast');
  } finally {
    harness.restore();
  }
});

test('store：成功后再失败 → 旧数据仍在，三处空态文案依旧不出现', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.resolve(STORE_PAYLOAD));
    const page = harness.loadPage('pages/store/store.js');
    page.onLoad({ id: 'merchant_001' });
    await settle();
    await settle();
    assert.equal(page.data.store.name, '狮山校园车行', '前置条件：首次加载应成功');
    assert.equal(page.data.products.length, 1);

    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    await page.loadStorefront();
    await settle();
    await settle();

    assert.equal(page.data.store.name, '狮山校园车行', '★ 失败不得清空 store');
    assert.equal(page.data.products.length, 1, '★ 失败不得清空 products');
    assert.equal(page.data.reviews.length, 1, '★ 失败不得清空 reviews');
    assert.equal(page.data.storefrontError, '加载失败，请重试');
    const rendered = renderText('pages/store/store.wxml', page.data);
    assert.ok(rendered.includes('加载失败，请重试'), `错误占位必须与旧数据同屏，实际渲染：${rendered}`);
    for (const falseStatement of ['店铺不存在或未通过平台核准', '这家店暂无在售商品', '这家店暂无已购评价']) {
      assert.equal(rendered.includes(falseStatement), false, `不得渲染「${falseStatement}」，实际渲染：${rendered}`);
    }
  } finally {
    harness.restore();
  }
});

test('detail：网络失败（非 404）→ 可重试占位，不得说成「车型不存在或已下架」', async () => {
  const harness = createHarness();
  try {
    harness.setCachedScooter(null);
    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    const page = harness.loadPage('pages/detail/detail.js');
    page.onLoad({ id: 'prod_ebike_001' });
    await settle();
    await settle();

    assert.equal(page.data.loadError, '加载失败，请重试', '网络失败必须落成 loadError');
    assert.equal(page.data.goneText, '车型不存在或已下架', '`goneText` 的初值不动，但它此刻不得被渲染');
    const rendered = renderText('pages/detail/detail.wxml', page.data);
    assert.ok(rendered.includes('加载失败，请重试'), `应渲染错误占位，实际渲染：${rendered}`);
    assert.equal(
      rendered.includes('车型不存在或已下架'),
      false,
      `网络失败时不得渲染「车型不存在或已下架」，实际渲染：${rendered}`
    );
    assert.equal(typeof page.retryProduct, 'function');
  } finally {
    harness.restore();
  }
});

test('detail：真 404 → 维持「该商品已下架」（M2-P1-03 的成果不得被破坏）', async () => {
  const harness = createHarness();
  try {
    harness.setCachedScooter(null);
    harness.setApiHandler(() => Promise.reject(serverError('PRODUCT_NOT_FOUND', 404, '商品不存在')));
    const page = harness.loadPage('pages/detail/detail.js');
    page.onLoad({ id: 'prod_gone' });
    await settle();
    await settle();

    assert.equal(page.data.loadError, '', '404 不得落成可重试错误');
    assert.equal(page.data.goneText, '该商品已下架');
    const rendered = renderText('pages/detail/detail.wxml', page.data);
    assert.ok(rendered.includes('该商品已下架'), `404 时应渲染常驻「该商品已下架」，实际渲染：${rendered}`);
    assert.equal(rendered.includes('加载失败，请重试'), false);
  } finally {
    harness.restore();
  }
});

test('detail：有本地缓存时失败 → 用缓存渲染，不报错也不说「不存在」', async () => {
  const harness = createHarness();
  try {
    harness.setCachedScooter({ id: 's1', name: '轻风 通勤版', priceInCents: 239900, stock: 8 });
    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    const page = harness.loadPage('pages/detail/detail.js');
    page.onLoad({ id: 's1' });
    await settle();
    await settle();

    assert.ok(page.data.scooter, '有缓存时必须用缓存渲染');
    assert.equal(page.data.loadError, '', '有缓存可渲染时不报错');
    const rendered = renderText('pages/detail/detail.wxml', page.data);
    assert.equal(rendered.includes('车型不存在或已下架'), false, `实际渲染：${rendered}`);
    assert.equal(rendered.includes('加载失败，请重试'), false, `实际渲染：${rendered}`);
  } finally {
    harness.restore();
  }
});

test('plate：购车订单加载失败 → 不落「请先完成模拟购车」这条引导下单的假陈述', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    const page = harness.loadPage('pages/plate/plate.js');

    // ★ 首屏（`onShow` 之前，请求还没发出）也必须干净（T49 收尾补的一段）。
    //   这是同一条假陈述的**第三种触发时机**：`ordersError` 的初值是 `''`，
    //   所以只被 `!ordersError` 守着的空态在「还没取到」时同样成立 ——
    //   改造后由 `ordersLoaded` 区分「还没问过」与「问过、确实为空」。
    assert.equal(page.data.ordersLoaded, false, '前置：首屏还没得到答复');
    const beforeLoad = renderText('pages/plate/plate.wxml', page.data);
    assert.equal(
      beforeLoad.includes('请先完成模拟购车'),
      false,
      `首屏还没取到订单时不得渲染引导下单的文案，实际渲染：${beforeLoad}`
    );
    assert.equal(
      beforeLoad.includes('选择购车订单'),
      false,
      `首屏还没取到订单时不得留下一个空字段标签，实际渲染：${beforeLoad}`
    );

    page.onShow();
    await settle();
    await settle();

    // ★ 文案带主语：这一屏上 `statusBlock` 也有错误占位，两句一样的「加载失败，请重试」
    //   叠在一起会让用户分不清哪块挂了。
    assert.equal(page.data.ordersError, '购车订单加载失败，请重试');
    assert.equal(page.data.ordersLoaded, true, '失败也算「得到了答复」');
    assert.equal(page.data.eligibleOrders.length, 0, '失败本来就没有数据，这里不涉及清空');
    const rendered = renderText('pages/plate/plate.wxml', page.data);
    assert.ok(rendered.includes('加载失败，请重试'), `应渲染错误占位，实际渲染：${rendered}`);
    assert.equal(
      rendered.includes('请先完成模拟购车'),
      false,
      `失败时不得渲染引导下单的文案，实际渲染：${rendered}`
    );
    assert.equal(
      rendered.includes('选择购车订单'),
      false,
      `失败时不得留下一个空字段标签，实际渲染：${rendered}`
    );
    assert.equal(typeof page.retryOrders, 'function');
  } finally {
    harness.restore();
  }
});

test('merchant/reviews：失败时 pendingReviewCount 不得被写成 0（那是断言「都回复过了」）', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.resolve({
      data: {
        reviews: [
          { id: 'r1', rating: 5, content: '很好', createdAt: '2026-09-01T10:20:00.000Z', reply: null },
          { id: 'r2', rating: 4, content: '不错', createdAt: '2026-09-02T10:20:00.000Z', reply: { content: '谢谢' } }
        ]
      }
    }));
    const page = harness.loadPage('pages/merchant/reviews.js');
    page.onShow();
    await settle();
    await settle();
    assert.equal(page.data.pendingReviewCount, 1, '前置条件：1 条待回复');
    assert.equal(page.data.reviews.length, 2);

    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    await page.load();
    await settle();
    await settle();

    assert.equal(page.data.pendingReviewCount, 1, '★ 失败不得把待回复数写成 0');
    assert.equal(page.data.reviews.length, 2, '★ 失败不得清空评价列表');
    assert.equal(page.data.reviewsError, '加载失败，请重试');
    const rendered = renderText('pages/merchant/reviews.wxml', page.data);
    assert.ok(rendered.includes('加载失败，请重试'), `应渲染错误占位，实际渲染：${rendered}`);
    assert.equal(rendered.includes('暂无已购评价'), false, `不得渲染「暂无已购评价」，实际渲染：${rendered}`);
    assert.ok(rendered.includes('1 条待回复'), `失败后仍应显示上一次成功取到的「1 条待回复」，实际渲染：${rendered}`);
  } finally {
    harness.restore();
  }
});

test('notifications：失败 → 不落「消息都已读完」与「这个筛选下暂无消息」两句假陈述', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    const page = harness.loadPage('pages/notifications/notifications.js');
    page.onShow();
    await settle();
    await settle();

    assert.equal(page.data.error, '加载失败，请重试');
    assert.equal(page.data.loaded, false, '失败不算「加载过」，工具栏因此不渲染');
    assert.equal(page.data.unreadCount, 0, '初值仍是 0 —— 正因如此才需要 `loaded` 这个标志');
    const rendered = renderText('pages/notifications/notifications.wxml', page.data);
    assert.ok(rendered.includes('加载失败，请重试'), `应渲染错误占位，实际渲染：${rendered}`);
    for (const falseStatement of ['消息都已读完', '这个筛选下暂无消息']) {
      assert.equal(
        rendered.includes(falseStatement),
        false,
        `失败时不得渲染「${falseStatement}」，实际渲染：${rendered}`
      );
    }
  } finally {
    harness.restore();
  }
});

test('notifications：成功后再失败 → 旧列表与未读数仍在（为分页做准备）', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.resolve({
      data: [
        { id: 'n1', type: 'ORDER', title: '订单已发货', content: 'x', createdAt: '2026-09-01T10:20:00.000Z', read: false },
        { id: 'n2', type: 'SCORE', title: '服务分更新', content: 'y', createdAt: '2026-09-02T10:20:00.000Z', read: true }
      ]
    }));
    const page = harness.loadPage('pages/notifications/notifications.js');
    page.onShow();
    await settle();
    await settle();
    assert.equal(page.data.unreadCount, 1);
    assert.equal(page.data.loaded, true);

    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    await page.loadNotifications();
    await settle();
    await settle();

    assert.equal(page.data.unreadCount, 1, '★ 失败不得把未读数清成 0');
    assert.equal(page.data.notifications.length, 2, '★ 失败不得清空已加载列表');
    assert.equal(page.data.filteredNotifications.length, 2, '★ 失败不得清空已筛选列表');
    assert.equal(page.data.error, '加载失败，请重试');
    const rendered = renderText('pages/notifications/notifications.wxml', page.data);
    assert.ok(rendered.includes('1 条未读'), `旧未读数必须仍可见，实际渲染：${rendered}`);
    assert.equal(rendered.includes('这个筛选下暂无消息'), false);
  } finally {
    harness.restore();
  }
});

test('market/item：网络失败与真 404 必须分开（前者可重试，后者才说「不存在或已下架」）', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    let page = harness.loadPage('pages/market/item.js');
    page.onLoad({ id: 'market_1' });
    page.onShow();
    await settle();
    await settle();
    assert.equal(page.data.itemError, '加载失败，请重试');
    assert.equal(page.data.itemNotFound, false);
    let rendered = renderText('pages/market/item.wxml', page.data);
    assert.equal(
      rendered.includes('商品不存在或已下架'),
      false,
      `网络失败时不得说「商品不存在或已下架」，实际渲染：${rendered}`
    );
    assert.ok(rendered.includes('加载失败，请重试'));

    harness.setApiHandler(() => Promise.reject(serverError('MARKET_ITEM_NOT_FOUND', 404, '闲置不存在')));
    page = harness.loadPage('pages/market/item.js');
    page.onLoad({ id: 'market_gone' });
    page.onShow();
    await settle();
    await settle();
    assert.equal(page.data.itemNotFound, true);
    assert.equal(page.data.itemError, '');
    rendered = renderText('pages/market/item.wxml', page.data);
    assert.ok(rendered.includes('商品不存在或已下架'), `404 时应渲染常驻文案，实际渲染：${rendered}`);
  } finally {
    harness.restore();
  }
});

test('merchant/apply：失败时不得把 application 置空（否则被驳回的商家会看到空白表单）', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.resolve({
      data: [{ id: 'm1', name: '狮山数码驿站', status: 'REJECTED', reviewNote: '资质材料不符合要求' }]
    }));
    const page = harness.loadPage('pages/merchant/apply.js');
    page.onShow();
    await settle();
    await settle();
    assert.equal(page.data.application.status, 'REJECTED', '前置条件：已取到被驳回的申请');

    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    await page.loadApplication();
    await settle();
    await settle();

    assert.equal(page.data.application.status, 'REJECTED', '★ 失败不得把 application 置空');
    assert.equal(page.data.applicationError, '加载失败，请重试');
    const rendered = renderText('pages/merchant/apply.wxml', page.data);
    assert.ok(rendered.includes('加载失败，请重试'), `应渲染错误占位，实际渲染：${rendered}`);
    assert.ok(rendered.includes('驳回原因'), `被驳回的商家仍应看到驳回原因与复审入口，实际渲染：${rendered}`);
    assert.equal(rendered.includes('选择开店主体'), false, '失败时不得落进「全新申请表单」');
  } finally {
    harness.restore();
  }
});

test('merchant/apply：首屏失败 → 错误占位，绝不渲染空白入驻表单', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    const page = harness.loadPage('pages/merchant/apply.js');
    page.onShow();
    await settle();
    await settle();

    assert.equal(page.data.application, null);
    assert.equal(page.data.applicationError, '加载失败，请重试');
    const rendered = renderText('pages/merchant/apply.wxml', page.data);
    assert.ok(rendered.includes('加载失败，请重试'), `应渲染错误占位，实际渲染：${rendered}`);
    assert.equal(
      rendered.includes('选择开店主体'),
      false,
      `★ 首屏失败时不得渲染「选择开店主体」——那会让已有申请的商家重复提交，实际渲染：${rendered}`
    );
    assert.equal(typeof page.retryApplication, 'function');
  } finally {
    harness.restore();
  }
});

/**
 * T50 [A]：**成功路径**上的空白入驻表单。
 *
 * 为什么需要这条新断言：T49 修掉的是**失败路径**（失败时把 `application` 置空 → 落进
 * 最后那条「全新申请表单」）。但 `apply.wxml` 里「已驳回」那一支当时写的是 `wx:if`
 * 而不是 `wx:elif` —— 它**自开一条新链**，把紧随其后的 `wx:elif` / `wx:else` 都绑到了
 * 「已驳回」这个条件上。于是**任何有申请、且不是 REJECTED 的状态**（REVIEWING / APPROVED）
 * 都会掉进那条 `wx:else`：
 *
 *   `:12` 为真 → 渲染状态卡；`:33` 为假 → `:else` 为真 → **同时**渲染一张全新的空白表单。
 *
 * 后果与 T49 认定的最高危害同源：一个「审核中」的商家看到空白入驻表单 → **重复提交**。
 * 而且**没有任何断言覆盖成功路径**，所以它一直没被发现。
 *
 * ★ 这条断言是**新增**的（根 `test/` 只增不改），它守的正是本次修掉的那条路。
 */
test('merchant/apply：审核中的商家（成功路径）不得渲染全新空白入驻表单', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.resolve({
      data: [{ id: 'm2', name: '审核中店铺', status: 'REVIEWING' }]
    }));
    const page = harness.loadPage('pages/merchant/apply.js');
    page.onShow();
    await settle();
    await settle();

    assert.equal(page.data.application.status, 'REVIEWING', '前置条件：已取到审核中的申请');
    assert.equal(page.data.applicationError, '', '前置条件：这次没有失败');
    const rendered = renderText('pages/merchant/apply.wxml', page.data);
    assert.equal(
      rendered.includes('选择开店主体'),
      false,
      `★ 审核中的商家不得看到「全新申请表单」—— 那会让他重复提交，实际渲染：${rendered}`
    );
    assert.ok(rendered.includes('平台审核'), `审核中的商家应看到自己的状态卡，实际渲染：${rendered}`);
    assert.ok(
      rendered.includes('平台正在核对资质材料'),
      `审核中的商家应看到进度说明，实际渲染：${rendered}`
    );
    assert.equal(
      rendered.includes('加载失败，请重试'),
      false,
      `这次没有失败，不该出现错误占位，实际渲染：${rendered}`
    );

    // 同一个状态 + 刷新失败：错误占位**必须可见**（它现在是一条独立的链），
    // 同时状态卡照旧、空白表单仍然不得出现。
    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    await page.loadApplication();
    await settle();
    await settle();
    assert.equal(page.data.application.status, 'REVIEWING', '★ 失败不得把 application 置空');
    assert.equal(page.data.applicationError, '加载失败，请重试');
    const failed = renderText('pages/merchant/apply.wxml', page.data);
    assert.ok(
      failed.includes('加载失败，请重试'),
      `★ 审核中的商家刷新失败时也必须看到错误占位（它现在与内容链解耦），实际渲染：${failed}`
    );
    assert.ok(failed.includes('平台审核'), `失败时旧数据仍应可见，实际渲染：${failed}`);
    assert.equal(
      failed.includes('选择开店主体'),
      false,
      `★ 失败时同样不得渲染空白表单，实际渲染：${failed}`
    );
  } finally {
    harness.restore();
  }
});

test('scooters：缓存为空时失败 → 错误占位，不落「没有匹配的车型」', async () => {
  const harness = createHarness();
  try {
    harness.setCachedScooter(null);
    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    const page = harness.loadPage('pages/scooters/scooters.js');
    page.onLoad({});
    await settle();
    await settle();

    assert.equal(page.data.scootersError, '加载失败，请重试', '缓存为空 + 失败 → 必须落成可见错误');
    const rendered = renderText('pages/scooters/scooters.wxml', page.data);
    assert.ok(rendered.includes('加载失败，请重试'), `应渲染错误占位，实际渲染：${rendered}`);
    assert.equal(
      rendered.includes('没有匹配的车型'),
      false,
      `缓存为空时不得落「没有匹配的车型」，实际渲染：${rendered}`
    );
  } finally {
    harness.restore();
  }
});

test('scooters：缓存非空时失败 → 用缓存渲染 + toast，不报错（原有行为不变）', async () => {
  const harness = createHarness();
  try {
    harness.setCachedScooter({ id: 's1', name: '轻风 通勤版', priceInCents: 239900, stock: 8 });
    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    const page = harness.loadPage('pages/scooters/scooters.js');
    page.onLoad({});
    await settle();
    await settle();

    assert.equal(page.data.scootersError, '', '有缓存可渲染时不报错');
    assert.equal(page.data.scooters.length, 1, '必须用缓存渲染');
    assert.equal(harness.getToasts().length, 1, '保持原有的「已显示缓存」toast');
    assert.match(harness.getToasts()[0].title, /已显示缓存/);
  } finally {
    harness.restore();
  }
});

/**
 * 豁免验证 —— 把 {@link EXEMPT_ABSENCE_BLOCKS} 里的每一条都**行为验证**一遍。
 *
 * 这一条是把「豁免」与「不管」区分开的关键：豁免的是判据的**措辞**（「条件必须引用
 * 失败标志」），不是**用户看到的东西**。所以这里真的把该页跑一遍、让所有请求失败、
 * 渲染整页文案，断言里面没有任何空态词。
 *
 * 如果将来有人删掉 `merchant/index.js` 里那个 redirectTo、让页面在失败时停在工作台，
 * 这条用例会红 —— 那时豁免的理由就不成立了，必须回去加真正的失败标志。
 */
test('豁免验证：merchant/index 在所有请求失败时不停在工作台，也不渲染任何空态文案', async () => {
  const harness = createHarness();
  try {
    harness.setApiHandler(() => Promise.reject(NETWORK_FAILURE));
    const page = harness.loadPage('pages/merchant/index.js');
    page.onLoad();
    await settle();
    await settle();
    await settle();

    assert.equal(page.data.merchant, null, '前置条件：主对象没加载出来');
    assert.equal(page.data.orders.length, 0, '前置条件：订单集合为空');

    const rendered = renderText('pages/merchant/index.wxml', page.data);
    for (const word of ABSENCE_WORDS) {
      assert.equal(
        rendered.includes(word),
        false,
        `所有请求都失败时不得渲染任何空态文案「${word}」，实际渲染：${rendered}`
      );
    }
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// 第 4 节：首屏行为判据 —— 第三种时机（「请求发出之前」）
// ---------------------------------------------------------------------------
//
// 为什么需要这一节（T50 的核心问题）：
//
// 第 2 节的**静态判据**问的是「空态块的条件里有没有引用失败标志」。它挡住了
// 「接口失败 → 落空态」这个时机，但**挡不住首屏**：把 `detail.wxml:15` 的 `!loading`
// 拿掉，条件仍然是 `{{!scooter && !loadError}}` —— 它**确实引用了失败标志**，
// 静态判据照样绿。可首屏那一刻 `scooter` 还没取到、`loadError` 也还是空串，
// 于是条件成立、空态文案照渲染。**静态判据问不出这个问题，因为它问的不是同一件事。**
//
// 所以这一节换一个**行为判据**：不解析 wxml，而是把页面**真的装起来**、
// 取它**自己声明的初值**、把整页**渲染成纯文本**，然后断言这段文本里
// **不出现**任何「关于『这里没有东西』的事实陈述」。
//
// ★ 作用域（这份判据覆盖什么）
//   - **时机**：只有**首屏**这一个 —— `harness.loadPage` 内部是
//     `JSON.parse(JSON.stringify(definition.data))`，取页面自己声明的初值，
//     且**不调 `onLoad` / `onShow`**，所以拿到的正是「请求发出之前」那一刻。
//   - **页面**：`pages/**/*.wxml` 里**每一个**有同名 js 的页面（实测 34 个，全配对）。
//     这比第 2 节更宽 —— 第 2 节只覆盖「有空态块」的 25 个页面，本节的词表判据
//     对**没有空态块**的 9 个页面同样生效（它们一样可能在首屏渲染出空态文案）。
//   - **判定对象**：用户实际会看到的那段文字，而不是状态字段。所以祖先守卫、
//     兄弟链、块内三元分流三种合规形态**自动被覆盖** —— 不需要分别建模。
//
// ★ 盲区（这份判据覆盖不到什么）—— 必须写在明处
//   1. **只覆盖首屏这一个时机**。「接口失败」那个时机归第 3 节（T49 那批用例）与
//      第 2 节的静态判据；「改造前清空数据」也归它们。三条互补，刻意不重叠。
//   2. **它只认词表**。这是**行为**判据，不是语义判据：文案换一种说法
//      （例如「这里空空如也」）而词表没收录，就漏。所以词表必须**显式枚举 +
//      逐词给理由**，新增文案时要同步维护（见 `FIRST_SCREEN_ABSENCE_WORDS`）。
//   3. `renderText` 的 `wx:for` **只渲染第一项**、列表为空时整棵子树跳过。
//      首屏列表都是空的，所以循环体里的逐项文案不会进渲染 —— 这对本判据是**有利**的：
//      循环体里的「暂无库存」是**逐项**文案，不是页面级空态，不该算命中。
//      代价是「循环体在首屏渲染出空态词」这种情况本判据看不见（本仓没有这种写法）。
//   4. 本仓**没有自定义组件**（`miniprogram/` 下无 `components/` 目录，`app.json`
//      无 `usingComponents`），所以不需要考虑组件内部的空态；将来引入组件要回来补。

/**
 * 首屏**不得出现**的「空态词」——**显式枚举 + 逐词给理由**。
 *
 * 入选标准（两条都要满足）：
 *   a. 该词表达的是**关于某个集合 / 状态为空的事实断言**（「这里没有东西」）；
 *   b. 首屏那一刻**结构上无从得知**该事实（还没发出请求，或请求还没回来）。
 *
 * 排除标准：只表示**加载中**（「正在加载」）或**失败**（「加载失败」）的词 ——
 * 那两句在首屏是**真话**，必须允许。它们由正向控制单独计数。
 *
 * ★ 为什么用「包含」而不是正则边界：本仓文案是中文，没有词边界；逐词用
 *   `String.includes` 是最不容易出错的做法。代价是可能误伤（见每条 reason 里
 *   标注的「误伤风险」）。
 */
const FIRST_SCREEN_ABSENCE_WORDS = [
  {
    word: '暂无',
    reason: '「暂无 X」是对**某个集合为空**的直接事实断言。首屏还没得到任何答复，集合为空只是因为还没填 —— 说出来就是假陈述。T50 勘察实测：本仓的空态文案以这个形态为主（2 处真缺陷都用它）。误伤风险：低 —— 本仓没有「暂无」出现在非空态语境里的写法。'
  },
  {
    word: '已售罄',
    reason: '「该套餐已售罄，暂不可办理」（`card.wxml:66`）等价于「这里没有可办理的东西」，是关于**可售状态**的事实断言。首屏无从得知（T50 决策 4 明确要求收录）。误伤风险：低 —— 本仓只有套餐卡用它，而套餐数据首屏必然为空。'
  },
  {
    word: '不存在',
    reason: '最强的空态断言（「店铺不存在」「车型不存在」）。首屏无从得知对象是否存在。误伤风险：低。'
  },
  {
    word: '未找到',
    reason: '「不存在」的同义变体，搜索结果为空时的常用说法。误伤风险：低。'
  },
  {
    word: '没有匹配',
    reason: '「没有匹配的结果」—— 对**筛选 / 搜索结果为空的**事实断言。首屏还没筛过。误伤风险：低。'
  },
  {
    word: '没有符合',
    reason: '同上。本仓 `store.wxml:71` 用的正是这个措辞（「没有符合筛选的商品」）。误伤风险：低。'
  },
  {
    word: '还没',
    reason: '「还没有常用地址」这类**弱化形态**。T48 实测漏过一次（`checkout.wxml:40`）—— 形态与「暂无」不同，但同样是关于「这里没有东西」的断言。误伤风险：**中** —— 「还没」也可能出现在「还没选好车型」这类**引导**语境里；当前 0 命中，将来若命中要逐条看，而不是直接加豁免。'
  },
  {
    word: '这个筛选下',
    reason: 'T23–T26 既有空态文案的固定开头（「这个筛选下暂无消息」）。收录它 = 收录那批文案，与既有 `ABSENCE_WORDS` 保持同一口径。误伤风险：低。'
  },
  {
    word: '未通过',
    reason: '「店铺不存在或未通过平台核准」（`store.wxml:10`）—— 对**平台核准状态**的事实断言。首屏无从得知。误伤风险：低 —— 需要 `storeNotFound` 为真才会渲染，而首屏它必然为假。'
  },
  {
    word: '已下架',
    reason: '「该商品已下架」—— 对**上架状态**的事实断言，首屏无从得知。M2-P1-03 那轮消灭的假陈述就是它。误伤风险：低。'
  },
  {
    word: '无记录',
    reason: '「暂无记录」的同义变体。误伤风险：低。'
  }
];

/**
 * 首屏**必须允许**出现的「加载态词」—— 正向控制用。
 *
 * 直接复用第 2 节的 `LOADING_WORDS`：那批词已经由 T23–T26 的既有成果
 * 反向验证过（它们确实出现在本仓的加载态分支里）。这里不再另立一套，
 * 避免两处词表漂移。
 */
const FIRST_SCREEN_LOADING_WORDS = LOADING_WORDS;

/**
 * 正向控制的下限：首屏必须能数出 ≥ 这么多页面在渲染加载态文案。
 *
 * ★ 为什么需要它：本节的判据本体是「命中集合为空」—— 一个 `=== 0` 形态的
 *   负向断言。渲染器一旦坏掉（返回空串、或 `loadPage` 拿不到页面），
 *   命中自然为 0，判据**静默通过**。T47 变异 ② 立下的纪律就是给它配一条
 *   「能数出 X」的正向控制，让渲染器坏掉时**这一条先红**。
 *
 * ★ 为什么是 10 而不是「全部 34 个」：并非每个页面首屏都有加载态分支
 *   （例如 `pages/agreement` 是纯静态文档，`pages/plate` 的首屏要看
 *   `source` 分支，`pages/profile` 首屏说的是「正在读取认证状态…」—— 那句话
 *   不在 `LOADING_WORDS` 里）。T50 实测值是 **22 个页面**，
 *   10 是它向下留出余量后的下限 —— 远高于 0，又不会因为某页合法地
 *   去掉一个加载占位而假红。
 */
const FIRST_SCREEN_LOADING_PAGE_MIN = 10;

/** 页面配对：`pages/x/y.wxml` + 同名 `.js`（实测 34 个 wxml 全部配对，无缺无余）。 */
function listPagePairs() {
  return listPageWxmlFiles()
    .filter((relative) => fs.existsSync(
      path.join(miniprogramDirectory, relative.replace(/\.wxml$/, '.js'))
    ))
    .map((relative) => ({ wxml: relative, js: relative.replace(/\.wxml$/, '.js') }));
}

/** 文本里命中了哪些空态词（按词表顺序返回，便于报告原文）。 */
function firstScreenAbsenceWordsIn(text) {
  return FIRST_SCREEN_ABSENCE_WORDS
    .filter((entry) => text.includes(entry.word))
    .map((entry) => entry.word);
}

/** 文本里命中了哪些加载态词。 */
function firstScreenLoadingWordsIn(text) {
  return FIRST_SCREEN_LOADING_WORDS.filter((word) => text.includes(word));
}

/**
 * 首屏扫描：逐个页面「装起来 → 取真实初值 → 渲染整页 → 查词表」。
 *
 * @param {object} [options] 入参。
 * @param {boolean} [options.brokenRenderer] **仅供负向自测**：模拟「渲染器返回空串」。
 * @returns {object} 扫描结果。
 */
function firstScreenScan(options = {}) {
  const harness = createHarness();
  const pages = [];
  try {
    for (const pair of listPagePairs()) {
      const page = harness.loadPage(pair.js);
      const text = options.brokenRenderer === true ? '' : renderText(pair.wxml, page.data);
      pages.push({
        file: pair.wxml,
        text,
        absenceWords: firstScreenAbsenceWordsIn(text),
        loadingWords: firstScreenLoadingWordsIn(text)
      });
    }
  } finally {
    harness.restore();
  }
  return {
    pages,
    hits: pages.filter((page) => page.absenceWords.length > 0),
    loadingPages: pages.filter((page) => page.loadingWords.length > 0),
    // ★ 「渲染出空文本」= 渲染器坏掉、或页面真的什么都没渲染。两者都该红：
    //   前者是工具坏了，后者说明这页在首屏是一张白纸（那本身就是一个缺陷）。
    emptyRenders: pages.filter((page) => page.text.length === 0)
  };
}

/** 去掉显式豁免之后剩下的命中 —— 才是真违规。 */
function unexemptedFirstScreenHits(scan) {
  return scan.hits.filter((page) => !EXEMPT_FIRST_SCREEN_PAGES.has(page.file));
}

/**
 * 首屏**允许整页渲染为空**的页面 —— 显式枚举 + 理由（目前 1 个）。
 *
 * ★ 这一类和「空态词」是**两件不同的事**，所以单列一张表，不要混进豁免清单：
 *   - 空态词 = **假陈述**（「这里没有东西」），T50 要消灭的就是它；
 *   - 整页空白 = **什么都没说**（连「正在加载」都没有）。它不撒谎，但用户看到白屏。
 *
 * ★ 为什么必须显式枚举而不是「允许有空渲染」：`firstScreenCriterionHolds` 的第 1 层
 *   要求「每个页面都必须渲染出非空文本」，那一层是判据本体**不空过**的支点
 *   （渲染器坏掉时它先红）。一旦放宽成「允许有空渲染」，这个支点就没了。
 *   枚举 + 逐项一致，等于把这个支点换成**非空的期望值**：新增一个空白页会红，
 *   修好一个却忘了删登记也会红。
 */
const FIRST_SCREEN_BLANK_ALLOWED = new Map([
  // ★ T50 收尾：**已清空** —— `pages/checkout/checkout.wxml` 修好了，不再有首屏整页空白的页面。
  //
  //   清空前这里登记过一条：
  //     'pages/checkout/checkout.wxml' —— 整页被 `<view wx:if="{{scooter}}" class="page">`
  //     包住，而 `scooter` 来自 `onLoad` 的网络请求、初值为 `null`，所以首屏整页空白。
  //   它**不是**「假陈述」（没有任何空态词），是另一类问题（首屏什么都没告诉用户），
  //   所以当时单列这张表、没有混进豁免清单。T50 收尾按「显示状态补全」把它修掉了：
  //   `checkout.wxml` 现在有 加载中 / 失败占位+重试 / 内容 三支，首屏渲染「正在加载商品信息…」。
  //
  // ★ 这张表**清空之后判据本体照样不空过**（实测，见「负向自测」用例）：
  //   判据本体的那一层是 `blankFlags === blankAllowed`（集合**逐项一致**），不是「集合非空」。
  //   空表给出的期望值是 `''`，而渲染器坏掉时 `blankFlags` 是「34 个文件拼起来」——不相等 → 红。
  //   另外「删登记但没修 checkout」这种错法会让判据本体变成恒 `false` 函数，
  //   而这件事会被负向自测里那条 `firstScreenCriterionHolds(healthy) === true` 前置断言抓住。
]);

/**
 * 首屏判据本体**整体**是否成立 —— 四层，**刻意做成不空过**：
 * 1. 每个页面都必须渲染出**非空**文本（渲染器坏掉时这一层先红 —— 这是本节的
 *    「不空过」设计，比第 2 节第 662 条更进一步，那里第一层确实是空过的）；
 * 2. 空渲染的页面集合必须与 `FIRST_SCREEN_BLANK_ALLOWED` **逐项一致**；
 * 3. 去掉显式豁免后没有命中；
 * 4. 实际命中的页面集合与豁免清单**逐项一致**（僵尸豁免、未登记标红都红）。
 *
 * @param {object} scan `firstScreenScan` 的结果。
 * @returns {boolean} 是否成立。
 */
function firstScreenCriterionHolds(scan) {
  const flagged = scan.hits.map((page) => page.file).sort().join('|');
  const exempt = [...EXEMPT_FIRST_SCREEN_PAGES.keys()].sort().join('|');
  const blankFlags = scan.emptyRenders.map((page) => page.file).sort().join('|');
  const blankAllowed = [...FIRST_SCREEN_BLANK_ALLOWED.keys()].sort().join('|');
  return blankFlags === blankAllowed
    && unexemptedFirstScreenHits(scan).length === 0
    && flagged === exempt;
}

/**
 * 首屏判据的**显式豁免**清单 —— 目前**为空**。
 *
 * ★ 空不是「没写」，而是**有意的结论**：T50 实测全仓 34 个页面在首屏只有 2 处命中，
 *   而那 2 处都是**真缺陷**（`merchant/products.wxml:63`、`profile.wxml:82`），
 *   已在 T50 第三步修掉。所以现在没有「必须出现空态词」的页面需要豁免。
 *
 * ★ 保留这个空 Map 而不是删掉它，有两个作用：
 *   1. 判据本体第 3 层拿它当**非空期望值**（`flagged === exempt`）；
 *   2. 将来真出现必须豁免的页面时，**必须显式登记 + 配一条行为验证**，
 *      而不是放宽判据 —— 这正是第 2 节 `EXEMPT_ABSENCE_BLOCKS` 的既有纪律。
 *
 * ★ 豁免一条的唯一正当理由：该页在首屏**确实**应该显示这句话（例如它断言的是
 *   一个**本地常量**而不是网络数据）。届时请连同那条行为用例一起写在这里。
 */
const EXEMPT_FIRST_SCREEN_PAGES = new Map();

test('首屏行为判据：任何页面在「请求发出之前」都不得渲染空态文案', () => {
  const scan = firstScreenScan();
  const summary = scan.hits
    .map((page) => `  ${page.file}\n    命中：${page.absenceWords.join(' / ')}\n    渲染：${page.text}`)
    .join('\n');

  // 第 1 层：渲染器必须真的渲染出东西（这一层让判据本体不空过）。
  // ★ `FIRST_SCREEN_BLANK_ALLOWED` 里登记的页面是**显式**例外，且必须逐项一致 ——
  //   新增一个首屏空白的页面会在这里红，而不是悄悄滑过去。
  assert.deepEqual(
    scan.emptyRenders.filter((page) => !FIRST_SCREEN_BLANK_ALLOWED.has(page.file)).map((page) => page.file),
    [],
    '每个页面都应渲染出非空文本；渲染出空文本说明渲染器坏了、或这页在首屏是一张白纸'
  );
  assert.deepEqual(
    scan.emptyRenders.map((page) => page.file).sort(),
    [...FIRST_SCREEN_BLANK_ALLOWED.keys()].sort(),
    '「首屏整页空白」的页面必须与登记表逐项一致（新增空白页要登记，修好后要删登记）'
  );

  // 第 2 层：去掉显式豁免后，不得有任何命中。
  assert.deepEqual(
    unexemptedFirstScreenHits(scan).map((page) => page.file),
    [],
    `有 ${unexemptedFirstScreenHits(scan).length} 个页面在「请求发出之前」就渲染出了空态文案 —— `
      + `那一刻用户还没等到任何答复，这些句子是关于「这里没有东西」的假陈述：\n${summary}`
  );

  // 第 3 层：命中集合与豁免清单逐项一致。
  assert.deepEqual(
    scan.hits.map((page) => page.file).sort(),
    [...EXEMPT_FIRST_SCREEN_PAGES.keys()].sort(),
    '豁免清单必须与实际命中的页面逐项一致（不能有僵尸豁免，也不能有未登记的命中）'
  );

  assert.equal(scan.pages.length, 34, '前置条件：应扫描到 34 个页面（实测值，变更时请同步理由）');
});

test('正向控制：首屏必须能数出 ≥10 个页面在渲染加载态文案（防空过）', () => {
  const scan = firstScreenScan();
  const found = scan.loadingPages.map((page) => page.file);
  assert.ok(
    scan.loadingPages.length >= FIRST_SCREEN_LOADING_PAGE_MIN,
    `首屏应至少数出 ${FIRST_SCREEN_LOADING_PAGE_MIN} 个页面在渲染加载态文案，实际 ${scan.loadingPages.length} 个`
      + `（命中页面：${found.join(', ')}）`
  );
  // 控制点必须点名几处**确定**有加载态分支的页面，否则「≥10」可能被别的东西凑数满足。
  for (const expected of ['pages/merchant/index.wxml', 'pages/orders/orders.wxml', 'pages/notifications/notifications.wxml']) {
    assert.ok(found.includes(expected), `正向控制里应包含 ${expected}（首屏必然处于加载态）`);
  }
});

/**
 * 判据自测用的人造页面：**同一段 wxml、同一份数据形状，只改 `loading` 一个字段**。
 *
 * 这样就把「判据到底在测什么」钉死了：它测的不是「有没有空态块」，而是
 * **「请求还没答复时，空态块会不会渲染出来」**。
 */
const FIRST_SCREEN_SAMPLE = [
  '<view class="page">',
  '  <view wx:if="{{block.loading}}" class="empty card"><view class="muted">正在加载…</view></view>',
  '  <view wx:elif="{{!block.data.length && !block.error}}" class="empty card"><view class="muted">暂无记录</view></view>',
  '</view>'
].join('\n');

test('判据自测：人造页面上「未答复」必须命中，加载中必须不命中', () => {
  // ① 真实初值形态（`initialListBlock()`：`loading: true`）→ 只渲染加载态，0 命中。
  const pending = renderTextFromSource(FIRST_SCREEN_SAMPLE, {
    block: { loading: true, error: '', data: [] }
  });
  assert.ok(pending.includes('正在加载'), `正向控制：加载态必须渲染，实际：${pending}`);
  assert.deepEqual(
    firstScreenAbsenceWordsIn(pending),
    [],
    `「请求发出之前」不得命中空态词，实际命中：${firstScreenAbsenceWordsIn(pending).join('/')}｜渲染：${pending}`
  );

  // ② 把 `loading` 拿掉（= T50 要抓的那种写法）→ 必须命中，且报出的渲染原文含「暂无记录」。
  //    ★ 这一格钉住的是：判据**确实**能发现「漏了 loading 守卫」这个类。
  const leaked = renderTextFromSource(FIRST_SCREEN_SAMPLE, {
    block: { loading: false, error: '', data: [] }
  });
  const hit = firstScreenAbsenceWordsIn(leaked);
  // ★ 两个词同时命中是**设计如此**：「暂无记录」里既含「暂无」也含「无记录」。
  //   词表是**探测器**（宁可多报、由人看渲染原文），不是互斥的分类体系 ——
  //   所以命中要连同渲染原文一起报出来。
  assert.deepEqual(hit, ['暂无', '无记录'], `拿掉 loading 守卫后必须命中，实际命中：${hit.join('/')}`);
  assert.ok(hit.includes('暂无'), `命中里必须含「暂无」，实际：${hit.join('/')}`);
  assert.ok(leaked.includes('暂无记录'), `报出的渲染原文应包含「暂无记录」，实际：${leaked}`);

  // ③ 失败形态（`error` 非空、数据保留）→ 空态块被 error 守卫拦住，0 命中。
  const failed = renderTextFromSource(FIRST_SCREEN_SAMPLE, {
    block: { loading: false, error: '加载失败，请重试', data: [] }
  });
  assert.deepEqual(
    firstScreenAbsenceWordsIn(failed),
    [],
    `有失败标志时必须由它分流，不得落空态，实际：${failed}`
  );
});

test('负向自测：渲染器返回空串时，判据本体与正向控制都必须红', () => {
  const healthy = firstScreenScan();
  const broken = firstScreenScan({ brokenRenderer: true });

  // 前置：健康扫描器确实有东西可数（与「当前这棵树是否干净」无关）。
  assert.equal(healthy.pages.length, 34, '前置条件：健康扫描器应扫到 34 个页面');
  assert.ok(
    healthy.loadingPages.length >= FIRST_SCREEN_LOADING_PAGE_MIN,
    '前置条件：健康扫描器应能数出 ≥10 个加载态页面'
  );
  // ★ 这一条是判据本体自己的「正向控制」：它证明 `firstScreenCriterionHolds` 不是一个
  //   恒 `false` 的函数。否则下面那句「坏渲染器时判据本体必须红」会**空过**。
  //   （它同时也会在「代码真有首屏缺陷」时红 —— 那不是误报，是真的有话要说。）
  assert.equal(
    firstScreenCriterionHolds(healthy),
    true,
    '前置条件：健康渲染器下判据本体必须成立（否则「坏渲染器时必红」这条断言本身会空过）'
  );

  // ★ 正向控制会红 —— 这就是它存在的理由。
  assert.equal(broken.loadingPages.length, 0, '渲染器坏掉时它数出的加载态页面必然是 0 个');
  assert.ok(
    broken.loadingPages.length < FIRST_SCREEN_LOADING_PAGE_MIN,
    '渲染器坏掉时正向控制必须红（数不出 ≥10 个）'
  );

  // ★★ 「命中集合为空」这一层**必然空过** —— 渲染器返回空串时命中当然是空的。
  //    这是 `=== 0` 形态负向断言的通病，与第 662 条实测的结论一致。
  assert.deepEqual(broken.hits, [], '渲染器坏掉时「命中」自然是空集 —— 这一层确实还在空过');
  assert.deepEqual(unexemptedFirstScreenHits(broken), [], '去掉豁免后同样是空集');
  assert.equal(broken.emptyRenders.length, 34, '渲染器坏掉时 34 个页面全部渲染成空串');

  // ★★★ 但判据本体**整体不空过** —— 这是本节相对第 662 条的加固：
  //    判据本体的**第 1 / 第 2 层**（「每个页面都必须渲染出非空文本」+「空渲染集合
  //    必须与登记表逐项一致」）给判据**非空的期望值**，于是渲染器坏掉时先红在那里。
  assert.equal(
    firstScreenCriterionHolds(broken),
    false,
    '★ 判据本体整体必须红（第 1 / 2 层给出非空期望值，不再空过）'
  );
});

// ---------------------------------------------------------------------------
// 第 5 节：checkout 商品块的三态（T50 收尾）
// ---------------------------------------------------------------------------
//
// 改造前这一块**一支状态都没有**：整个页面的根节点带着 `wx:if="{{scooter}}"`，
// 而 `scooter` 的初值是 `null` —— 于是
//   ① 首屏那一次请求还没回来时**整页空白**（连一句「正在加载」都没有）；
//   ② 失败时 `scooter` 永远是 `null` → **永久空白**，而 catch 只弹一个会消失的
//      toast、**没有任何常驻错误态与重试入口**。
// ② 比我们修过的那批「假陈述」更糟：那些至少说了句错话，这个是**什么都不说且无法恢复**。
//
// 这一节把三态钉住，并把「搬移没改租赁行为」用**端到端**的方式钉住：
// 证据 5 = 重试不得重跑 `onLoad`（`payToken` 逐字不变）；
// 证据 6 = 租赁字段逐字段等于**搬移前**（`HEAD` 版）的实测值。

/**
 * 一个 **RENT** 商品载荷。
 *
 * ★ 刻意带 `listingType: 'RENT'` + 完整 `rentalPlan`，并且**库存 > 0**：
 * 这样 `isRental` / `rentalPlan` / `rentalUnits` / `rentalUnitLabel` / `stockNote`
 * 五个字段全都会被真正算出来并写进 `data`，`stockNote` 还会走 `''` 那一支 ——
 * 搬移只要碰坏了租赁分支，这里就会红。
 *
 * `priceInCents` 与 `effectivePriceInCents` 都设成 319900：与 `checkout.js` 注释里
 * 点名的那个「买断参考价 3199」一致，租赁展示必须走 `priceText` 而不是 `price`。
 */
const RENT_PRODUCT = {
  id: 'prod_rent_001',
  name: '校园通勤电单车（租赁）',
  description: '按天计费的校园通勤车',
  listingType: 'RENT',
  priceInCents: 319900,
  effectivePriceInCents: 319900,
  stock: 6,
  availableStock: 6,
  rentalPlan: { unit: 'DAY', unitPriceInCents: 1500, minUnits: 1, maxUnits: 7, depositInCents: 9900 }
};

/** 只对 `/api/products/...` 走 `mode` 指定的成败，其余请求一律成功且返回空列表。 */
function productApiHandler(mode) {
  return (requestPath) => {
    if (requestPath.startsWith('/api/products/')) {
      if (mode.current === 'fail') return Promise.reject(NETWORK_FAILURE);
      return Promise.resolve({ data: RENT_PRODUCT });
    }
    return Promise.resolve({ data: [] });
  };
}

test('checkout：首屏（请求未答复）不得整页空白，必须渲染加载态', () => {
  const harness = createHarness();
  try {
    const page = harness.loadPage('pages/checkout/checkout.js');
    // ★ 刻意**不调** `onLoad` / `onShow`：这就是「请求发出之前」那一刻。
    assert.equal(page.data.scooter, null, '前置条件：首屏还没有商品');
    assert.equal(page.data.productLoaded, false, '前置条件：还没得到答复');
    assert.equal(page.data.productError, '', '前置条件：还没失败');

    const rendered = renderText('pages/checkout/checkout.wxml', page.data);
    assert.ok(rendered.length > 0, '★ 首屏不得整页空白（改造前这里渲染出的是空串）');
    assert.ok(
      rendered.includes('正在加载商品信息'),
      `★ 首屏必须有一句「正在加载」——改造前连这句话都没有，用户看到的是一张白纸。实际渲染：${rendered}`
    );
    assert.equal(
      rendered.includes('商品加载失败'),
      false,
      `还没失败就不该说失败，实际渲染：${rendered}`
    );
    assert.equal(
      rendered.includes('提交并支付'),
      false,
      `★ 首屏不得同时把正文也渲染出来（那是「还没答复就当作有数据」的另一面），实际渲染：${rendered}`
    );
  } finally {
    harness.restore();
  }
});

test('checkout：失败 → 常驻错误占位 + 可重试，不靠会消失的 toast', async () => {
  const harness = createHarness();
  try {
    const mode = { current: 'fail' };
    harness.setApiHandler(productApiHandler(mode));
    const page = harness.loadPage('pages/checkout/checkout.js');
    page.onLoad({ id: 'prod_rent_001' });
    await settle();
    await settle();

    assert.ok(page.data.productError, '★ 失败必须落成**常驻**的错误态，而不是只有一个 toast');
    assert.equal(page.data.productLoaded, true, '★ 失败也算「得到了答复」');
    assert.equal(page.data.scooter, null, '前置条件：这次没有商品');
    assert.equal(
      harness.getToasts().length,
      0,
      '★ 失败不得只靠会消失的 toast 承载（T49 对 notifications / store 的同一纪律）'
    );

    const rendered = renderText('pages/checkout/checkout.wxml', page.data);
    assert.ok(
      rendered.includes('商品加载失败'),
      `★ 失败必须**可见**，实际渲染：${rendered}`
    );
    assert.ok(rendered.includes('重试'), `★ 失败必须**可重试**，实际渲染：${rendered}`);
    assert.equal(
      rendered.includes('正在加载商品信息'),
      false,
      `已经答复（失败）了就不该还在说「正在加载」，实际渲染：${rendered}`
    );

    // 重试入口必须真的存在，且必须走 `loadProduct()`。
    assert.equal(typeof page.retryProduct, 'function', 'wxml 上绑定的重试入口必须存在');
    // ★ 不能用 `page.retryProduct.toString()` 查源码：harness 把方法 `.bind(instance)` 过，
    //   绑定函数的 `toString()` 只会返回 `function () { [native code] }`（我第一版就是这么
    //   写错的 —— 那条断言恒假）。所以查**文件原文**里 `retryProduct` 的方法体。
    const retryBody = fs
      .readFileSync(path.join(miniprogramDirectory, 'pages', 'checkout', 'checkout.js'), 'utf8')
      .match(/retryProduct\(\)\s*\{([\s\S]*?)\n  \},/);
    assert.ok(retryBody, '应能从 checkout.js 原文里定位到 `retryProduct()` 的方法体');
    assert.ok(
      retryBody[1].includes('this.loadProduct()'),
      '★ `retryProduct()` 必须调 `loadProduct()` —— 调 `onLoad()` 会重新生成 `payToken`'
    );
    assert.equal(
      retryBody[1].includes('this.onLoad'),
      false,
      '★ `retryProduct()` 不得调 `onLoad()`（那是提交路径上的东西）'
    );
  } finally {
    harness.restore();
  }
});

test('checkout：失败 → 重试 → 成功后 payToken 逐字不变，且租赁字段与搬移前逐字段相同', async () => {
  const harness = createHarness();
  try {
    const mode = { current: 'fail' };
    harness.setApiHandler(productApiHandler(mode));
    const page = harness.loadPage('pages/checkout/checkout.js');
    page.onLoad({ id: 'prod_rent_001' });
    await settle();
    await settle();

    assert.ok(page.data.productError, '前置条件：第一次加载失败');
    const payTokenBefore = page.data.payToken;
    assert.ok(payTokenBefore, '前置条件：`onLoad` 已经生成了 `payToken`');

    // ★ 证据 5：失败 → 重试 → 成功后，`payToken` 必须与首次进入时**逐字相同**。
    //   这条直接钉死「重试触犯提交路径」这个风险：只要 `retryProduct()` 误调 `onLoad()`，
    //   `payToken` 就会被重新生成（时间戳 + 随机串），这里立刻红。
    mode.current = 'ok';
    await page.retryProduct();
    await settle();
    await settle();

    assert.equal(page.data.productError, '', '重试成功后错误态必须清掉');
    assert.equal(page.data.productLoaded, true);
    assert.equal(
      page.data.payToken,
      payTokenBefore,
      '★ 重试不得重新生成 `payToken`（它必须每次进页面只生成一次）'
    );

    // ★ 证据 6：租赁字段逐字段等于**搬移前**（`HEAD` 版 `checkout.js`）的实测值。
    //   期望值取自 HEAD 版跑同一个 RENT 载荷的实测输出（A/B 见 T50 报告），
    //   不是「看起来对」的值；结构性关系（`rentalUnits === plan.minUnits` 等）
    //   同时断言一遍，这样即使载荷换了，语义错位也会被抓住。
    assert.equal(page.data.isRental, true, 'RENT 商品必须判为租赁');
    assert.deepEqual(
      page.data.rentalPlan,
      RENT_PRODUCT.rentalPlan,
      '归一化后的 rentalPlan 必须与载荷一致（readRentalPlan 的产物）'
    );
    assert.equal(page.data.rentalUnits, RENT_PRODUCT.rentalPlan.minUnits, '租赁期数取 minUnits');
    assert.equal(page.data.rentalUnitLabel, '天', 'DAY 必须映射成「天」');
    assert.equal(page.data.quantity, 1, '租赁商品数量固定为 1');
    assert.equal(page.data.scooter.sellableStock, 6);
    assert.equal(page.data.scooter.stockNote, '', '有库存时 stockNote 必须是空串');
    assert.equal(page.data.scooter.price, 3199, '买断参考价（分 → 元）');
    assert.equal(page.data.scooter.originalPrice, 0, '没有促销时 originalPrice 为 0');
    assert.equal(page.data.scooter.promoText, '');
    assert.equal(page.data.scooter.subtitle, RENT_PRODUCT.description);
    assert.equal(page.data.scooter.color, '#eaf0ff');
    assert.equal(page.data.scooter.icon, '车');
    // ★ 租赁展示必须走**展示层映射**（`toProductCard`），不是买断参考价：
    //   改造前直接把 `scooter.price`（3199 元）当「价格」渲染，正是 T37 修掉的同类问题。
    assert.equal(
      page.data.scooter.priceText,
      '¥15/天',
      '★ 租赁价格必须来自展示层映射（¥15/天 = 1500 分/天），而不是买断参考价 ¥3199'
    );
    assert.equal(
      page.data.scooter.price,
      3199,
      '判据自测：`price` 字段确实是买断参考价 3199 —— 所以 priceText 不可能是它'
    );
    assert.equal(
      page.data.maxQuantity,
      5,
      '上限：配置缺失 → 兜底 5；库存 6 → min(6, 5) = 5'
    );

    // 内容必须真的渲染出来了（三态里的第三支）。
    // ★ 用「提交并支付」而不是「购买数量」：后者挂在 `wx:if="{{!scooter.stockNote && !isRental}}"`
    //   上，**RENT 商品本来就不渲染它** —— 我第一版拿它当「正文渲染出来了」的证据，是错的。
    const rendered = renderText('pages/checkout/checkout.wxml', page.data);
    assert.ok(rendered.includes('提交并支付'), `成功后必须渲染正文，实际渲染：${rendered}`);
    assert.ok(rendered.includes('租期选择'), `租赁商品必须渲染租期选择，实际渲染：${rendered}`);
    assert.equal(rendered.includes('正在加载商品信息'), false);
    assert.equal(rendered.includes('商品加载失败'), false);
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// 第 6 节：三态开关 —— 加载失败不得被渲染成「确定的用户状态」（T52）
// ---------------------------------------------------------------------------
//
// ## 这一节钉的是哪一类缺陷
//
// T51 勘察把全仓「catch 里只有 toast、没有常驻错误态」的 51 条按语义分了两类：
// **动作类 49 条**（toast 就是正确反馈，不动）与 **加载类 1 条**（`edit-order.js:23`，
// 失败后必然 `navigateBack` 走掉）。**真正要修的是另一批** ——
// 「**加载失败被渲染成「确定的用户状态」**」。T52 修的就是这批，共 3 处：
//
//   `detail.loadRestockState`       失败写 `restockSubscribed: false`   → 渲染「到货提醒我」
//   `detail.loadFavoriteState`      失败写 `favorited: false`           → 渲染「☆ 收藏」
//   `profile.loadOrderMessageState` 失败写 `orderMessageSubscribed: false`
//                                                                  → 渲染「开启订单微信提醒」
//
// ## 伤害到底是什么（★ 我在这里纠正过一次自己的推论，纠正过程保留在下面）
//
// 我最初的说法是「用户据此做**反操作**：`toggle*` 是取反，会在『其实已收藏』时
// 把收藏**取消**掉」。**这个说法是错的**，写这一节时逐行推了一遍才发现：
//
//   失败落的值是 `false`，渲染出的文案也是「未 X」—— **看到的与取反的是一致的**。
//   用户点一下 → `!false === true` → POST `favorited: true` → 服务端本来就是 true
//   → **幂等**，不会取消任何东西。三处都是这个形状（`restockSubscribed` /
//   `orderMessageSubscribed` 同理）。
//
// 真正的伤害是**更普遍的那一条**：
// **界面在向用户报告一个关于他自己的、我们并不知道的事实。**
// 一个已经收藏了这辆车的用户看到「☆ 收藏」，会以为自己的收藏丢了 / 从没成功过；
// 一个已经开着提醒的用户看到「开启订单微信提醒」，会以为提醒被关掉了而反复去开。
// 这是本仓 T37 / T49 以来一直在消灭的同一类错误（「失败落空态」「失败清列表」），
// 只是位置换到了「用户自己的开关」上。
//
// ★ 但「不会反操作」是**巧合**，不是设计：它成立的前提是「初值、失败值、文案」
//   三者恰好都取 `false`。一旦有人把某处的失败值改成 `true`，或改成「保留上次值」
//   而忘了改渲染层，同一段代码立刻变成**真的反操作**（看到「☆ 收藏」→ 取反得
//   `false` → 把已收藏的**取消**掉）。所以修法的价值不只是修掉当前那句错话，
//   更是**把这个巧合拿掉**：现在渲染层根本不读那个布尔值（只读 `*Loaded` / `*Error`），
//   失败值改成什么都不影响用户看到什么。
//
// ## 修法（三态，与 `ordersLoaded` 同一范式）
//
//   `*Loaded === false`            → 还没问到（请求尚未答复）
//   `*Loaded === true && *Error`   → 问失败了（文案非空 → 中性态 + 重试入口）
//   `*Loaded === true && !*Error`  → 服务端明确答复，`favorited` / `restockSubscribed` 可信
//
// 成功与失败**都**置 `*Loaded = true`（它区分的是「还没取到」与「取到了」，
// 不是「成功」与「失败」）；失败**只**写 `*Error`，**不写**那个布尔值、
// 也**不**清掉上一次的值 —— 与 `loadState.rejectBlock` 的「失败不清空数据」同一条纪律。
//
// 渲染层改成**纯字段嵌套三元**。不能用方法调用（我第一版想写 `favoritedText()`）：
// `evaluateExpression` 把表达式里的每个标识符当作 `new Function(...identifiers)` 的形参，
// `resolvePath` 只按 `.` 分段推进 —— **不支持 `?.[]`、不支持方法调用**。
//
// 未知态下点击按钮的语义变成「**重新获取状态**」（`toggle*` 顶部提前 `return`），
// 而不是盲取反 —— 这样重试入口是**真的**、且不需要额外加一个按钮。
//
// ## ★ 判据的**语义限定词**（必须写在这里，不能只写在 `loadMerchantBadge()` 的注释里）
//
// 本节的判据是：**失败时不得把「我们没问到」渲染成「一句关于用户的确定状态」**。
// 这句话里的限定词是「**一句**」与「**关于用户的确定状态**」—— 判据**不是**
// 「失败时不得有任何用户可见的默认值」。
//
// ★ 按**字面机械执行**，下面第四处（`merchantBadge`）**确实是第 4 个命中**；
//   把它排除靠的是这个限定词，**不是**「它落在判据的字面之外」。
//   限定词必须与判据写在一起 —— 否则下一个人按字面执行会得出相反的结论。
//
// ## 不修的第四处：`profile.loadMerchantBadge`
//
// 它失败时也写 `merchantBadge: false`。**限定词**把它排除，靠的是三条**硬约束**：
//
// 1. **没有第二处相互矛盾的陈述** —— 失败时红点元素不出现，用户读作「没有新提醒」。
//    ★ 如实说清：那**仍然是**一个我们并不知道的事实，只是它是**约定俗成的 UI
//      惯用语**（「没红点 = 没新提醒」），**弱得多**，而且没有第二处地方同时把
//      「未读」说死。所以准确表述是「**弱得多、且没有第二处相互矛盾的隐式陈述**」，
//      **不是**「它不是一个断言」—— 后者是我最初的写法，**措辞过头了**
//      （T52 独立验证指出，我接受）。
// 2. **方向保守**：默认值 `false` = **漏一次提醒**；而那三处是**激进**方向 =
//    假陈述（用户据此**相信一个关于自己的错误事实**）。
// 3. **不是状态的唯一载体**：点进「商家入驻 / 商家工作台」照样能看到真实状态；
//    而收藏 / 提醒开关在页面上**没有第二处显示**。
// 4. 红点只有「显示 / 不显示」两态，**没有第三态可表达**；为它加一个「状态未知」
//    占位，等于每次网络抖动都在个人中心菜单上挂一条错误提示 —— 那是噪音，不是信息。
//
// ★ 一条支持这个限定词的**一致性证据**（独立验证者提供）：本仓对「**一句话**形式的
//   空态」是当假陈述处理的 —— `profile.wxml:87` 的「暂无业务提醒」被
//   `notificationsLoaded` + `!notifications.length` + `!notificationsError` 三重守卫。
//   **句子被守、点不被守** —— 这条线在本仓是**一致的**，不是我们临时为它开的口子。
//
// 四条理由与残留风险同时写在 `profile.js` 的 `loadMerchantBadge()` 上方（T49 豁免同一模式）。
//
// ## 这一节覆盖什么 / 覆盖不到什么
//
// 覆盖：三处开关在「**问失败**」「**先成功再失败**」「**还没问到**」三种时机下的
//      **渲染文案**（不是状态字段），以及点击后的**真实行为**（重取状态 vs 取反）。
//
// ★ 头注修正（T52 独立验证发现）：本节原先在「覆盖不到」里写着
//   「① 「**还没问到**」那一瞬 —— 归第 4 节的首屏判据」。**那一句是假事实**：
//   第 4 节是**空态词词表**判据（`暂无 / 已售罄 / 不存在 / 未找到 / 没有匹配 /
//   没有符合 / 还没 / 这个筛选下 / 未通过 / 已下架 / 无记录`），**看不见**
//   `☆ 收藏` / `到货提醒我` / `开启订单微信提醒` 这三句确定态文案 —— 三句里
//   一个词都不在词表内。实测：只砍掉 wxml 里 `!*Loaded` 那一支（失败路径保持
//   正确、表达式仍平衡）→ 全量 **41/41/0 + 295/295/0 全绿**，
//   也就是说「**只坏首屏、不坏失败路径**」的回退当时**无人能抓**。
//   现在补了 `#42` 把这一瞬真正覆盖掉（不再「归」任何别处）。
//
// 覆盖不到：
//   ① `merchantBadge`（按上面的**语义限定词** + 四条理由排除，不是「判据之外」）；
//   ② 视觉层：`.unknown` 的虚线灰样式只能做**源码存在性**断言，
//      `renderText` 只产文本、不产 CSS，所以「看起来是否真的区分得开」本文件答不了。

/** 三处开关的**确定态**文案（逐字取自修复前的 wxml，不是「看起来对」的改写）。 */
const CERTAIN_SWITCH_TEXTS = [
  '☆ 收藏',
  '★ 已收藏',
  '到货提醒我',
  '已登记到货提醒',
  '开启订单微信提醒',
  '关闭订单微信提醒'
];

/**
 * 渲染结果里出现了哪几句确定态文案（空数组 = 一句都没有）。
 *
 * @param {string} rendered 渲染出的整屏文案。
 * @returns {string[]} 命中的文案。
 */
function certainSwitchTextsIn(rendered) {
  return CERTAIN_SWITCH_TEXTS.filter((text) => rendered.includes(text));
}

/**
 * 详情页用的载荷。
 *
 * ★ `availableStock: 0` 是**刻意**的：`restock-button` 挂在
 *   `wx:if="{{!scooter.sellableStock}}"` 上，有库存时它**根本不渲染** ——
 *   那样「到货提醒按钮不得渲染确定态」这条断言会**空过**（按钮不存在，
 *   `includes` 当然为假）。所以载荷必须让这个按钮真的出现，并且要用
 *   `assert.ok(page.data.scooter)` + `sellableStock === 0` 把前置条件显式钉住。
 */
const SWITCH_PRODUCT = {
  id: 'prod_switch_001',
  name: '校园通勤电单车',
  description: '校内配送 · 可协助上牌',
  listingType: 'SALE',
  priceInCents: 239900,
  effectivePriceInCents: 239900,
  stock: 0,
  availableStock: 0
};

/**
 * 详情页的请求桩。
 *
 * ★ 必须按 **method** 区分：`/api/products/:id/favorite` 既是「读状态」（GET）
 *   又是「切换」（POST），只看路径会把两者混成一个。`state.favorite === 'fail'`
 *   只让 **GET** 失败、POST 仍然成功 —— 否则「状态已知时 toggle 行为逐字不变」
 *   那条断言无法与「状态未知时点击必须重取」区分开。
 *
 * @param {{favorite?: (boolean|string), restock?: (boolean|string)}} state 状态开关；
 *   值 `'fail'` 表示该 GET 失败，`true` / `false` 表示服务端明确答复。
 * @param {Array} [log] 传了就记录每次请求（用于断言发的是 GET 还是 POST、带了什么 data）。
 * @returns {Function} `apiHandler`。
 */
function switchApiHandler(state, log) {
  return (requestPath, options) => {
    const method = (options && options.method) || 'GET';
    if (log) log.push({ requestPath, method, data: options && options.data });
    if (method === 'GET' && requestPath.endsWith('/favorite')) {
      if (state.favorite === 'fail') return Promise.reject(NETWORK_FAILURE);
      return Promise.resolve({ data: { favorited: state.favorite === true } });
    }
    if (method === 'GET' && requestPath.endsWith('/restock-alert')) {
      if (state.restock === 'fail') return Promise.reject(NETWORK_FAILURE);
      return Promise.resolve({ data: { subscribed: state.restock === true } });
    }
    if (requestPath.startsWith('/api/products/')) {
      return Promise.resolve({ data: SWITCH_PRODUCT });
    }
    return Promise.resolve({ data: [] });
  };
}

/**
 * 「**状态端点永不答复**」的桩 —— `#42`（渲染侧）与 `T52(补3)`（点击侧）共用。
 *
 * 为什么不复用 `switchApiHandler`：那一个只会 `resolve` / `reject`，
 * 表达不了「请求已经发出去了、但**还没回来**」这**第三种**时机 ——
 * 而本节要钉的恰恰是它（`*Loaded === false && *Error === ''`）。
 *
 * 商品请求仍然立刻成功（否则 `scooter` 为 `null`，底部按钮行整块不渲染，
 * 断言会**空过**）；三个开关的状态端点挂起。
 *
 * ★ `log` 是**可选**的（T52 补3 新增）：传了就把每次请求记进去，供**点击侧**
 *   断言「发的是 GET 还是 POST」。刻意做成可选 —— `#42` 只关心渲染、不需要
 *   日志，它的调用方一个字都不用改。
 *
 * ★ 为什么连 profile 的 `/api/order-message-subscriptions` 也一起挂起：
 *   「还没问到」在 detail 与 profile 上是**同一种时机**。若这里不挂它，它会落进
 *   下面的 `Promise.resolve({ data: [] })` 兜底 → `orderMessageStateLoaded` 立刻
 *   变成 `true` → profile 那一处的「还没问到」根本造不出来，点击侧断言会**空过**。
 *   对 `#42` 无影响：那条用例在设置本桩**之前**就加载了 profile，且**不调**
 *   `profile.onShow()`，一个请求都不会发。
 *
 * @param {Array} [log] 传了就记录每次请求（`{ requestPath, method, data }`）。
 * @returns {Function} `apiHandler`。
 */
function pendingSwitchApiHandler(log) {
  return (requestPath, options) => {
    const method = (options && options.method) || 'GET';
    if (log) log.push({ requestPath, method, data: options && options.data });
    if (method === 'GET' && (requestPath.endsWith('/favorite')
      || requestPath.endsWith('/restock-alert')
      || requestPath === '/api/order-message-subscriptions')) {
      // 永不 settle：模拟「请求在路上」。
      return new Promise(() => {});
    }
    if (requestPath.startsWith('/api/products/')) {
      return Promise.resolve({ data: SWITCH_PRODUCT });
    }
    return Promise.resolve({ data: [] });
  };
}

/**
 * 个人中心页的请求桩：只关心 `/api/order-message-subscriptions` 的 GET，
 * 其余（`/api/merchants`、`/api/my/identity`、`/api/my/notifications`…）一律成功返回空数组。
 *
 * @param {{subscribed?: (boolean|string)}} state 状态开关。
 * @param {Array} [log] 传了就记录每次请求。
 * @returns {Function} `apiHandler`。
 */
function profileStateApiHandler(state, log) {
  return (requestPath, options) => {
    const method = (options && options.method) || 'GET';
    if (log) log.push({ requestPath, method, data: options && options.data });
    if (requestPath === '/api/order-message-subscriptions' && method === 'GET') {
      if (state.subscribed === 'fail') return Promise.reject(NETWORK_FAILURE);
      return Promise.resolve({ data: { subscribed: state.subscribed === true } });
    }
    return Promise.resolve({ data: [] });
  };
}

/** 人造样本：**修复前**的写法（失败时把「我们没问到」直接渲染成确定态）。 */
const BROKEN_SWITCH_SAMPLE = [
  '<view class="bottom-actions">',
  "  <button class=\"favorite-button\">{{favorited ? '★ 已收藏' : '☆ 收藏'}}</button>",
  "  <button class=\"restock-button\">{{restockSubscribed ? '已登记到货提醒' : '到货提醒我'}}</button>",
  '</view>'
].join('\n');

test('判据自测：修复前的写法必须被这套「确定态文案」判据抓住（否则本节断言是空过的）', () => {
  // 修复前：失败 → `catch` 把 `favorited` / `restockSubscribed` 写成 `false` → 渲染出确定态。
  const broken = renderTextFromSource(BROKEN_SWITCH_SAMPLE, { favorited: false, restockSubscribed: false });
  assert.deepEqual(
    certainSwitchTextsIn(broken),
    ['☆ 收藏', '到货提醒我'],
    `★ 修复前的写法渲染出的正是这两句确定态文案，本判据必须抓住它。实际渲染：${broken}`
  );

  // 反面对照：同一段 wxml 在「服务端明确答复已收藏 / 已登记」时渲染的是另外两句 ——
  // 说明这个判据能区分「确定态」与「另一种确定态」，不是恒真也不是恒假。
  const answered = renderTextFromSource(BROKEN_SWITCH_SAMPLE, { favorited: true, restockSubscribed: true });
  assert.deepEqual(
    certainSwitchTextsIn(answered),
    ['★ 已收藏', '已登记到货提醒'],
    `实际渲染：${answered}`
  );
});

test('detail：收藏 / 到货提醒状态取不到 → 不得渲染确定态，且必须有可见的重试入口', async () => {
  const harness = createHarness();
  try {
    const log = [];
    harness.setApiHandler(switchApiHandler({ favorite: 'fail', restock: 'fail' }, log));
    const page = harness.loadPage('pages/detail/detail.js');
    page.onLoad({ id: SWITCH_PRODUCT.id });
    await settle();
    await settle();
    await settle();

    // ── 前置条件：商品本身取到了、库存为 0，底部两个按钮**真的会渲染**。
    //    不钉住这两条，下面的 `includes(...) === false` 可能只是因为按钮不存在。
    assert.ok(page.data.scooter, '前置条件：商品详情已取到，底部按钮行才会渲染');
    assert.equal(page.data.scooter.sellableStock, 0, '前置条件：无库存，到货提醒按钮才会渲染');
    assert.equal(page.data.loading, false);
    assert.equal(page.data.loadError, '', '前置条件：商品本身是成功的，这次只有两个状态端点失败');

    // ── ① 失败时用户**不会**看到一个确定的用户状态（本节主判据）
    //
    // ★ 这一条**排在三态字段断言之前**是刻意的：它是本节的主判据，
    //   **若它该红，它就会是第一个红的**（否则「回退修复 → 对应断言必红」的
    //   证据链会停在一条旁证上，看不出主判据到底有没有生效）。
    //   ★ 注意它**不保证**在任何变异下都先红：变异 D（只拿掉 `toggle*` 的未知态
    //     分流）**不动渲染路径**，所以它**不该**红 —— 那时先红的是
    //     「点击必须发 GET」那一条。两种情形都对，别把前者读成恒真。
    const rendered = renderText('pages/detail/detail.wxml', page.data);
    assert.deepEqual(
      certainSwitchTextsIn(rendered),
      [],
      `★ 状态取不到时，一句确定态文案都不许出现 —— 界面不得报告一个我们并不知道的用户状态。实际渲染：${rendered}`
    );

    // ── ② 有**可见**的重试入口（中性文案 + 「重试」二字 + 真的能重取）
    assert.ok(rendered.includes('收藏未知'), `★ 收藏按钮必须落到中性态。实际渲染：${rendered}`);
    assert.ok(rendered.includes('提醒未知'), `★ 到货提醒按钮必须落到中性态。实际渲染：${rendered}`);
    assert.ok(rendered.includes('重试'), `★ 必须有可见的重试入口。实际渲染：${rendered}`);
    assert.ok(rendered.includes('收藏未知·重试'), `★ 失败态要写明「重试」（区别于「还没问到」）。实际渲染：${rendered}`);

    // ── 三态字段（支撑证据：说明上面渲染成中性态是因为**状态未知**，不是别的原因）
    assert.equal(page.data.favoriteStateLoaded, true, '失败也算「得到了答复」');
    assert.equal(page.data.restockStateLoaded, true, '失败也算「得到了答复」');
    assert.ok(page.data.favoriteStateError, '★ 失败必须落成**可见**的错误态，而不是只有一个 toast');
    assert.ok(page.data.restockStateError, '★ 失败必须落成**可见**的错误态');

    assert.equal(typeof page.toggleFavorite, 'function', 'wxml 上绑定的入口必须存在');
    assert.equal(typeof page.toggleRestockAlert, 'function', 'wxml 上绑定的入口必须存在');

    // ★ 重试入口必须是**真的**：未知态下点一下，必须**重新发 GET**，而不是盲取反发 POST。
    log.length = 0;
    await page.toggleFavorite();
    await settle();
    const favoriteCalls = log.filter((call) => call.requestPath.endsWith('/favorite'));
    assert.equal(favoriteCalls.length, 1, '点一下必须只发一次请求');
    assert.equal(
      favoriteCalls[0].method,
      'GET',
      '★ 状态未知时点击的语义是「重新获取状态」（GET），不得盲取反（POST）'
    );

    log.length = 0;
    await page.toggleRestockAlert();
    await settle();
    const restockCalls = log.filter((call) => call.requestPath.endsWith('/restock-alert'));
    assert.equal(restockCalls.length, 1, '点一下必须只发一次请求');
    assert.equal(restockCalls[0].method, 'GET', '★ 同上');

    // ── ③ 视觉上必须与两种确定态都区分得开（源码级断言：本文件渲染不出 CSS）
    const detailWxml = fs.readFileSync(path.join(miniprogramDirectory, 'pages', 'detail', 'detail.wxml'), 'utf8');
    assert.ok(
      detailWxml.includes("class=\"favorite-button {{(!favoriteStateLoaded || favoriteStateError) ? 'unknown' : (favorited ? 'active' : '')}}\""),
      '★ 收藏按钮的 class 必须在「未知」时走第三支 `unknown`，而不是落进 `active` / 无 class'
    );
    assert.ok(
      detailWxml.includes("class=\"restock-button {{(!restockStateLoaded || restockStateError) ? 'unknown' : ''}}\""),
      '★ 到货提醒按钮同理'
    );
    const detailWxss = fs.readFileSync(path.join(miniprogramDirectory, 'pages', 'detail', 'detail.wxss'), 'utf8');
    assert.ok(detailWxss.includes('.favorite-button.unknown'), '★ 第三态必须有独立样式，否则用户区分不开');
    assert.ok(detailWxss.includes('.restock-button.unknown'), '★ 同上');
  } finally {
    harness.restore();
  }
});

test('detail：成功路径逐字不变 —— 两种确定态与 `toggle*` 的取反行为都与改造前一致', async () => {
  const harness = createHarness();
  try {
    const log = [];
    const state = { favorite: false, restock: false };
    harness.setApiHandler(switchApiHandler(state, log));
    const page = harness.loadPage('pages/detail/detail.js');
    page.onLoad({ id: SWITCH_PRODUCT.id });
    await settle();
    await settle();
    await settle();

    assert.ok(page.data.scooter, '前置条件：商品详情已取到');
    assert.equal(page.data.scooter.sellableStock, 0, '前置条件：到货提醒按钮会渲染');
    assert.equal(page.data.favoriteStateError, '', '成功路径不得落错误态');
    assert.equal(page.data.restockStateError, '', '成功路径不得落错误态');

    // ── 服务端明确答复「未收藏 / 未登记」→ 必须是改造前那两句原话
    const notYet = renderText('pages/detail/detail.wxml', page.data);
    assert.ok(notYet.includes('☆ 收藏'), `★ 答复「未收藏」时必须渲染原话。实际渲染：${notYet}`);
    assert.ok(notYet.includes('到货提醒我'), `★ 答复「未登记」时必须渲染原话。实际渲染：${notYet}`);
    assert.equal(notYet.includes('未知'), false, `★ 已经答复了就不该说「未知」。实际渲染：${notYet}`);

    // ── 服务端明确答复「已收藏 / 已登记」→ 必须是改造前那两句原话
    state.favorite = true;
    state.restock = true;
    await page.loadFavoriteState(SWITCH_PRODUCT.id);
    await page.loadRestockState(SWITCH_PRODUCT.id);
    await settle();
    const done = renderText('pages/detail/detail.wxml', page.data);
    assert.ok(done.includes('★ 已收藏'), `★ 答复「已收藏」时必须渲染原话。实际渲染：${done}`);
    assert.ok(done.includes('已登记到货提醒'), `★ 答复「已登记」时必须渲染原话。实际渲染：${done}`);
    assert.equal(done.includes('未知'), false, `实际渲染：${done}`);

    // ── ③ 状态已知时，`toggleFavorite` 必须仍是**取反 + POST**（既有行为逐字不变）
    log.length = 0;
    page.toggleFavorite();
    await settle();
    await settle();
    const favoriteCalls = log.filter((call) => call.requestPath.endsWith('/favorite'));
    assert.equal(favoriteCalls.length, 1);
    assert.equal(
      favoriteCalls[0].method,
      'POST',
      '★ 状态已知时点击必须走 toggle（POST），不得被改成分流成 GET'
    );
    assert.equal(
      favoriteCalls[0].data.favorited,
      false,
      '★ 原本 `favorited === true` → 取反后 POST `favorited: false`（与改造前逐字一致）'
    );
    assert.equal(page.data.favorited, false, 'POST 成功后本地状态跟着变（与改造前一致）');
    assert.equal(harness.getToasts().length, 1, '成功后照旧弹 toast');
    assert.equal(harness.getToasts()[0].title, '已取消收藏', 'toast 文案逐字不变');

    log.length = 0;
    page.toggleRestockAlert();
    await settle();
    await settle();
    const restockCalls = log.filter((call) => call.requestPath.endsWith('/restock-alert'));
    assert.equal(restockCalls.length, 1);
    assert.equal(restockCalls[0].method, 'POST');
    assert.equal(restockCalls[0].data.subscribed, false, '★ 原本 `restockSubscribed === true` → 取反后 POST false');
    assert.equal(page.data.restockSubscribed, false);
    assert.equal(harness.getToasts().length, 2);
    assert.equal(harness.getToasts()[1].title, '已取消提醒', 'toast 文案逐字不变');
  } finally {
    harness.restore();
  }
});

test('profile：订单提醒状态取不到 → 不得渲染确定态，且必须有可见的重试入口', async () => {
  const harness = createHarness();
  try {
    const log = [];
    const state = { subscribed: 'fail' };
    harness.setApiHandler(profileStateApiHandler(state, log));
    const page = harness.loadPage('pages/profile/profile.js');
    page.onShow();
    await settle();
    await settle();

    // ── ① 失败时用户**不会**看到一个确定的用户状态（本节主判据，刻意排在三态字段之前）
    const rendered = renderText('pages/profile/profile.wxml', page.data);
    assert.equal(
      rendered.includes('开启订单微信提醒'),
      false,
      `★ 取不到状态时**绝不能**渲染「开启订单微信提醒」（那是断言「你没开提醒」）。实际渲染：${rendered}`
    );
    assert.equal(
      rendered.includes('关闭订单微信提醒'),
      false,
      `★ 也不能把上一次的旧值当确定态渲染。实际渲染：${rendered}`
    );

    // ── ② 有**可见**的重试入口
    assert.ok(rendered.includes('订单提醒未知'), `★ 必须落到中性态。实际渲染：${rendered}`);
    assert.ok(rendered.includes('订单提醒未知·重试'), `★ 失败态要写明「重试」。实际渲染：${rendered}`);

    // ── 三态字段（支撑证据）
    assert.equal(page.data.orderMessageStateLoaded, true, '失败也算「得到了答复」');
    assert.ok(page.data.orderMessageStateError, '★ 失败必须落成**可见**的错误态');

    // ★ 重试入口必须是**真的**：未知态下点一下必须重新发 GET，而不是盲取反。
    //   （`toggleOrderMessages` 的「开启」分支要读 `/api/subscribe-templates`，
    //     盲取反会走那条链 —— 所以这里断言**只**发了状态查询这一个请求。）
    log.length = 0;
    await page.toggleOrderMessages();
    await settle();
    const calls = log.filter((call) => call.requestPath === '/api/order-message-subscriptions');
    assert.equal(calls.length, 1, '点一下必须只发一次状态查询');
    assert.equal(calls[0].method, 'GET', '★ 状态未知时点击的语义是「重新获取状态」（GET），不得盲取反（POST）');
    assert.equal(
      log.some((call) => call.requestPath === '/api/subscribe-templates'),
      false,
      '★ 未知态下不得走进「开启提醒」那条链（那会重新弹一次微信授权）'
    );

    // ── ③ 视觉上必须与两种确定态都区分得开（源码级断言：本文件渲染不出 CSS）
    const profileWxml = fs.readFileSync(path.join(miniprogramDirectory, 'pages', 'profile', 'profile.wxml'), 'utf8');
    assert.ok(
      profileWxml.includes("class=\"message-toggle {{(!orderMessageStateLoaded || orderMessageStateError) ? 'unknown' : ''}}\""),
      '★ 按钮的 class 必须在「未知」时走第三支 `unknown`'
    );
    const profileWxss = fs.readFileSync(path.join(miniprogramDirectory, 'pages', 'profile', 'profile.wxss'), 'utf8');
    assert.ok(profileWxss.includes('.message-toggle.unknown'), '★ 第三态必须有独立样式');
  } finally {
    harness.restore();
  }
});

test('profile：成功路径逐字不变 —— 两种确定态与 `toggleOrderMessages` 的行为都与改造前一致', async () => {
  const harness = createHarness();
  try {
    const log = [];
    const state = { subscribed: false };
    harness.setApiHandler(profileStateApiHandler(state, log));
    const page = harness.loadPage('pages/profile/profile.js');
    page.onShow();
    await settle();
    await settle();

    assert.equal(page.data.orderMessageStateError, '', '成功路径不得落错误态');

    // 服务端明确答复「未开启」→ 必须是改造前那句原话
    const off = renderText('pages/profile/profile.wxml', page.data);
    assert.ok(off.includes('开启订单微信提醒'), `★ 答复「未开启」时必须渲染原话。实际渲染：${off}`);
    assert.equal(off.includes('订单提醒未知'), false, `实际渲染：${off}`);

    // 服务端明确答复「已开启」→ 必须是改造前那句原话
    state.subscribed = true;
    await page.loadOrderMessageState();
    await settle();
    const on = renderText('pages/profile/profile.wxml', page.data);
    assert.ok(on.includes('关闭订单微信提醒'), `★ 答复「已开启」时必须渲染原话。实际渲染：${on}`);
    assert.equal(on.includes('订单提醒未知'), false, `实际渲染：${on}`);

    // ★ 状态已知时点击必须仍是**取反 + POST**（走「关闭」那一支，既有行为逐字不变）
    log.length = 0;
    page.toggleOrderMessages();
    await settle();
    await settle();
    const posts = log.filter(
      (call) => call.requestPath === '/api/order-message-subscriptions' && call.method === 'POST'
    );
    assert.equal(posts.length, 1, '状态已知时点击必须走 POST');
    assert.equal(posts[0].data.accepted, false, '★ 原本已开启 → POST `accepted: false`（与改造前逐字一致）');
    assert.equal(page.data.orderMessageSubscribed, false);
    assert.equal(harness.getToasts().length, 1);
    assert.equal(harness.getToasts()[0].title, '已关闭提醒', 'toast 文案逐字不变');
  } finally {
    harness.restore();
  }
});

test('端到端：detail 先成功（已收藏 / 已登记）→ 再刷新失败 → 不得回退成确定态，旧值不被清掉', async () => {
  const harness = createHarness();
  try {
    const state = { favorite: true, restock: true };
    harness.setApiHandler(switchApiHandler(state));
    const page = harness.loadPage('pages/detail/detail.js');
    page.onLoad({ id: SWITCH_PRODUCT.id });
    await settle();
    await settle();
    await settle();

    // ── 第一轮：服务端明确答复「已收藏 / 已登记」
    const before = renderText('pages/detail/detail.wxml', page.data);
    assert.ok(before.includes('★ 已收藏'), `前置条件：第一轮渲染出确定态。实际渲染：${before}`);
    assert.ok(before.includes('已登记到货提醒'), `前置条件：第一轮渲染出确定态。实际渲染：${before}`);

    // ── 第二轮：同两个端点失败（刷新），商品本身仍然成功
    state.favorite = 'fail';
    state.restock = 'fail';
    await page.retryProduct();
    await settle();
    await settle();
    await settle();

    assert.equal(page.data.loadError, '', '前置条件：这一轮只有两个状态端点失败');

    // ── 主判据（刻意排在「旧值不被清掉」之前）：刷新失败后一句确定态文案都不许出现
    const after = renderText('pages/detail/detail.wxml', page.data);
    assert.deepEqual(
      certainSwitchTextsIn(after),
      [],
      `★ 刷新失败后一句确定态文案都不许出现。实际渲染：${after}`
    );
    assert.ok(after.includes('收藏未知·重试'), `★ 必须给中性 + 可重试的呈现。实际渲染：${after}`);
    assert.ok(after.includes('提醒未知·重试'), `★ 必须给中性 + 可重试的呈现。实际渲染：${after}`);

    // ★ 旧值**不得**被清成「未收藏 / 未登记」——失败不清空数据（`rejectBlock` 同一条纪律）
    assert.equal(page.data.favorited, true, '★ 失败不得把上次确认过的 `favorited` 改掉');
    assert.equal(page.data.restockSubscribed, true, '★ 失败不得把上次确认过的 `restockSubscribed` 改掉');

    // ── 第三轮：网络恢复 → 中性态必须能自己走回确定态（重试入口是真的）
    state.favorite = true;
    state.restock = true;
    await page.toggleFavorite();
    await settle();
    await page.toggleRestockAlert();
    await settle();
    const recovered = renderText('pages/detail/detail.wxml', page.data);
    assert.ok(recovered.includes('★ 已收藏'), `★ 重试成功后必须回到确定态。实际渲染：${recovered}`);
    assert.ok(recovered.includes('已登记到货提醒'), `★ 重试成功后必须回到确定态。实际渲染：${recovered}`);
    assert.equal(recovered.includes('未知'), false, `实际渲染：${recovered}`);
  } finally {
    harness.restore();
  }
});

test('端到端：profile 先成功（已开启）→ 再刷新失败 → 不得回退成「开启订单微信提醒」', async () => {
  const harness = createHarness();
  try {
    const state = { subscribed: true };
    harness.setApiHandler(profileStateApiHandler(state));
    const page = harness.loadPage('pages/profile/profile.js');
    page.onShow();
    await settle();
    await settle();

    // ── 第一轮：服务端明确答复「已开启」
    const before = renderText('pages/profile/profile.wxml', page.data);
    assert.ok(before.includes('关闭订单微信提醒'), `前置条件：第一轮渲染出「已开启」。实际渲染：${before}`);

    // ── 第二轮：刷新失败
    state.subscribed = 'fail';
    await page.loadOrderMessageState();
    await settle();

    // ── 主判据（刻意排在「旧值不被清掉」之前）
    const after = renderText('pages/profile/profile.wxml', page.data);
    assert.equal(
      after.includes('开启订单微信提醒'),
      false,
      `★ 刷新失败后**绝不能**渲染「开启订单微信提醒」——那会让一个已经开着提醒的用户以为被关掉了。实际渲染：${after}`
    );
    assert.equal(
      after.includes('关闭订单微信提醒'),
      false,
      `★ 也不能继续把旧值当确定态渲染（旧值只留在 data 里，不进渲染）。实际渲染：${after}`
    );
    assert.ok(after.includes('订单提醒未知·重试'), `★ 必须给中性 + 可重试的呈现。实际渲染：${after}`);

    assert.equal(page.data.orderMessageSubscribed, true, '★ 失败不得把上次确认过的 `orderMessageSubscribed` 改掉');

    // ── 第三轮：网络恢复 → 中性态走回确定态
    state.subscribed = true;
    await page.toggleOrderMessages();
    await settle();
    const recovered = renderText('pages/profile/profile.wxml', page.data);
    assert.ok(recovered.includes('关闭订单微信提醒'), `★ 重试成功后必须回到确定态。实际渲染：${recovered}`);
    assert.equal(recovered.includes('订单提醒未知'), false, `实际渲染：${recovered}`);
  } finally {
    harness.restore();
  }
});

test('「还没问到」那一瞬：三处开关尚未得到答复时不得渲染确定态（第 4 节看不见这三句）', async () => {
  const harness = createHarness();
  try {
    // ── ① profile：**首屏**（刻意**不调** `onShow`，这就是「请求发出之前」那一刻）
    //
    // ★ 这条断言**不是空过的**：`.message-toggle` 挂在 `profile.wxml:88`，
    //   而它的祖先 `.notification-card`（`:60`）**没有** `wx:if` 守卫 ——
    //   所以首屏这一屏**真的会渲染这个按钮**（下面「订单提醒未知」那句就是证据）。
    const profile = harness.loadPage('pages/profile/profile.js');
    assert.equal(profile.data.orderMessageStateLoaded, false, '前置条件：还没得到答复');
    assert.equal(profile.data.orderMessageStateError, '', '前置条件：还没失败');

    const profileText = renderText('pages/profile/profile.wxml', profile.data);
    assert.deepEqual(
      certainSwitchTextsIn(profileText),
      [],
      `★ 首屏那一刻「我们还没问到」，不得渲染任何确定态文案。实际渲染：${profileText}`
    );
    assert.ok(
      profileText.includes('订单提醒未知'),
      `★ 首屏必须落到中性态（这句同时是「按钮真的渲染了」的防空过支点）。实际渲染：${profileText}`
    );

    // ── ② detail：**请求在途**（商品已到、两个状态端点永不答复）
    //
    // ★ 为什么**不**照搬 ① 的「不调 onLoad」：底部按钮行被
    //   `<block wx:if="{{scooter}}">`（`detail.wxml:19`）整块包住，而 `scooter`
    //   初值是 `null` —— 首屏那一屏**两个按钮根本不渲染**，
    //   「不得渲染确定态」在那里会**空过**（`includes` 对一个不存在的按钮恒为假）。
    //
    // ★ 真正可达的「还没问到」是这一段窗口：`loadProduct()` 成功回调里先
    //   `setData({ scooter })`、**再**发两个状态请求 —— 商品已经显示、状态还在路上，
    //   用户在这一刻**看得见这两个按钮**。所以用 `pendingSwitchApiHandler()`
    //   让两个状态端点永不 settle，把这一瞬**稳定地**造出来。
    harness.setApiHandler(pendingSwitchApiHandler());
    const detail = harness.loadPage('pages/detail/detail.js');
    detail.onLoad({ id: SWITCH_PRODUCT.id });
    await settle();
    await settle();
    await settle();

    assert.ok(detail.data.scooter, '前置条件：商品已到，底部按钮行才会渲染');
    assert.equal(detail.data.scooter.sellableStock, 0, '前置条件：无库存，到货提醒按钮才会渲染');
    assert.equal(detail.data.favoriteStateLoaded, false, '前置条件：收藏状态请求还在路上');
    assert.equal(detail.data.restockStateLoaded, false, '前置条件：到货提醒状态请求还在路上');
    assert.equal(detail.data.favoriteStateError, '', '前置条件：还没失败');
    assert.equal(detail.data.restockStateError, '', '前置条件：还没失败');

    const detailText = renderText('pages/detail/detail.wxml', detail.data);
    // ★ 防空过支点：先钉住「按钮行真的渲染了」。「咨询」这个按钮**永远**在
    //   底部按钮行里、且没有 `wx:if` —— 它出现 = 整行出现。
    assert.ok(
      detailText.includes('咨询'),
      `★ 防空过支点：底部按钮行真的渲染了（它在 \`<block wx:if="{{scooter}}">\` 里，商品没到就整块不渲染）。实际渲染：${detailText}`
    );
    assert.deepEqual(
      certainSwitchTextsIn(detailText),
      [],
      `★ 状态请求还在路上时不得渲染任何确定态文案。实际渲染：${detailText}`
    );
    assert.ok(detailText.includes('收藏未知'), `★ 必须落到中性态。实际渲染：${detailText}`);
    assert.ok(detailText.includes('提醒未知'), `★ 必须落到中性态。实际渲染：${detailText}`);
    assert.equal(
      detailText.includes('重试'),
      false,
      `★ 「还没问到」不写「重试」（那是失败态才有的；用户还没失败过，没有可重试的东西）。实际渲染：${detailText}`
    );
  } finally {
    harness.restore();
  }
});

/**
 * T53（M8-P1-03）：足迹页的「清空」与去重说明。
 *
 * 本用例把四件事钉死：
 *  1. **二次确认**：清空不可逆，用户未确认前**一个请求都不发**；
 *  2. **清空后落「正常空态」** —— 不是错误态、不是一直 loading；
 *  3. **重进页面（`onShow`）不回填**；
 *  4. **失败可见 + 可重试**，且那个「重试」重试的是**清空本身**（不是重新加载）。
 *
 * ★ 服务端桩是**有状态**的：`DELETE` 真的把记录删掉、`GET` 反映真实结果。
 *   若桩永远返回同一份列表，「重进不回填」这条断言会**空过** —— 它证明不了任何东西。
 *
 * ★ 文案判据：用户可见文案里**不得出现「200」**。那个 200 是**所有用户共享**的
 *   存储上限（`POST` 分支砍的是 `data.productFootprints` 这个全局数组），
 *   而用户一次最多只看到 20 条。写 200 会让用户以为「我能翻到 200 条」。
 */
test('T53：足迹页清空 —— 取消不发请求、清空后落正常空态、重进不回填、失败可重试', async () => {
  const harness = createHarness();
  try {
    const FOOTPRINTS_WXML = 'pages/footprints/footprints.wxml';
    const sampleRecords = () => [
      {
        id: 'prod_card_service_001', category: 'PHONE_PLAN', name: '校园畅享卡',
        merchantName: '平台自营', effectivePriceInCents: 2900, availableStock: 999
      },
      {
        id: 'prod_ebike_001', category: 'E_BIKE_NEW', name: '轻风 通勤版',
        merchantName: '狮山校园车行', effectivePriceInCents: 239900, availableStock: 8
      }
    ];
    let records = sampleRecords();
    let deleteShouldFail = false;
    // 服务端「真实总数」。默认与列表长度一致；需要验证截断文案时单独调大。
    let serverTotal = null;
    const calls = [];
    harness.setApiHandler((requestPath, options) => {
      const method = (options && options.method) || 'GET';
      calls.push({ path: requestPath, method });
      if (requestPath !== '/api/my/footprints') return Promise.resolve({ data: [] });
      if (method === 'DELETE') {
        if (deleteShouldFail) {
          return Promise.reject(serverError('FOOTPRINT_CLEAR_FAILED', 500, '清空失败，请重试'));
        }
        const removed = records.length;
        records = [];
        return Promise.resolve({ data: { removed } });
      }
      return Promise.resolve({
        data: records.slice(),
        total: serverTotal === null ? records.length : serverTotal
      });
    });
    const deleteCalls = () => calls.filter((call) => call.method === 'DELETE');
    const page = harness.loadPage('pages/footprints/footprints.js');

    // ==================== ① 清空前：条数准确 + 去重说明可见 + 不提 200 ====================
    await page.load();
    assert.equal(page.data.footprintsBlock.data.length, 2, '① 前置：应加载出 2 条足迹');
    const beforeText = renderText(FOOTPRINTS_WXML, page.data);
    assert.ok(
      beforeText.includes('最近浏览的 2 件商品'),
      `① ★ 顶部必须说**用户实际看到的条数**。实际渲染：${beforeText}`
    );
    assert.ok(
      beforeText.includes('重复浏览同一件商品会自动置顶'),
      `① ★ 去重说明必须可见（PRD 验收项）。实际渲染：${beforeText}`
    );
    assert.ok(beforeText.includes('清空足迹'), `① ★ 必须有清空入口。实际渲染：${beforeText}`);
    // ★ 这一条同时是「渲染器真的剥掉了注释」的守卫：wxml 注释里**确实**写了
    //   「200」与「最多显示 20 件」，注释一旦泄漏进渲染结果，下面两条立刻红。
    assert.equal(
      beforeText.includes('200'),
      false,
      `① ★★ 用户可见文案里不得出现「200」（那是全局存储上限，对单个用户不成立）。实际渲染：${beforeText}`
    );
    assert.equal(
      beforeText.includes('最多显示 20 件'),
      false,
      `① ★ 没被截断时不得声称「最多显示 20 件」。实际渲染：${beforeText}`
    );

    // ==================== ② 点「清空」→ 弹确认框，且**未确认前一个请求都不发** ====================
    calls.length = 0;
    page.clearFootprints();
    assert.equal(harness.getModals().length, 1, '② ★ 清空不可逆，必须先弹二次确认');
    assert.equal(harness.getModals().at(-1).title, '清空足迹', '② 确认框标题');
    assert.equal(
      harness.getModals().at(-1).content,
      '清空后无法恢复，将删除你账号下的全部浏览记录。',
      '② ★ 确认框必须说清「不可恢复」与「删的是什么」'
    );
    assert.equal(deleteCalls().length, 0, '② ★★ 用户还没确认，不得发任何 DELETE 请求');

    // ==================== ③ 点「取消」→ 仍然一个请求都不发 ====================
    harness.getModals().at(-1).success({ confirm: false });
    await settle();
    await settle();
    assert.equal(
      deleteCalls().length, 0,
      '③ ★★ 点「取消」不得发请求（这是本交互最容易漏掉的缺陷）'
    );
    assert.equal(page.data.footprintsBlock.data.length, 2, '③ 取消后列表必须原样保留');

    // ==================== ④ 点「确认」→ 真的发 DELETE（且只发一次） ====================
    page.clearFootprints();
    harness.getModals().at(-1).success({ confirm: true });
    await settle();
    await settle();
    assert.equal(deleteCalls().length, 1, '④ ★ 确认后必须发出且只发一次 DELETE');

    // ==================== ⑤ 清空后：**正常空态**（不是错误态、不是一直 loading） ====================
    //
    // ★ 判据顺序是**刻意**的：先断言「用户实际看到的那段文字」，再断言状态字段。
    //   实测（变异 ④「清空后留旧数据」）：若把 `data.length` 排在最前，用例会在那条
    //   **旁证**上就中断，**渲染判据根本没被求值** —— 于是「空态文案真的被判过吗」
    //   拿不到证据。这与 T52 那次「旁证先红」是同一个坑。
    const afterText = renderText(FOOTPRINTS_WXML, page.data);
    assert.ok(
      afterText.includes('暂无浏览记录'),
      `⑤ ★★ 清空后必须落正常空态文案（本组主判据）。实际渲染：${afterText}`
    );
    assert.equal(
      afterText.includes('最近浏览的'),
      false,
      `⑤ ★ 清空后不得再显示条数摘要。实际渲染：${afterText}`
    );
    assert.equal(
      afterText.includes('清空足迹'),
      false,
      `⑤ ★ 清空后没有东西可清，不得再显示清空按钮。实际渲染：${afterText}`
    );
    assert.equal(page.data.footprintsBlock.data.length, 0, '⑤ 清空后列表应为空（旁证）');
    assert.equal(page.data.footprintsBlock.loading, false, '⑤ ★ 清空后不得停在 loading');
    assert.equal(page.data.footprintsBlock.error, '', '⑤ ★ 清空后是**正常空态**，不是错误态');
    assert.equal(page.data.clearError, '', '⑤ 清空成功不得留下错误占位');

    // ==================== ⑥ 重进页面（onShow）→ 不回填 ====================
    // ★ 同 ⑤：渲染判据在前、状态字段（旁证）在后。
    page.onShow();
    await settle();
    await settle();
    const reenterText = renderText(FOOTPRINTS_WXML, page.data);
    assert.equal(
      reenterText.includes('最近浏览的'),
      false,
      `⑥ ★★ 重进后不得回填已清空的足迹（主判据：看用户实际看到什么）。实际渲染：${reenterText}`
    );
    assert.ok(
      reenterText.includes('暂无浏览记录'),
      `⑥ ★ 重进后仍是正常空态。实际渲染：${reenterText}`
    );
    assert.equal(page.data.footprintsBlock.data.length, 0, '⑥ 重进后列表应为空（旁证）');

    // ==================== ⑦ 截断文案：只有服务端说被截断时才出现 ====================
    records = sampleRecords();
    serverTotal = 23;
    await page.load();
    assert.equal(
      page.data.footprintTruncated, true,
      '⑦ 服务端说真实总数 23 > 本页 2 条 → 应判定为被截断'
    );
    const truncatedText = renderText(FOOTPRINTS_WXML, page.data);
    assert.ok(
      truncatedText.includes('最多显示 20 件'),
      `⑦ ★ 被截断时必须如实告知「最多显示 20 件」。实际渲染：${truncatedText}`
    );
    assert.ok(
      truncatedText.includes('最近浏览的 2 件商品'),
      `⑦ ★ 条数仍是**用户实际看到的**条数（2），不是真实总数（23）。实际渲染：${truncatedText}`
    );

    // ==================== ⑧ 失败：可见 + 可重试，且重试的是**清空本身** ====================
    serverTotal = null;
    deleteShouldFail = true;
    calls.length = 0;
    page.clearFootprints();
    harness.getModals().at(-1).success({ confirm: true });
    await settle();
    await settle();
    assert.equal(page.data.clearing, false, '⑧ 失败后不得把按钮锁在「清空中…」');
    assert.ok(
      page.data.clearError,
      '⑧ ★ 失败必须落成**常驻**错误（可见），而不是只弹一个会消失的 toast'
    );
    assert.equal(
      page.data.footprintsBlock.data.length, 2,
      '⑧ ★ 失败时不得清空列表 —— 我们并不知道服务端到底删没删掉'
    );
    const failureText = renderText(FOOTPRINTS_WXML, page.data);
    assert.ok(
      failureText.includes(page.data.clearError),
      `⑧ 错误文案必须渲染出来。实际渲染：${failureText}`
    );
    assert.ok(failureText.includes('重试'), `⑧ ★ 必须给出重试入口。实际渲染：${failureText}`);

    // ★★ 「重试」必须重试**清空**本身。若它退化成 `load()`，用户点多少次都删不掉 ——
    //    那个重试按钮就是假的。
    //
    // ★ 前置：进入重试前 `clearError` **必须非空**。`retryFootprints` 的分流依据就是
    //   它 —— 若它在这里是空的，重试必然走 `load()` 分支，而下面那条断言会以
    //   「0 !== 1」的形式失败，却看不出根因。先把状态钉住，失败才可归因。
    assert.ok(
      page.data.clearError,
      `⑧ 前置：进入重试前 clearError 必须非空（它是 retryFootprints 的分流依据）。`
      + `实得：${JSON.stringify(page.data.clearError)}`
    );
    calls.length = 0;
    deleteShouldFail = false;
    await page.retryFootprints();
    await settle();
    assert.equal(
      deleteCalls().length, 1,
      '⑧ ★★ 清空失败后的「重试」必须重试**清空**，而不是重新加载（重新加载删不掉任何东西）。'
      // ★ 断言消息里带上**全部**判据依据：这条断言曾以「0 !== 1」失败过一次，
      //   单看那两个数字无法归因（是 clearError 空了？还是请求没发出去？）。
      + `证据：clearError=${JSON.stringify(page.data.clearError)}`
      + ` clearing=${page.data.clearing}`
      + ` calls=${JSON.stringify(calls)}`
      + ` deleteShouldFail=${deleteShouldFail}`
    );
    assert.equal(page.data.clearError, '', '⑧ 重试成功后应清掉错误占位');
    assert.equal(page.data.footprintsBlock.data.length, 0, '⑧ 重试成功后列表应为空');
  } finally {
    harness.restore();
  }
});

/**
 * T52(补3)：三处开关守卫的 **`!*Loaded` 半边** —— **点击侧**的判据。
 *
 * ★ 这一节补的是什么缺口（team-lead 实测得出，不是推测）：
 *   三处守卫都是「两半」，形态如下 ——
 *     `detail.js:317`  `favoriteStateUnknown()` → `!favoriteStateLoaded || Boolean(favoriteStateError)`
 *     `detail.js:321`  `restockStateUnknown()`  → 同构
 *     `profile.js:282` `toggleOrderMessages()`  → `!orderMessageStateLoaded || orderMessageStateError`
 *   把三处的 **`!*Loaded` 那半边全砍掉**（只留 `*Error`），根侧全量**依然全绿**
 *   （297/297/0）⇒ 「**还没问到**」这半边在**点击侧**没有任何判据。
 *   （渲染侧有 `#42`（`「还没问到」那一瞬…`）守着，所以砍守卫不影响它 ——
 *     wxml 读的是 `*Loaded` 字段**本身**，不走上面这两个函数。）
 *
 * ★ 本节要钉住的行为：`*Loaded === false` 且 `*Error === ''`（**还没问到**）时点开关，
 *   **不得盲翻转**，而应发出**读请求**（GET）去先把状态问清楚。
 *
 * ★★ 两条断言纪律（team-lead 反复强调，这里照做）：
 *   1. 拿请求日志靠给 `pendingSwitchApiHandler(log)` 传那个**可选**的 log 参数 ——
 *      既有调用方（`#42`，不传参）一个字都没动；
 *   2. **绝不用 `log.some(...)`**。必须先 `log.length = 0` 清空，再断言
 *      `log.length === 1` **且** `log[0].method === 'GET'`。`some` 会在
 *      「除了读请求还夹带了写请求」时**静默通过** —— 那正好是要防的缺陷。
 *
 * ★ 为什么**不 `await`** 那次点击：桩的状态端点 GET **永不 settle**（`#42` 用的同一手法），
 *   `toggleFavorite()` 会把那个永不 settle 的 promise 原样返回 —— `await` 它会把用例
 *   **挂死**。请求是**同步**发出去的（`loadFavoriteState` 里 `request(...)` 直接调用），
 *   所以点完 `await settle()` 一次就足以读到日志。
 *
 * ★ 为什么**拆成三条用例**、而不是一条里连断言三处：否则变异时会在**第一条**上中断，
 *   后两处**根本没被求值** —— 拿不到「另外两处是否也生效」的证据（本仓已踩过一次：
 *   「旁证先红」）。
 *
 * ★ 防空过：`log.length === 1` 与 `log[0].method === 'GET'` 分开断言，各承担一个判据。
 *   前者挡「发了读请求之后又夹带写请求」，后者挡「盲翻转」。在**盲翻转**的变异下，
 *   前者仍然通过（那一个请求也是 1 条）、**后者必红** —— 这正是判据生效的形态。
 *   「状态已知时点击仍是 POST」由既有用例 `detail：成功路径逐字不变` /
 *   `profile：成功路径逐字不变` 守着，本节不重复。
 */

test('T52(补3)：detail 收藏「还没问到」时点击必须发 GET 重取，不得盲翻转（!favoriteStateLoaded 半边）', async () => {
  const harness = createHarness();
  try {
    const log = [];
    harness.setApiHandler(pendingSwitchApiHandler(log));
    const page = harness.loadPage('pages/detail/detail.js');
    page.onLoad({ id: SWITCH_PRODUCT.id });
    await settle();
    await settle();
    await settle();

    // ── 前置条件：「还没问到」这一瞬（`*Loaded === false` 且 `*Error === ''`）
    assert.ok(page.data.scooter, '前置条件：商品已到，底部按钮行才会渲染');
    assert.equal(page.data.favoriteStateLoaded, false, '前置条件：收藏状态请求还在路上');
    assert.equal(page.data.favoriteStateError, '', '前置条件：还没失败');
    assert.equal(page.data.favorited, false, '前置条件：未知态下 `favorited` 是初值 false（盲翻转会把它变成 true）');

    // ── ★★ 主判据：点一下必须发**读**请求，而不是盲取反
    log.length = 0;
    page.toggleFavorite(); // ★ 刻意不 await：桩永不 settle，await 会挂死（见本节头注）
    await settle();
    assert.equal(
      log.length, 1,
      '★★ 未知态下点「收藏」必须**只**发一个请求（读状态），不得在读出结果之外再夹带一个写请求。'
      + `证据：log=${JSON.stringify(log)} favorited=${page.data.favorited}`
      + ` toasts=${JSON.stringify(harness.getToasts())}`
    );
    assert.equal(
      log[0].method, 'GET',
      '★★ 未知态下点「收藏」的语义是「重新获取状态」（GET），不得盲取反（POST）——'
      + '那会在我们并不知道用户是否已收藏时，就凭一个初值发出一个写请求。'
      + `证据：log=${JSON.stringify(log)}`
    );
    assert.equal(
      log[0].requestPath, `/api/products/${SWITCH_PRODUCT.id}/favorite`,
      '★ 读请求必须打到收藏状态端点本身。'
      + `证据：log=${JSON.stringify(log)}`
    );

    // ── 旁证：盲翻转会在本地状态与 toast 上各留一处痕迹（排在主判据之后）
    assert.equal(page.data.favorited, false, '★ 答复到达前不得把本地状态翻成 true');
    assert.equal(
      harness.getToasts().length, 0,
      `★ 不得弹「已加入收藏」——那时我们并不知道结果。实际 toasts：${JSON.stringify(harness.getToasts())}`
    );
  } finally {
    harness.restore();
  }
});

test('T52(补3)：detail 到货提醒「还没问到」时点击必须发 GET 重取，不得盲翻转（!restockStateLoaded 半边）', async () => {
  const harness = createHarness();
  try {
    const log = [];
    harness.setApiHandler(pendingSwitchApiHandler(log));
    const page = harness.loadPage('pages/detail/detail.js');
    page.onLoad({ id: SWITCH_PRODUCT.id });
    await settle();
    await settle();
    await settle();

    // ── 前置条件：「还没问到」这一瞬
    assert.ok(page.data.scooter, '前置条件：商品已到，底部按钮行才会渲染');
    assert.equal(page.data.scooter.sellableStock, 0, '前置条件：无库存，到货提醒按钮才会渲染');
    assert.equal(page.data.restockStateLoaded, false, '前置条件：到货提醒状态请求还在路上');
    assert.equal(page.data.restockStateError, '', '前置条件：还没失败');
    assert.equal(page.data.restockSubscribed, false, '前置条件：未知态下 `restockSubscribed` 是初值 false');

    // ── ★★ 主判据
    log.length = 0;
    page.toggleRestockAlert(); // ★ 不 await，理由同本节头注
    await settle();
    assert.equal(
      log.length, 1,
      '★★ 未知态下点「到货提醒」必须**只**发一个请求（读状态）。'
      + `证据：log=${JSON.stringify(log)} restockSubscribed=${page.data.restockSubscribed}`
      + ` toasts=${JSON.stringify(harness.getToasts())}`
    );
    assert.equal(
      log[0].method, 'GET',
      '★★ 未知态下点「到货提醒」的语义是「重新获取状态」（GET），不得盲取反（POST）。'
      + `证据：log=${JSON.stringify(log)}`
    );
    assert.equal(
      log[0].requestPath, `/api/products/${SWITCH_PRODUCT.id}/restock-alert`,
      '★ 读请求必须打到到货提醒状态端点本身。'
      + `证据：log=${JSON.stringify(log)}`
    );

    // ── 旁证
    assert.equal(page.data.restockSubscribed, false, '★ 答复到达前不得把本地状态翻成 true');
    assert.equal(
      harness.getToasts().length, 0,
      `★ 不得弹「到货后通知你」。实际 toasts：${JSON.stringify(harness.getToasts())}`
    );
  } finally {
    harness.restore();
  }
});

test('T52(补3)：profile 订单提醒「还没问到」时点击必须发 GET 重取，不得盲翻转（!orderMessageStateLoaded 半边）', async () => {
  const harness = createHarness();
  try {
    const log = [];
    harness.setApiHandler(pendingSwitchApiHandler(log));
    const page = harness.loadPage('pages/profile/profile.js');
    // ★ 不 await：`onShow` 不是 async 方法，返回 `undefined`；它内部发的
    //   订单提醒状态请求被桩挂住，`orderMessageStateLoaded` 才会停在 `false`。
    page.onShow();
    await settle();
    await settle();
    await settle();

    // ── 前置条件：「还没问到」这一瞬
    assert.equal(page.data.orderMessageStateLoaded, false, '前置条件：订单提醒状态请求还在路上');
    assert.equal(page.data.orderMessageStateError, '', '前置条件：还没失败');
    assert.equal(page.data.orderMessageSubscribed, false, '前置条件：未知态下 `orderMessageSubscribed` 是初值 false');

    // ── ★★ 主判据
    log.length = 0;
    page.toggleOrderMessages(); // ★ 不 await，理由同本节头注
    await settle();
    assert.equal(
      log.length, 1,
      '★★ 未知态下点「订单提醒」必须**只**发一个请求（读状态）。'
      + '盲翻转会走进「开启提醒」那条链，先拉 `/api/subscribe-templates` 再 POST ——'
      + '那会**重新弹一次微信授权**，而且是在我们并不知道当前状态时。'
      + `证据：log=${JSON.stringify(log)} orderMessageSubscribed=${page.data.orderMessageSubscribed}`
      + ` toasts=${JSON.stringify(harness.getToasts())}`
    );
    assert.equal(
      log[0].method, 'GET',
      '★★ 未知态下点「订单提醒」的语义是「重新获取状态」（GET），不得盲取反（POST）。'
      + `证据：log=${JSON.stringify(log)}`
    );
    assert.equal(
      log[0].requestPath, '/api/order-message-subscriptions',
      '★ 读请求必须打到订单提醒状态端点本身。'
      + `证据：log=${JSON.stringify(log)}`
    );

    // ── 旁证
    assert.equal(page.data.orderMessageSubscribed, false, '★ 答复到达前不得把本地状态翻成 true');
    assert.equal(
      harness.getToasts().length, 0,
      `★ 不得弹「已开启提醒」。实际 toasts：${JSON.stringify(harness.getToasts())}`
    );
  } finally {
    harness.restore();
  }
});
