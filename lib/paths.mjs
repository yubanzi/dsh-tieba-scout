// 运行数据放哪。
//
// 插件包目录只放代码；cookie / 配置 / 笔记 / 日志全在 `$DSH_HOME/tieba-scout/`。
// 卸载插件不会删这些文件，重装还能接着用。
import os from 'node:os';
import path from 'node:path';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function dataDir() {
  return path.join(dshHome(), 'tieba-scout');
}

export function sub(...parts) {
  return path.join(dataDir(), ...parts);
}