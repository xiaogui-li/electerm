/**
 * prepare the files to be packed
 */

const pack = require('../../../package.json')
const os = require('os')
const fs = require('fs')
const { resolve, join } = require('path')
const { version } = pack
const { mkdir, rm, exec, echo, cp } = require('shelljs')
const dir = 'dist/v' + version
const cwd = process.cwd()

const platform = os.platform()
const isWin = platform === 'win32'

/**
 * 收集 node-pty 内 conpty 运行库的候选来源目录
 *
 * node-pty 1.2.0-beta.15 的 src/win/conpty.cc 用 GetModuleFileNameW(conpty.node)
 * 取出 .node 自身所在目录，再硬编码拼接 "conpty\conpty.dll" 去加载动态库，
 * 因此 conpty.dll 与 OpenConsole.exe 必须和 conpty.node 处在同一目录树下。
 *
 * @author xiaogui
 * @since 2026-11-16 12:18:15
 * @param {string} ptyRoot node-pty 包目录
 * @param {string} prebuildPlatform 形如 win32-x64 的预编译平台标识
 * @returns {string[]} 实际存在的候选来源目录
 */
function collectConptySourceDirs (ptyRoot, prebuildPlatform) {
  const dirs = []
  const prebuilt = join(ptyRoot, 'prebuilds', prebuildPlatform, 'conpty')
  if (fs.existsSync(prebuilt)) {
    dirs.push(prebuilt)
  }
  const thirdParty = join(ptyRoot, 'third_party', 'conpty')
  if (fs.existsSync(thirdParty)) {
    for (const ver of fs.readdirSync(thirdParty)) {
      const winDir = join(thirdParty, ver, 'win10-x64')
      if (fs.existsSync(winDir)) {
        dirs.push(winDir)
      }
    }
  }
  return dirs
}

/**
 * 把 conpty 运行库复制到 node-pty 的 build/Release/conpty 目录
 *
 * 不依赖 node-pty 自带的 postinstall：npm 脚本白名单会跳过安装脚本，
 * 而 yarn autoclean 又会删掉 third_party，两种情况都会让 DLL 缺失。
 *
 * @author xiaogui
 * @since 2026-11-16 12:18:41
 * @param {string} ptyRoot node-pty 包目录
 * @param {string} prebuildPlatform 形如 win32-x64 的预编译平台标识
 * @returns {boolean} 是否复制成功
 */
function copyConptyRuntime (ptyRoot, prebuildPlatform) {
  const files = ['conpty.dll', 'OpenConsole.exe']
  const destDir = join(ptyRoot, 'build', 'Release', 'conpty')
  for (const source of collectConptySourceDirs(ptyRoot, prebuildPlatform)) {
    if (!files.every(f => fs.existsSync(join(source, f)))) {
      continue
    }
    fs.mkdirSync(destDir, { recursive: true })
    for (const file of files) {
      fs.copyFileSync(join(source, file), join(destDir, file))
    }
    echo(`copy conpty runtime: ${source} -> ${destDir}`)
    return true
  }
  return false
}

pack.main = 'app.js'
delete pack.scripts
delete pack.standard
delete pack.files
delete pack.engines
delete pack.preferGlobal

if (isWin) {
  delete pack.dependencies['node-bash']
} else {
  delete pack.dependencies['node-powershell']
}

echo('start pack prepare')
// echo('install test deps')
// exec(`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i -D -E playwright@1.28.1 --no-save && npm i -D -E @playwright/test@1.28.1 --no-save`)
const timeStart = +new Date()
rm('-rf', dir)
rm('-rf', 'dist/latest')

mkdir('-p', dir)
mkdir('-p', 'dist/latest')
cp('-r', 'src/app', 'work/')
// Legacy builds (Electron < 25: the 22.3.27 jobs) get their shims injected
// here, into work/app only. Modern builds copy src/app as-is.
require('./inject-polyfills').main()
rm('-rf', 'work/app/user-config.json')
rm('-rf', 'work/app/localstorage.json')
rm('-rf', 'work/app/nohup.out')
rm('-rf', 'work/app/assets/js/index*')
rm('-rf', 'work/app/assets/js/*.txt')
rm('-rf', 'node_modules/cpu-features')

require('fs').writeFileSync(
  resolve(__dirname, '../../../work/app/package.json'),
  JSON.stringify(
    pack, null, 2
  )
)

// 强制干净重装 node-pty。
// 背景：fork 曾把 node-pty 声明为 registry 上并不存在的 1.1.0-beta14，npm i 必然失败；
// 旧代码用 shelljs exec() 静默吞掉失败，于是留下 1.1.0/1.2.0 混装的
// node_modules/node-pty（scripts/ 属旧版、prebuilds 与 src 属新版），
// 旧版 scripts/post-install.js 只清理不搬运 conpty.dll，最终产物缺少
// conpty\conpty.dll，运行时连接本地终端报
// "Cannot find conpty.dll ... error code: 3"。
// 这里先删干净再装，且安装失败立即中止，不再静默继续。
rm('-rf', 'work/app/node_modules/node-pty')
const npmResult = exec(`cd work/app && npm i --omit=dev && cd ${cwd}`)
if (npmResult.code !== 0) {
  echo(`ERROR: npm install failed with exit code ${npmResult.code}`)
  process.exit(1)
}

