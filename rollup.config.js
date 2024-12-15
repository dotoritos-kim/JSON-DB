import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";
import obfuscator from "rollup-plugin-obfuscator";
export default {
	input: "src/index.ts", // 엔트리 파일
	output: [
		{
			file: "dist/index.cjs.js", // CommonJS 출력
			format: "cjs",
			sourcemap: true,
		},
		{
			file: "dist/index.esm.js", // ESM 출력
			format: "esm",
			sourcemap: true,
		},
		{
			file: "dist/bundle.min.js",
			format: "esm",
			plugins: [
				terser({
					compress: {
						drop_console: true, // console.log 제거
						drop_debugger: true, // debugger 제거
					},
					mangle: {
						toplevel: true, // 최상위 스코프의 변수명도 난독화
					},
					output: {
						comments: false, // 주석 제거
					},
				}),
			],
		},
	],
	plugins: [
		resolve(), // Node.js 모듈 해석
		commonjs(), // CommonJS 모듈 변환
		typescript(), // TypeScript 컴파일

		obfuscator({
			compact: true,
			controlFlowFlattening: true, // 제어 흐름 난독화
			deadCodeInjection: true, // 죽은 코드 삽입
			debugProtection: true, // 디버깅 방지
			stringArray: true, // 문자열 난독화
			stringArrayThreshold: 0.75, // 문자열 난독화 비율
		}),
	],
	external: ["react"], // 외부 의존성 제외
};
