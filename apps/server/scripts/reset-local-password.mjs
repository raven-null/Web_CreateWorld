/**
 * 本地开发用：重置某个用户的登录密码（生成可执行的 SQL）。
 *
 * 为什么需要它：better-auth 的密码是 scrypt 哈希，**必须用项目自己的哈希函数生成**
 * （`better-auth/crypto` 的 `hashPassword`），手写 SQL 或换算法写进 `account.password`
 * 会导致登录时校验失败。所以这个脚本解决的是「忘了本地账号密码」这一种情形。
 *
 * 用法（在仓库根目录执行）：
 *   node apps/server/scripts/reset-local-password.mjs <用户名> <新密码>
 *
 * 输出：一段 UPDATE 语句（只含哈希、不含明文），交给 wrangler 写入本地库：
 *   pnpm --filter @create-world/server exec wrangler d1 execute DB --local --file <文件>
 *
 * 注意：
 * - **只用于本地开发库**（`--local`）。生产环境应走管理后台的重置流程，
 *   不要把生产库的哈希打印到终端或写进文件。
 * - 脚本必须放在 apps/server 下：`better-auth` 装在该包内，
 *   放在仓库根目录会因 Node 模块解析不到而失败。
 */
import { hashPassword } from "better-auth/crypto";

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error("用法：node apps/server/scripts/reset-local-password.mjs <用户名> <新密码>");
  process.exit(1);
}

const normalized = username.trim().toLowerCase();
if (!/^[a-z][a-z0-9_]{2,23}$/.test(normalized)) {
  console.error("用户名不符合规范（3-24 位，字母开头，仅含字母数字下划线）");
  process.exit(1);
}

const hash = await hashPassword(password);
// 只输出 SQL：明文不进入输出、命令历史或日志
console.log(
  `UPDATE account SET password = '${hash}' WHERE providerId = 'credential' AND userId = (SELECT id FROM user WHERE username = '${normalized}');`,
);
