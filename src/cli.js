#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { analyze } from "./index.js";

// 用法: node src/cli.js <input.json> [output.json]
// 纯离线处理：从文件读历史指标，结果写 stdout 或指定文件。
async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath) {
    process.stderr.write("用法: node src/cli.js <input.json> [output.json]\n");
    process.exitCode = 1;
    return;
  }

  const raw = await readFile(inputPath, "utf8");
  const result = analyze(JSON.parse(raw));
  const rendered = `${JSON.stringify(result, null, 2)}\n`;

  if (outputPath) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputPath, rendered);
    process.stderr.write(`离线分析完成，结果已写入 ${outputPath}\n`);
  } else {
    process.stdout.write(rendered);
  }
}

main().catch((error) => {
  process.stderr.write(`离线分析失败: ${error.message}\n`);
  process.exitCode = 1;
});
