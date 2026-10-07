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

  if (hasElse) {
    // `wx:else`：只有前面所有分支都为假时才渲染。
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const sibling = siblings[cursor];
      const siblingIf = typeof sibling.attrs['wx:if'] === 'string';
      const siblingElif = typeof sibling.attrs['wx:elif'] === 'string';
      if (!siblingIf && !siblingElif) return true;
      const value = Boolean(evaluateExpression(stripBraces(siblingIf ? sibling.attrs['wx:if'] : sibling.attrs['wx:elif']), data));
      if (value) return false;
      if (siblingIf) return true;
    }
    return true;
  }

  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const sibling = siblings[cursor];
    const siblingIf = typeof sibling.attrs['wx:if'] === 'string';
    const siblingElif = typeof sibling.attrs['wx:elif'] === 'string';
    if (!siblingIf && !siblingElif) return false;
    const condition = siblingIf ? sibling.attrs['wx:if'] : sibling.attrs['wx:elif'];
    const value = Boolean(evaluateExpression(stripBraces(condition), data));
    if (cursor === index) return value;
    if (value) return false;
    if (siblingIf) return true;
  }
  return false;
}

/**
 * 把一页 wxml 在当前 `data` 下**渲染成一段纯文本**。
 *
 * 这是第 3 节所有「不得渲染出 X」断言的证据来源：不是断言状态字段，
 * 而是断言**用户实际会看到的那段文字**。
 *
 * `wx:for` 只渲染第一项（我们关心的是页面级空态文案，它们都在循环之外）；
 * 列表为空时整棵子树跳过。
 *
 * @param {string} relativeWxmlPath 相对 `miniprogram/` 的 wxml 路径。
 * @param {object} data 页面数据。
 * @returns {string} 渲染出的文案。
 */
function renderText(relativeWxmlPath, data) {
  const source = fs.readFileSync(path.join(miniprogramDirectory, relativeWxmlPath), 'utf8');
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
      // 片段先剥注释/残留标签，再插值 —— 顺序不能反：
      // 注释里若写了 `{{...}}`，先插值就会把它渲染出来。
      chunks.push(interpolate(textOfFragment(source.slice(cursor, child.index)), currentScope));
      cursor = child.closeEnd;
      walk(child, currentScope);
    }
    chunks.push(interpolate(textOfFragment(source.slice(cursor, element.endIndex)), currentScope));
  };
  for (const child of root.children) walk(child, data);
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

/** 这一屏是否会出现某段文字。 */
function renders(relativeWxmlPath, data, needle) {
  return renderText(relativeWxmlPath, data).includes(needle);
}

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