rm('-rf', 'work/app/node_modules/.bin')
// Remove axios browser/ESM builds and unnecessary files (keep only lib/ and node CJS)
rm('-rf', 'work/app/node_modules/axios/dist/esm')
rm('-rf', 'work/app/node_modules/axios/dist/browser')
rm('-rf', 'work/app/node_modules/axios/dist/*.js')
rm('-rf', 'work/app/node_modules/axios/dist/*.map')
rm('-rf', 'work/app/node_modules/axios/dist/node/*.map')
rm('-rf', 'work/app/node_modules/axios/index.d.cts')
rm('-rf', 'work/app/node_modules/axios/lib')

// Remove cpu-features after npm prune to prevent rebuild issues
rm('-rf', 'node_modules/cpu-features')
rm('-rf', 'work/app/node_modules/cpu-features')

// Clean up node-pty platform-specific files to reduce bundle size
if (isWin) {
  // On Windows, remove Unix-specific files
  rm('-rf', 'work/app/node_modules/node-pty/lib/unixTerminal.js')
  rm('-rf', 'work/app/node_modules/node-pty/lib/unixTerminal.js.map')
  rm('-rf', 'work/app/node_modules/node-pty/lib/unixTerminal.test.js')
  rm('-rf', 'work/app/node_modules/node-pty/lib/unixTerminal.test.js.map')
  rm('-rf', 'work/app/node_modules/node-pty/build/pty.target.mk')
  rm('-rf', 'work/app/node_modules/node-pty/build/spawn-helper.target.mk')
  rm('-rf', 'work/app/node_modules/node-pty/build/binding.Makefile')
  rm('-rf', 'work/app/node_modules/node-pty/build/gyp-mac-tool')
} else {
  // On Linux/Mac, remove Windows-specific files
  rm('-rf', 'work/app/node_modules/node-pty/lib/conpty_console_list_agent.js')
  rm('-rf', 'work/app/node_modules/node-pty/lib/conpty_console_list_agent.js.map')
  rm('-rf', 'work/app/node_modules/node-pty/lib/windowsConoutConnection.js')
  rm('-rf', 'work/app/node_modules/node-pty/lib/windowsConoutConnection.js.map')
  rm('-rf', 'work/app/node_modules/node-pty/lib/windowsPtyAgent.js')
  rm('-rf', 'work/app/node_modules/node-pty/lib/windowsPtyAgent.js.map')
  rm('-rf', 'work/app/node_modules/node-pty/lib/windowsPtyAgent.test.js')
  rm('-rf', 'work/app/node_modules/node-pty/lib/windowsPtyAgent.test.js.map')
  rm('-rf', 'work/app/node_modules/node-pty/lib/windowsTerminal.js')
  rm('-rf', 'work/app/node_modules/node-pty/lib/windowsTerminal.js.map')
  rm('-rf', 'work/app/node_modules/node-pty/lib/windowsTerminal.test.js')
  rm('-rf', 'work/app/node_modules/node-pty/lib/windowsTerminal.test.js.map')
  rm('-rf', 'work/app/node_modules/node-pty/deps/winpty')
}

// Remove all test files from node-pty to reduce bundle size
rm('-rf', 'work/app/node_modules/node-pty/lib/*.test.js')
rm('-rf', 'work/app/node_modules/node-pty/lib/*.test.js.map')
rm('-rf', 'work/app/node_modules/node-pty/lib/testUtils.test.js')
rm('-rf', 'work/app/node_modules/node-pty/lib/testUtils.test.js.map')

// 去掉 node-pty 对 Spectre 缓解库的依赖。
// node-pty 1.2.0-beta.15 的 binding.gyp 在 msvs_configuration_attributes 里声明了
// 'SpectreMitigation': 'Spectre'，而本机 Visual Studio Build Tools 没装 Spectre
// 缓解库，electron-builder 打包阶段的 node-gyp rebuild 会直接报
// "error MSB8040: 此项目需要缓解了 Spectre 漏洞的库" 而中断。
// 必须在 npm i 之后打补丁：npm 重装 node-pty 会把 binding.gyp 还原。
const ptyBindingGyp = resolve(cwd, 'work/app/node_modules/node-pty/binding.gyp')
if (fs.existsSync(ptyBindingGyp)) {
  const bindingContent = fs.readFileSync(ptyBindingGyp, 'utf8')
  const patchedBinding = bindingContent.replace(
    /'msvs_configuration_attributes':\s*\{\s*'SpectreMitigation':\s*'Spectre'\s*\},?\s*/,
    ''
  )
  if (patchedBinding !== bindingContent) {
    fs.writeFileSync(ptyBindingGyp, patchedBinding, 'utf8')
    echo('patch node-pty binding.gyp: remove SpectreMitigation')
  }
}

// 补齐 conpty 运行库。
// node-pty 自带的 postinstall 未必会执行（npm 脚本白名单会跳过安装脚本，
// 而下面的 yarn autoclean 又会删掉 third_party），缺失时本地终端无法连接。
if (isWin) {
  const ptyRoot = resolve(cwd, 'work/app/node_modules/node-pty')
  if (!copyConptyRuntime(ptyRoot, 'win32-x64')) {
    echo('ERROR: conpty.dll / OpenConsole.exe not found in node-pty')
    process.exit(1)
  }
}

// yarn auto clean
cp('-r', 'src/build/bin/.yarnclean', 'work/app/')
exec(`cd work/app && yarn generate-lock-entry > yarn.lock && yarn autoclean --force && cd ${cwd}`)
rm('-rf', 'work/app/.yarnclean')
rm('-rf', 'work/app/package-lock.json')
rm('-rf', 'work/app/yarn.lock')
require('./clean-empty-folders').main()

const endTime = +new Date()
echo(`done pack prepare in ${(endTime - timeStart) / 1000} s`)
