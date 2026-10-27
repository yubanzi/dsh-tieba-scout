// 贴吧 PC 端接口签名。
//
// 算法来自贴吧前端 `pc-common/static/js/base.*.js`（`useSign` 分支）：
//   1. data 里自动补 `subapp_type=pc`、`_client_type=20`（PC 端取 20）；
//   2. 把**键名按字典序**排序，拼成 `k=v` 直接相连（没有分隔符）；
//   3. 末尾接上盐，取 md5。
//
// 盐是按 subapp_type 分三档的：
//   pc       → 36770b1f34c9bbf2e7d1a99d2b82fa9e
//   client   → tiebaclient!!!            （app 端，和 dsh-tieba-scroll 用的一致）
//   其它     → 0039d79dc3cc2075129745a30237a3c4
//
// 不带 sign 的请求一律回 `{"error_code":110001,"error_msg":"未知错误"}`——
// 这个码看着像风控，实际只是签名缺失，别当成账号问题。
import crypto from 'node:crypto';

export const SALT_PC = '36770b1f34c9bbf2e7d1a99d2b82fa9e';
export const SALT_CLIENT = 'tiebaclient!!!';
export const SALT_OTHER = '0039d79dc3cc2075129745a30237a3c4';

export const CLIENT_TYPE_PC = 20;

const SALT_BY_SUBAPP = {
  pc: SALT_PC,
  client: SALT_CLIENT,
};

export function saltFor(subappType = 'pc') {
  return SALT_BY_SUBAPP[subappType] ?? SALT_OTHER;
}

/** 签名原文（去掉 sign 本身，也去掉 undefined 的键） */
export function signText(data, salt = SALT_PC) {
  const keys = Object.keys(data)
    .filter((k) => data[k] !== undefined && data[k] !== null)
    .sort();
  return keys.map((k) => `${k}=${data[k]}`).join('') + salt;
}

export function signOf(data, salt = SALT_PC) {
  return crypto.createHash('md5').update(signText(data, salt)).digest('hex');
}

/**
 * 补齐 PC 端公共参数并签名。
 * `tbs` 由调用方决定要不要带（GET 类接口不带，POST 表单类要带）。
 */
export function signRequest(data, { subappType = 'pc' } = {}) {
  const base = { ...data };
  delete base.sign;
  if (base.subapp_type === undefined) base.subapp_type = subappType;
  if (base._client_type === undefined) base._client_type = CLIENT_TYPE_PC;
  // 空值会被前端剔掉，这里保持一致，否则签出来的串和服务器算的不一样
  for (const k of Object.keys(base)) {
    if (base[k] === undefined || base[k] === null) delete base[k];
  }
  return { ...base, sign: signOf(base, saltFor(base.subapp_type)) };
}