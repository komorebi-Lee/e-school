# CLAUDE.md

本文件为 Claude Code 在此仓库中工作时提供指导。

## 项目概览

狮山智生活（campus-go-mvp）——校园服务微信小程序 MVP，用于需求验证。覆盖校园电话卡选购、电瓶车租赁与校内配送、校园牌照办理辅助、订单与售后、学生身份模拟认证。

**重要**：全部数据为本地模拟，不接真实微信支付、实名认证或校方接口。当前状态是演示设计，不是待修复的缺陷。

### 目录结构

- `miniprogram/` — 原生微信小程序前端（11 个页面）
- `server/` — 零依赖 Node.js 模拟 API + `/admin` 运营管理端（有独立 git 仓库）
- `miniapp/`、`i18n/` — 脚手架残留（只有占位配置），勿动

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
- 无需 `npm install`，零依赖，要求 Node.js 18+

### 小程序

无命令行构建。用微信开发者工具「导入项目」选择 `campus-go-mvp/` 目录（AppID 已配置 touristappid），编译即可预览。

## 架构与数据流

### 小程序端

- 页面：`miniprogram/pages/*`（home/card/plate/scooters/detail/checkout/orders/profile/aftersales/consult/edit-order）
- 数据层：`services/store.js` 用 `wx.setStorageSync` 做本地持久化（订单、校园卡申请、售后记录）
- 模拟数据：`data/mock.js`
- API 配置：`config/api.js` 定义 `API_BASE_URL`（当前 `http://127.0.0.1:3000`，上架前需替换为已备案 HTTPS 域名）
- 全局配置：`miniprogram/app.json`（页面注册、tabBar：首页/订单/我的）

### 服务端

- `src/server.js` — HTTP 启动入口
- `src/app.js` — 路由、参数校验、错误响应、审计日志（核心文件）
- `src/store.js` — `data/db.json` 读写（JSON 文件持久化，重启不丢）
- `public/admin.*` — 纯静态管理端页面（商品库存、订单、售后、CSV 导出、操作日志）
- `test/api.test.js` — 接口测试

前端目前以本地数据为主，server 是「下一步把本地数据替换为联网数据」的并行形态。

## 硬性约定（改代码必须遵守）

- **金额一律人民币分**：`29900` 表示 299.00 元
- 错误响应格式：`{ "error": { "code": "VALIDATION_ERROR", "message": "..." }, "requestId": "..." }`
- 成功响应数据包在 `data` 字段，列表接口另有 `total`
- 订单创建支持 `Idempotency-Key` 请求头，网络重试时复用
- 客户端传入的价格不采信，订单金额由服务端商品数据计算
- 用户敏感信息（姓名、学号）对外输出需脱敏（参照 `applicantNameMasked` / `studentNoMasked` 模式）
- 服务端保持零依赖：只用 Node.js 内置模块，不新增 npm 包
- 售后约定：同一订单只允许一个未关闭的售后申请；校园卡 `serviceType` 限 `NEW_CARD` / `REPLACEMENT` / `TOP_UP`；售后 `type` 限 `REFUND` / `RETURN` / `REPAIR`

## 边界与禁区

以下均为有意设计的演示边界，除非用户明确要求，不要"升级"：

- **不接真实微信支付/退款、实名认证、校方校园卡系统**——订单创建后直接 `PAID` + `MOCK_SUCCESS` 是为了可直接演示
- `userId` 是模拟身份参数（客户端传值），生产环境才需要改为微信登录后的服务端会话
- JSON 文件存储只支持单进程演示，不做并发/事务/预占库存改造
- CORS 全开是本地联调设计
- 管理端内存会话 + 明文演示账号仅限本地验证，生产需换数据库用户 + 密码哈希 + RBAC

## 验证方式

- 改动 `server/` 后：`cd server && npm test`，全部通过才算完成
- 改动小程序页面后：需要用户在微信开发者工具中编译预览确认（命令行无法自动验证 UI）
- JSON 文件改动后做解析校验
