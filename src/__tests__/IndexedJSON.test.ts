import { IndexedJSON } from "..";
import { IndexedDBWrapper } from "../IndexedDBWrapper";

describe("IndexedJSON", () => {
	const dbName = "testDB";
	const storeName = "testStore";

	interface TestData {
		foo: {
			bar: number;
		};
		count?: number;
	}

	let indexedJSON: IndexedJSON;

	beforeEach(() => {
		indexedJSON = new IndexedJSON(dbName, storeName);
	});

	afterEach(() => {
		indexedDB.deleteDatabase(dbName);
	});

	test("create should initialize the database and return a proxy with default data", async () => {
		const defaultData: TestData = { foo: { bar: 1 } };

		const proxy = await indexedJSON.create<TestData>(() => defaultData);

		// 비동기로 값을 가져오도록 수정
		const jsonValue = await proxy.toJSON();
		console.log(jsonValue); // { foo: { bar: 1 } }

		// foo와 bar에 접근할 때 await 추가
		const foo = await proxy.foo;
		const bar = await foo.bar;
		console.log(bar); // 1

		// 테스트도 비동기적으로 값 비교
		expect(bar).toBe(1);
	});
});
