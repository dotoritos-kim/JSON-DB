import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";
import obfuscator from "rollup-plugin-obfuscator";

export default [
	{
		input: "src/index.ts",
		output: {
			dir: "dist",
			format: "esm",
			sourcemap: true,
			preserveModules: false,
			entryFileNames: "index.js",
		},
		plugins: [
			resolve(),
			commonjs(),
			typescript(),
			terser({
				compress: { drop_console: true, drop_debugger: true },
				output: { comments: false },
			}),
			obfuscator({
				compact: true,
				controlFlowFlattening: false, //  제어 흐름 난독화 제거
				deadCodeInjection: false, //  불필요한 코드 삽입 제거
				stringArray: true,
				stringArrayEncoding: ["base64"],
				stringArrayThreshold: 0.75,
				disableConsoleOutput: true,
				renameGlobals: false, //  글로벌 변수 변경 비활성화
				identifierNamesGenerator: "hexadecimal", //  "mangled" 대신 "hexadecimal" 사용
			}),
		],
		external: ["react"],
	}, // CJS 번들
	{
		input: "src/index.ts",
		output: {
			dir: "dist",
			format: "cjs",
			sourcemap: true,
			preserveModules: false,
			entryFileNames: "index.cjs.js",
		},
		plugins: [
			resolve(),
			commonjs(),
			typescript(),
			terser({
				compress: { drop_console: true, drop_debugger: true },
				output: { comments: false },
			}),
		],
		external: ["react"],
	},
];
