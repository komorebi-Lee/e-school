/**
 * 图片读取与上传的唯一入口。
 *
 * ## 为什么需要这个模块
 *
 * 改造前，`wx.getFileSystemManager().readFile({ … })` 在 **9 处 / 7 个文件**里被
 * 逐个手抄了一遍（`aftersales` / `forum/publish` / `market/publish` /
 * `merchant/apply` / `merchant/index` ×2 / `merchant/products` / `orders` ×2）。
 *
 * 这带来三个具体问题，而不是"代码不好看"：
 *
 * 1. **`mimeType` 推断被抄了 9 遍** —— 一旦服务端白名单变化，必须同时改 9 处，
 *    漏一处就是"某些图片上传后被静默拒绝"，且很难定位。
 * 2. **失败语义各不相同** —— 有的 `reject(new Error(...))`，有的弹 toast，
 *    有的干脆没有任何失败分支。同一件事有 4 种处理方式，意味着 4 种可能的漏处理。
 * 3. **无法被测试** —— `readFile` 是回调式 API，散落在页面方法里就无法在 Node 里
 *    真实跑一遍；抽成 Promise 化函数后，成功/失败两条路径都能被断言。
 *
 * 本模块因此是**全仓唯一**调用 `readFile` 的地方（PRD `M3-P2-01` 判据 ④）。
 *
 * ## 入参形状
 *
 * 主用法是直接传 wx 的临时文件对象（`chooseMedia` 返回的 `tempFiles[i]`，
 * 形如 `{ tempFilePath, size }`），因此 9 个调用点都写成 `uploadImage(file, request)`。
 * 同时也接受路径字符串，便于在页面之外复用（例如测试里直接给一个路径）。
 *
 * ## 依赖约定
 *
 * 本模块**只依赖 `wx`**，不 require `services/*` —— 上传用的 `request` 由调用方注入。
 * 这样做的原因有两个：
 *
 * - `merchant/index.js` 的上传必须带商家 token，它用的是页面自己的 `this.request`
 *   （见该文件 `request()` 方法），而不是 `services/api` 的裸 `request`；
 * - `utils/*` 保持叶子模块，不产生 `utils → services` 的反向依赖。
 *
 * ## 失败一律 reject，绝不静默
 *
 * 本模块内**没有空 catch**。`getFileSystemManager()` 在某些环境会**同步抛错**，
 * 这类错误必须落成 `reject` 而不是同步异常 —— 否则调用方的 `.catch` 根本接不到，
 * 会变成未捕获异常（页面白屏且没有任何提示）。这正是"静默失败"的另一种形态。
 */

/** 上传接口路径。 */
const UPLOAD_PATH = '/api/uploads';

/** 读不到可读文案时的兜底提示。 */
const DEFAULT_READ_ERROR_TEXT = '图片读取失败';

/**
 * 扩展名 → MIME 类型。
 *
 * 未知扩展名按 JPEG 处理：服务端只接受这三种，而 `chooseMedia` 返回的图片
 * 绝大多数是 jpg，把它归到 jpeg 比拒绝上传更符合预期。
 */
const MIME_TYPES = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg'
};

/**
 * 把入参统一成 `{ tempFilePath }` 形状。
 *
 * 后面的读取逻辑只认这一种形状，避免"字符串 / 对象"两套分支散落到每个函数里。
 *
 * @param {object|string} input 临时文件对象或路径字符串。
 * @returns {{tempFilePath: string}} 统一后的文件对象。
 */
function normalizeFile(input) {
  if (typeof input === 'string') return { tempFilePath: input };
  return input || {};
}

/**
 * 取路径的扩展名（小写，不含点）。
 *
 * 先去 query 再去 fragment，因为临时文件路径可能带参数（如 `?x=1`），
 * 直接 `split('.').pop()` 会把 `jpg?x=1` 当成扩展名。
 *
 * @param {string} filePath 文件路径。
 * @returns {string} 小写扩展名；无扩展名时返回空串。
 */
function extensionOf(filePath) {
  const base = String(filePath || '').split('?')[0].split('#')[0];
  const dotIndex = base.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === base.length - 1) return '';
  return base.slice(dotIndex + 1).toLowerCase();
}

