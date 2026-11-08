const fs = require('fs')
const path = require('path')
const { echo } = require('shelljs')

const packageJsonPath = path.resolve(__dirname, '../../../package.json')
const versionHtmlPath = path.resolve(__dirname, '../../../data/version.html')

function bumpVersion () {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const currentVersion = pkg.version
  const parts = currentVersion.split('.').map(Number)

  // 如果是 3 段版本号（如 5.8.2），升级为 4 段（5.8.2.1）
  // 如果已经是 4 段（如 5.8.2.1），递增第 4 段（5.8.2.2）
  if (parts.length === 3) {
    parts.push(1)
  } else if (parts.length === 4) {
    parts[3]++
  } else {
    echo(`error: unexpected version format: ${currentVersion}`)
    process.exit(1)
  }

  const newVersion = parts.join('.')

  // 更新 package.json
  pkg.version = newVersion
  fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n')
  echo(`updated package.json: ${currentVersion} -> ${newVersion}`)

  // 更新 version.html（如果存在）
  if (fs.existsSync(versionHtmlPath)) {
    fs.writeFileSync(versionHtmlPath, newVersion)
    echo(`updated version.html: ${newVersion}`)
  }

  return newVersion
}

// 支持命令行调用：node bump-version.js
if (require.main === module) {
  const newVersion = bumpVersion()
  console.log(newVersion)
}

module.exports = { bumpVersion }
