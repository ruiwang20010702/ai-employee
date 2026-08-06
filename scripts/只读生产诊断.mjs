import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { checkProductionReadiness } from "../src/production-readiness.mjs";

await applyProductionConfigFile();
const config = loadConfig({ production: true });
try {
  const result = await checkProductionReadiness({ config });
  console.log(
    JSON.stringify(
      {
        ...result,
        databaseWrite: false,
        note: "配置、运行时、项目清单、数据库连接和结构兼容性均已通过；未执行迁移。",
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (!String(error.code ?? "").startsWith("database_")) throw error;
  console.error(JSON.stringify({
    ready: false,
    databaseWrite: false,
    errorCode: error.code,
    migrations: error.migrations ?? [],
    action: error.code === "database_migration_checksum_mismatch"
      ? "停止发布且不要执行迁移；恢复与已发布版本一致的迁移文件后重新诊断。"
      : "先完成备份，再通过受控发布流程执行 npm run db:migrate。",
  }, null, 2));
  process.exitCode = 1;
}