/**
 * 按扩展名推断 MIME 类型。
 *
 * @param {string} filePath 文件路径。
 * @returns {string} MIME 类型，未知扩展名回落为 `image/jpeg`。
 */
function mimeTypeForPath(filePath) {
  return MIME_TYPES[extensionOf(filePath)] || 'image/jpeg';
}

/**
 * 把本地文件读成 base64 字符串（Promise 化）。
 *
 * 成功时 resolve 非空 base64 字符串；**任何**失败都 reject 一个带可读 `message`
 * 的 `Error`，并把底层原因挂在 `error.cause` 上。
 *
 * 为什么不把底层原因拼进 `message`：这些文案会直接进 `wx.showToast`，
 * 拼上 `readFile:fail ...` 会把 toast 撑得又长又难读。用户看主文案，
 * 排查问题时看 `cause`。
 *
 * @param {object|string} input 临时文件对象（`{ tempFilePath }`）或路径字符串。
 * @param {object} [options] 入参。
 * @param {string} [options.readErrorMessage] 读取失败时的主文案。
 * @returns {Promise<string>} base64 字符串。
 */
function readFileAsBase64(input, options = {}) {
  const file = normalizeFile(input);
  const message = typeof options.readErrorMessage === 'string' && options.readErrorMessage
    ? options.readErrorMessage
    : DEFAULT_READ_ERROR_TEXT;
  if (!file.tempFilePath) {
    const error = new Error(message);
    error.cause = 'filePath 为空';
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let manager;
    try {
      manager = wx.getFileSystemManager();
    } catch (error) {
      // ★ 同步抛错也必须落成 reject，否则调用方接不到（见模块头注释）。
      const failure = new Error(message);
      failure.cause = (error && error.message) || '文件系统不可用';
      reject(failure);
      return;
    }
    if (!manager || typeof manager.readFile !== 'function') {
      const failure = new Error(message);
      failure.cause = '文件系统不可用';
      reject(failure);
      return;
    }

    manager.readFile({
      filePath: file.tempFilePath,
      encoding: 'base64',
      success: ({ data } = {}) => {
        if (typeof data === 'string' && data) {
          resolve(data);
          return;
        }
        const failure = new Error(message);
        failure.cause = 'readFile 返回了空内容';
        reject(failure);
      },
      fail: (error) => {
        const failure = new Error(message);
        failure.cause = (error && error.errMsg) || 'readFile 失败';
        reject(failure);
      }
    });
  });
}

/**
 * 读出上传接口所需的完整载荷。
 *
 * @param {object|string} input 临时文件对象或路径字符串。
 * @param {object} [options] 入参，透传给 {@link readFileAsBase64}。
 * @returns {Promise<{dataBase64: string, mimeType: string}>} 上传载荷。
 */
function readImagePayload(input, options = {}) {
  const file = normalizeFile(input);
  return readFileAsBase64(file, options).then((dataBase64) => ({
    dataBase64,
    mimeType: mimeTypeForPath(file.tempFilePath)
  }));
}

/**
 * 读取图片并上传，resolve 服务端返回的 `data`。
 *
 * resolve 的是**整个 `data` 对象**而不是只取 `url`：`merchant/apply.js` 需要
 * `size`，只返回 `url` 会逼它再去读一次响应。调用方各取所需即可。
 *
 * @param {object|string} input 临时文件对象或路径字符串。
 * @param {Function} request 注入的请求函数，签名同 `services/api` 的 `request`。
 * @param {object} [options] 入参。
 * @param {string} [options.readErrorMessage] 读取失败时的主文案。
 * @returns {Promise<object>} 上传接口的 `data`。
 * @throws {TypeError} `request` 不是函数时同步抛出（接线错误应当立刻暴露）。
 */
function uploadImage(input, request, options = {}) {
  if (typeof request !== 'function') throw new TypeError('uploadImage 需要注入 request 函数');
  return readImagePayload(input, options)
    .then((payload) => request(UPLOAD_PATH, { method: 'POST', data: payload }))
    .then((body) => (body && body.data) || {});
}

module.exports = {
  UPLOAD_PATH,
  DEFAULT_READ_ERROR_TEXT,
  normalizeFile,
  extensionOf,
  mimeTypeForPath,
  readFileAsBase64,
  readImagePayload,
  uploadImage
};
