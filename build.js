const esbuild = require("esbuild");

esbuild
	.build({
		entryPoints: ["src/index.ts"],
		bundle: true,
		sourcemap: true,
		target: "es2017",
		outdir: "dist",
		format: "esm",
		splitting: true,
		minify: false,
		external: ["react", "react-dom"], // 외부 디펜던시 제외
	})
	.catch(() => process.exit(1));
