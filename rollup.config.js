import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";
import obfuscator from "rollup-plugin-obfuscator";
import dynamicImport from "rollup-plugin-dynamic-import-variables";

export default [
	{
		input: "src/index.ts",
		output: {
			dir: "dist",
			format: "esm",
			sourcemap: true,
			preserveModules: true, // 모듈 구조 유지
			preserveModulesRoot: "src",
			entryFileNames: "[name].js", // 파일명 유지
		},
		plugins: [
			resolve(),
			commonjs(),
			typescript(),
			/*terser({
				compress: { drop_console: true, drop_debugger: true },
				output: { comments: false },
			})*/
			,
		],
		external: ["react", "core-js", "react-dom"],
	}, // CJS 번들
	{
		input: "src/index.ts",
		output: {
			dir: "dist",
			format: "cjs",
			sourcemap: true,
			preserveModules: true, // 모듈 유지
			preserveModulesRoot: "src",
			entryFileNames: "[name].cjs.js",
		},
		plugins: [
			resolve(),
			commonjs(),
			typescript(),
			/*terser({
				compress: { drop_console: true, drop_debugger: true },
				output: { comments: false },
			})*/
			,
		],
		external: ["react", "core-js", "react-dom"],
	},
];
