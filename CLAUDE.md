# CLAUDE.md

本文件为 Claude Code 在此仓库中工作时提供指导。

## 项目概览

狮山智生活（campus-go-mvp）——校园服务微信小程序 MVP，用于需求验证。覆盖校园电话卡选购、电瓶车租赁与校内配送、校园牌照办理辅助、订单与售后、学生身份模拟认证。

**重要**：业务数据统一保存在 `server/` 的模拟存储中；实名认证与校方校园卡系统仍是模拟边界（支付能力见下方「边界与禁区」）。当前状态是演示设计，不是待修复的缺陷。

### 目录结构

- `miniprogram/` — 原生微信小程序前端（**32 个页面**，分布在 24 个页面目录下；完整清单见 `miniprogram/app.json` 的 `pages` 数组）
- `server/` — Node.js 模拟 API + `/admin` 运营管理端（**独立 git 仓库，已注册为 git submodule**，见仓库根 `.gitmodules`）
- `miniapp/`、`i18n/` — 脚手架残留，无代码引用，可安全删除（本轮保留）

## 常用命令

### 服务端（server/）

```bash
cd server
npm start        # 启动，默认 http://localhost:3000
npm run dev      # watch 模式
npm test         # 运行接口测试（node --test）
```

- 环境变量：`PORT`（端口）、`DB_FILE`（db.json 路径）
- 管理端：浏览器访问 `http://localhost:3000/admin`；账号密码仅来自环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（参考 `server/.env.example`），源码与登录页不内置凭据
- 需先执行 `cd server && npm install`（安装唯一运行时依赖 `mysql2`）再 `npm start`；要求 Node.js 18+

### 小程序

无命令行构建。用微信开发者工具「导入项目」选择 `campus-go-mvp/` 目录（AppID 已配置 touristappid），编译即可预览。

## 架构与数据流

### 小程序端

- 页面：`miniprogram/pages/*`（**32 个页面**，完整清单见 `miniprogram/app.json`；含 home/search/map/card/plate/scooters/detail/checkout/addresses/orders/profile/aftersales/consult/edit-order/merchant*/agreement/recharge/store/market*/forum*/favorites/footprints/reviews/notifications）
- 数据层：`services/store.js` 仅提供商品兜底读取；订单、售后和办理数据以后端为唯一事实来源
- 模拟数据：`data/mock.js`
- API 配置：`config/api.js` 只导出两个常量 `CLOUD_ENV_ID`（`prod-d3g0c9o4ycd708e09`）与 `CLOUD_SERVICE_NAME`（`express-k49o`）；小程序通过 `lib/cloud-request.js` 走微信云托管调用，**不存在 `API_BASE_URL`**
- 全局配置：`miniprogram/app.json`（页面注册、tabBar：首页/订单/我的）

### 服务端

- `src/server.js` — HTTP 启动入口
- `src/app.js` — 路由、参数校验、错误响应、审计日志（核心文件）。**实测 9170 行；`createApp` 是单个 7958 行的函数（第 1213 行至文件末），内含 84 个 `pathname === '...'` 分支与 52 个 `pathname.match(...)` 正则分支。本轮正在按业务域拆分。**
- `src/store.js` — `data/db.json` 读写（JSON 文件持久化，重启不丢）
- `public/admin.*` — 纯静态管理端页面（商品库存、订单、售后、CSV 导出、操作日志）
- `test/api.test.js` — 接口测试（**6252 行 / 1584 处断言，真实 HTTP 集成测试：起服务 + fetch 打接口**）

小程序业务数据统一通过 `services/api.js` 调用 server；本地缓存仅用于商品兜底展示和用户填写信息。

## 硬性约定（改代码必须遵守）

- **金额一律人民币分**：`29900` 表示 299.00 元
- 错误响应格式：`{ "error": { "code": "VALIDATION_ERROR", "message": "..." }, "requestId": "..." }`
- 成功响应数据包在 `data` 字段，列表接口另有 `total`
- 订单创建支持 `Idempotency-Key` 请求头，网络重试时复用
- 客户端传入的价格不采信，订单金额由服务端商品数据计算
- 用户敏感信息（姓名、学号）对外输出需脱敏（参照 `applicantNameMasked` / `studentNoMasked` 模式）
- 服务端运行时依赖仅 `mysql2`（`^3.11.0`，用于可选 MySQL 持久化，见 `src/mysql-store.js`），其余只用 Node.js 内置模块；不新增其他运行时依赖
- 售后约定：同一订单只允许一个未关闭的售后申请；校园卡 `serviceType` 限 `NEW_CARD` / `REPLACEMENT` / `TOP_UP`；售后 `type` 限 `REFUND` / `RETURN` / `REPAIR`
- **测试契约（务必遵守）**：
  - `server/test/api.test.js` 通过 `createApp({ store, wechatAuth, wechatSubscribeSend })` 创建应用，并从 `../src/app` 导入。`createApp` 的函数签名与 `server/src/app.js` 末尾的 `module.exports = { createApp, ApiError }` 导出形态**必须保持**。该测试文件 6252 行 / 1584 断言是回归安全网，**只允许新增断言，严禁重写或删改既有断言**。
  - `JsonStore.update()` 必须**保持同步并同步返回结果**，不得改为 Promise —— 全仓 `store.update(` 有 180 处调用（`server/src` 105 处、`server/test` 75 处），其中 `server/src` 内 82 处写成 `const x = store.update(...)`、7 处写成 `return store.update(...)`，全部**同步取用返回值**；全仓 **0 处 `await store.update(...)`**。需要异步时新增 `updateAsync()`，不要改 `update()` 签名。

## 边界与禁区

以下均为有意设计的演示边界，除非用户明确要求，不要"升级"：

- **支付**：默认 `mock` 提供方用于演示；`wechat` 提供方**已实现** JSAPI 下单、验签回调、退款与对账——`src/payment-provider.js` 是提供方抽象（`mock` / `wechat` 双实现），`src/wechat-pay-transport.js`（361 行）含商户请求签名、小程序支付参数签名、回调时间戳/序列号/验签、AES-256-GCM 回调解密、退款、账单下载；`server/test/` 下有 11 个 `payment-*.test.js` 专项测试（另有 `wechat-pay-transport.test.js`、`wechat-payment-integration.test.js`）。但**尚未完成商户平台配置与真实环境联调**。实名认证、校方校园卡系统仍为模拟边界
- 客户端 `userId` 仅兼容旧调用；服务端身份来自微信登录后的服务端会话，不能信任客户端传值
- JSON 文件存储只支持单进程演示，不做并发/事务/预占库存改造
- CORS 按 `CORS_ALLOWED_ORIGINS` 精确来源白名单匹配（`src/app.js` 的 `resolveCorsOrigin()`），**默认只允许 `http://localhost:3000` 与 `http://127.0.0.1:3000`**
- 管理端已支持环境变量密码哈希、持久会话、多管理员和 RBAC；生产部署仍需接入真实身份源与安全审计

## 验证方式

- 改动 `server/` 后：`cd server && npm test`，全部通过才算完成
- 改动 `miniprogram/` 后：在仓库根目录运行 `npm test`，结构检查全部通过才算完成
- 改动小程序页面后：需要用户在微信开发者工具中编译预览确认（命令行无法自动验证 UI）
- JSON 文件改动后做解析校验
