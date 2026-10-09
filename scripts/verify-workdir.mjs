// 验收脚本的工作目录：**每个脚本固定一个路径，跑完自己擦掉**。
//
// 以前每次运行都新开 `loomark-verify-xxx-<时间戳>`，连跑几轮下来 Caches 里躺了十几个
// profile、两百多兆（2026-10-06 用户问「真的有必要开这么多 profile 吗」）。用户是在
// 自己机器上干活的，测试不该在任何地方留下残渣：同一个脚本复用同一个目录，开跑前先擦
// 干净（上一次被强杀留下的也在这一步清掉），退出时再擦一次。
//
// profile 不能所有脚本共用一份：localStorage 里存着主题、列宽这些偏好，串起来会让
// 「换个脚本跑就换了初始状态」的假红。所以是每个脚本一份，而不是全仓一份。
//
// 来源：上游 colamd `scripts/verify-workdir.mjs`（1c94cea）。差别只有标记词：
// 我们的验证进程是 Tauri 二进制，靠 `COLAMD_VERIFY` 环境变量认领，所以按标记杀进程
// 匹配的是工作目录路径，用法与上游一致。
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * 工作目录的根。
 *
 * 默认还是 `~/Library/Caches/loomark-verify`，正常跑不会变。`COLAMD_VERIFY_WORKDIR`
 * 是给**跑不动**这一条路留的：沙箱里（或任何写不了 Caches 的环境里）脚本连建目录都会
 * EPERM，整个验收一项都跑不了。指到别处就能照常跑，判定与报告完全一样。
 * 指到哪，`stopVerifyApp` 的标记就跟着变，回收进程的那条路不会因此失手。
 */
const ROOT = process.env.COLAMD_VERIFY_WORKDIR || join(homedir(), 'Library', 'Caches', 'loomark-verify')

function wipe(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
    // 连根目录也一起收掉：跑完一轮，Caches 里一点痕迹都不该留下
    if (path !== ROOT) rmSync(ROOT, { recursive: false, force: true })
  } catch {
    // 删不掉不致命：下次开跑第一步还是擦它
  }
}

/**
 * 按标记结束测试用的应用进程，先 SIGTERM 再 SIGKILL。
 *
 * 为什么要按路径杀而不是 `process.kill(-child.pid)`：脚本自己被强杀（timeout、
 * Ctrl-C、我手滑）时那个 finally 根本不会跑到，窗口虽然是离屏的，进程照样挂在
 * 机器上。2026-10-06 用户看见「还开着七个 app」，清出来 42 个进程，最早的是当天早上
 * 的探针。杀完再确认一次，所以这里连 SIGKILL 都要来一遍。
 *
 * ⚠️ `pkill -f` 是**子串匹配**：标记之间不能互为前缀，否则一个脚本会误杀另一个
 * （上游 fa87e86：`udd` 会命中 `udd-cheatsheet`，verify:features 的两扇窗口因此
 * 互杀，脚本静默 exit 0 且无输出）。所以下面的目录名都带各自的后缀，没有谁是谁的前缀。
 */
export function stopVerifyApp(marker = ROOT) {
  for (const signal of ['-TERM', '-KILL']) {
    spawnSync('pkill', [signal, '-f', marker], { stdio: 'ignore' })
  }
}

export function verifyWorkdir(name) {
  const dir = join(ROOT, name)
  // 只擦自己名下这一格，别碰 Caches 里别人的东西
  if (!dir.startsWith(`${ROOT}/`)) throw new Error(`工作目录必须落在 ${ROOT} 下：${dir}`)
  // 上一轮要是被强杀了，先把它的进程收掉，再擦目录：不然进程还占着文件
  stopVerifyApp(ROOT)
  wipe(dir)
  mkdirSync(dir, { recursive: true })
  process.on('exit', () => wipe(dir))
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      wipe(dir)
      process.exit(1)
    })
  }
  // 主 profile 叫 udd-main 而不是 udd：按标记杀进程是子串匹配，`udd` 会连
  // `udd-cheatsheet` 一起命中。verify:features 同时开两扇窗口，那样会误杀。
  return { dir, udd: join(dir, 'udd-main') }
}
