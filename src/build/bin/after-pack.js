/**
 * electron-builder afterPack 钩子：补齐 node-pty 的 conpty 运行库
 *
 * 打包阶段 electron-builder 会对 app 目录执行 node-gyp rebuild
 * （见 app-builder-lib/out/util/yarn.js），rebuild 等于 clean + configure + build，
 * 整个 build/ 目录会被清空重建；node-pty 的 postinstall 此时不会重跑，
 * 于是 build/Release/conpty/conpty.dll 消失。
 *
 * 而 node-pty 1.2.0-beta.15 的 src/win/conpty.cc 用 GetModuleFileNameW(conpty.node)
 * 取出 .node 自身所在目录，再硬编码拼接 "conpty\conpty.dll" 加载动态库，
 * 运行时找不到该 DLL 就会抛
 * "Cannot find conpty.dll ... error code: 3"，连接本地终端直接失败。
 *
 * 本钩子在 asar 打包完成之后触发（platformPackager.copyAppFiles -> emitAfterPack），
 * 把 conpty.dll 与 OpenConsole.exe 补进
 * app.asar.unpacked/node_modules/node-pty/build/Release/conpty/。
 *
 * @author xiaogui
 * @since 2026-11-16 12:19:33
 */

const fs = require('fs')
const path = require('path')

const CONPTY_FILES = ['conpty.dll', 'OpenConsole.exe']

/**
 * 收集 node-pty 内 conpty 运行库的候选来源目录
 *
 * @author xiaogui
 * @since 2026-11-16 12:19:58
 * @param {string} ptyRoot node-pty 包目录
 * @param {string} prebuildPlatform 形如 win32-x64 的预编译平台标识
 * @returns {string[]} 实际存在的候选来源目录
 */
function collectConptySourceDirs (ptyRoot, prebuildPlatform) {
  const dirs = []
  const prebuilt = path.join(ptyRoot, 'prebuilds', prebuildPlatform, 'conpty')
  if (fs.existsSync(prebuilt)) {
    dirs.push(prebuilt)
  }
  const thirdParty = path.join(ptyRoot, 'third_party', 'conpty')
  if (fs.existsSync(thirdParty)) {
    for (const ver of fs.readdirSync(thirdParty)) {
      const winDir = path.join(thirdParty, ver, 'win10-x64')
      if (fs.existsSync(winDir)) {
        dirs.push(winDir)
      }
    }
  }
  return dirs
}

/**
 * 定位打包产物中 app.asar.unpacked 目录
 *
 * @author xiaogui
 * @since 2026-11-16 12:20:21
 * @param {string} appOutDir electron-builder 的应用输出目录
 * @returns {string} app.asar.unpacked 目录
 */
function resolveUnpackedDir (appOutDir) {
  const macDir = path.join(appOutDir, 'Electron.app', 'Contents', 'Resources')
  const resourcesDir = fs.existsSync(macDir)
    ? macDir
    : path.join(appOutDir, 'resources')
  return path.join(resourcesDir, 'app.asar.unpacked')
}

/**
 * 把 conpty 运行库复制到产物的 node-pty/build/Release/conpty 目录
 *
 * @author xiaogui
 * @since 2026-11-16 12:20:47
 * @param {string} unpackedDir app.asar.unpacked 目录
 * @param {string} ptyRoots node-pty 候选包目录
 * @param {string} prebuildPlatform 形如 win32-x64 的预编译平台标识
 * @returns {boolean} 是否复制成功
 */
function copyConptyRuntime (unpackedDir, ptyRoots, prebuildPlatform) {
  const destDir = path.join(
    unpackedDir, 'node_modules', 'node-pty', 'build', 'Release', 'conpty'
  )
  for (const ptyRoot of ptyRoots) {
    if (!fs.existsSync(ptyRoot)) {
      continue
    }
    for (const source of collectConptySourceDirs(ptyRoot, prebuildPlatform)) {
      if (!CONPTY_FILES.every(f => fs.existsSync(path.join(source, f)))) {
        continue
      }
      fs.mkdirSync(destDir, { recursive: true })
      for (const file of CONPTY_FILES) {
        fs.copyFileSync(path.join(source, file), path.join(destDir, file))
      }
      console.log(`  • afterPack: copy ${source} -> ${destDir}`)
      return true
    }
  }
  return false
}

/**
 * electron-builder afterPack 钩子入口
 *
 * @author xiaogui
 * @since 2026-11-16 12:21:10
 * @param {object} context electron-builder 打包上下文
 * @returns {Promise<void>} 打包完成后执行
 */
module.exports = async function afterPack (context) {
  if (process.platform !== 'win32') {
    return
  }
  const projectDir = (context.packager && context.packager.projectDir) ||
    process.cwd()
  const ptyRoots = [
    path.join(projectDir, 'work', 'app', 'node_modules', 'node-pty'),
    path.join(process.cwd(), 'work', 'app', 'node_modules', 'node-pty'),
    path.join(process.cwd(), 'node_modules', 'node-pty')
  ]
  const unpackedDir = resolveUnpackedDir(context.appOutDir)
  const ok = copyConptyRuntime(unpackedDir, ptyRoots, 'win32-x64')
  if (!ok) {
    throw new Error(
      `afterPack: conpty.dll / OpenConsole.exe not found, cannot patch ${unpackedDir}`
    )
  }
}
