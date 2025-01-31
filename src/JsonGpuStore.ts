import { IDBOptions } from "./types/StoreMetadata";
import { VramDataBase } from "./VramDataBase";
/**
 * WebGPU 디바이스를 요청하여 반환하는 유틸리티
 */
export async function getWebGpuDevice(): Promise<GPUDevice> {
	if (!("gpu" in navigator)) {
		throw new Error("WebGPU not supported in this environment.");
	}
	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) {
		throw new Error("Failed to get GPU adapter.");
	}
	return await adapter.requestDevice();
}

/**
 * JsonGpuStore: WebGPU 기반 JSON 데이터 관리 클래스
 */
export class JsonGpuStore<T extends object> {
	private vramDB: VramDataBase | null = null;
	private storeName: string;
	private key: string;
	private cache: T;
	private proxy: T;

	/**
	 * JsonGpuStore 생성자
	 * @param storeName 스토어 이름
	 * @param key 저장할 키 값
	 * @param initialData 초기 데이터 (JSON 형태)
	 */
	constructor(storeName: string, key: string, initialData: T) {
		this.storeName = storeName;
		this.key = key;
		this.cache = structuredClone(initialData);
		this.proxy = this.createProxy(this.cache);
	}

	public async init(options?: IDBOptions) {
		const device = await getWebGpuDevice();
		this.vramDB = new VramDataBase(device);
		await this.vramDB.initializeManager();
		this.vramDB.StoreManager.createObjectStore(
			this.storeName,
			options ?? {
				dataType: "JSON",
				bufferSize: 256 * 1024 * 1024,
				totalRows: 1,
			}
		);

		// 초기 데이터 저장
		this.vramDB.StoreManager.put(
			this.storeName,
			this.key,
			this.cache
		).catch(console.error);
	}

	/**
	 * JSON 데이터를 Proxy로 감싸서 관리하는 함수
	 */
	private createProxy(obj: any, path: string[] = []): T {
		if (obj && typeof obj === "object") {
			return new Proxy(obj, {
				get: (target, prop, receiver) => {
					if (prop === "__isProxy") return true;
					const value = Reflect.get(target, prop, receiver);

					if (
						value &&
						typeof value === "object" &&
						!value.__isProxy
					) {
						const newPath = path.concat(String(prop));
						const proxied = this.createProxy(value, newPath);
						Reflect.set(target, prop, proxied, receiver);
						return proxied;
					}
					return value;
				},
				set: (target, prop, newValue, receiver) => {
					Reflect.set(target, prop, newValue, receiver);

					this.vramDB!.StoreManager.put(
						this.storeName,
						this.key,
						this.cache
					).catch((err: any) =>
						console.error("VramDataBase put error:", err)
					);
					return true;
				},
			});
		}
		return obj;
	}

	/**
	 * Proxy 객체 반환 (사용자는 이 Proxy를 직접 조작하면 VRAM에도 반영됨)
	 */
	public getProxy(): T {
		return this.proxy;
	}
}
