// jest.config.cjs
module.exports = {
	preset: "ts-jest",
	testEnvironment: "jsdom",
	setupFiles: ["fake-indexeddb/auto"],
	setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
	moduleNameMapper: {
		"\\.(css|less|scss|sass)$": "identity-obj-proxy",
	},
	transform: {
		"^.+\\.tsx?$": "ts-jest",
	},
	moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
};
