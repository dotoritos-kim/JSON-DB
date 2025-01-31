import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";
import obfuscator from "rollup-plugin-obfuscator";
export default {
	input: "src/index.ts", // 엔트리 파일
	output: {
		dir: "dist", // ⚠️ output.file 대신 output.dir 사용
		format: "esm",
		sourcemap: true,
		preserveModules: true, // 개별 모듈을 유지 (필요 시)
		entryFileNames: "[name].js", // 파일 이름 패턴 설정
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
			compact: true, // 코드 압축
			controlFlowFlattening: true, // 제어 흐름 플래튼화
			controlFlowFlatteningThreshold: 1, // 제어 흐름 플래튼화 적용 확률
			deadCodeInjection: true, // 죽은 코드 삽입
			deadCodeInjectionThreshold: 1, // 죽은 코드 삽입 확률
			stringArray: true, // 문자열을 배열로 변환
			stringArrayEncoding: ["base64"], // Base64로 문자열 인코딩
			stringArrayThreshold: 1, // 모든 문자열을 배열로 변환
			disableConsoleOutput: true, // console.log 등 출력 제거
			renameGlobals: true, // 전역 변수 이름 변경
			identifierNamesGenerator: "mangled", // 변수 및 함수명을 짧고 의미 없는 이름으로 변경
		}),
	],
	external: (id) => /^react/.test(id), // React 관련 패키지만 외부로 설정
};
