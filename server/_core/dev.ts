/**
 * 开发模式的入口 —— 只做一件事：**把 NODE_ENV 设成 development**。
 *
 * ## 为什么要有这个文件
 *
 * `package.json` 里原来写的是 `"dev": "NODE_ENV=development tsx watch …"` ——
 * 那是 **POSIX 的写法** ✓，在 **Windows 的 cmd 里不认** ✗
 * （`'NODE_ENV' is not recognized as an internal or external command` ✗）。
 *
 * 于是 Windows 上 `npm run dev` 直接**起不来** ✗，
 * 每个人只能自己手敲 `npx tsx server/_core/index.ts` ✗ ——
 * 而手敲的那条**不带 watch** ✗ ⇒ 改了源码不重载 ⇒
 * 「我改了代码，网站还是旧的」——查起来毫无线索 ✗。
 *
 * 现在：入口文件自己设环境变量 ✓ ⇒
 * `npm run dev` 在 **Windows 与 POSIX 上都一样** ✓，而且**带 watch** ✓。
 *
 * 为什么不用 `cross-env`：多一个依赖 ✗（而且离线环境装不上 ✗）。
 */
process.env.NODE_ENV = "development";
await import("./index.js");
