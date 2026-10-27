// 核心库出口。桥接（qq-bridge）从这里拿，插件自己也从这里拿——
// 只有一份实现，改一处两边都变。
export * from './paths.mjs';
export * from './sign.mjs';
export * from './net.mjs';
export * from './parse.mjs';
export * from './discover.mjs';
export * from './store.mjs';
export * from './config.mjs';
export { createScout } from './scout.mjs';