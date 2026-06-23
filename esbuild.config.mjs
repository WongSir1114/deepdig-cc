import esbuild from 'esbuild';
import process from 'process';

const prod = process.argv.includes('production');
const watch = process.argv.includes('watch');

/** @type {import('esbuild').BuildOptions} */
const opts = {
  entryPoints: ['main.ts'],
  bundle: true,
  outfile: 'main.js',
  external: ['obsidian', 'electron', 'child_process', 'fs', 'path'],
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  sourcemap: prod ? false : 'inline',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('👁️  监听中...');
} else {
  await esbuild.build(opts);
  console.log('✅ 构建完成');
}
