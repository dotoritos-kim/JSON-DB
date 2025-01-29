module.exports = {
	launch: {
		headless: false, // 필요 시 true로 변경. 일부 Chrome 버전은 headless에서 WebGPU 제한이 있을 수 있음
		defaultViewport: null,
		args: [
			"--enable-unsafe-webgpu", // 크롬에서 WebGPU 활성화 (버전에 따라 생략 가능)
			"--no-sandbox",
			"--disable-setuid-sandbox",
			// "--headless=new", // 최신 크롬에서 headless + WebGPU를 사용하려면(베타 기능)
		],
	},
};
