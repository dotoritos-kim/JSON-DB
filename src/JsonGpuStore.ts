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
const PROXY_FLAG = Symbol("isProxy");

export interface JsonGpuStoreOptions {
	debounce?: boolean; // true면 디바운싱, false면 즉시 업데이트 (기본값: true)
}

export class JsonGpuStore<T extends object> {
	private vramDB: VramDataBase | null = null;
	private storeName: string;
	private key: string;
	// 내부 캐시: 최초에는 초기 데이터를 복제한 객체를 보관합니다.
	private cache: T | object;
	private proxy: T;
	// 해당 레코드가 VRAM에 등록되었는지 여부 플래그
	private recordAdded: boolean = false;

	// 디바운싱 처리를 위한 플래그와 옵션
	private updateScheduled: boolean = false;
	private useDebounce: boolean;

	/**
	 * JsonGpuStore 생성자
	 * @param storeName 스토어 이름
	 * @param key 저장할 키 값
	 * @param initialData 초기 데이터 (JSON 형태)
	 * @param options 추가 옵션 (debounce: true|false)
	 */
	constructor(
		storeName: string,
		key: string,
		initialData: T,
		options?: JsonGpuStoreOptions
	) {
		this.storeName = storeName;
		this.key = key;
		this.cache = structuredClone(initialData);
		this.proxy = this.createProxy(this.cache);
		this.useDebounce = options?.debounce ?? true;
	}

	/**
	 * 초기화: WebGPU 디바이스 획득 및 VRAM 데이터베이스 객체 생성 후,
	 * StoreManager.add()를 통해 최초 데이터를 등록합니다.
	 */
	public async init(options?: IDBOptions) {
		const device = await getWebGpuDevice();
		this.vramDB = new VramDataBase(device);
		this.vramDB.StoreManager.createObjectStore(
			this.storeName,
			options ?? {
				dataType: "JSON",
				bufferSize: 256 * 1024 * 1024,
				totalRows: 1,
			}
		);

		// 최초 데이터를 add()로 VRAM에 등록
		await this.vramDB.StoreManager.add(
			this.storeName,
			this.key,
			this.cache
		).catch(console.error);
		this.recordAdded = true;
	}

	/**
	 * 내부 업데이트를 디바운싱하여 예약하거나, 옵션에 따라 즉시 업데이트합니다.
	 * 이미 등록된 레코드라면 put()을 호출합니다.
	 */
	private scheduleUpdate() {
		if (!this.vramDB) return;

		const updateFn = () => {
			if (!this.recordAdded) {
				// 최초 등록되지 않은 경우 add()를 호출
				this.vramDB!.StoreManager.add(
					this.storeName,
					this.key,
					this.cache
				).catch((err: any) =>
					console.error("VramDataBase add error:", err)
				);
				this.recordAdded = true;
			} else {
				// 이미 등록된 경우 put()을 통해 업데이트
				this.vramDB!.StoreManager.put(
					this.storeName,
					this.key,
					this.cache
				).catch((err: any) =>
					console.error("VramDataBase put error:", err)
				);
			}
			this.updateScheduled = false;
		};

		if (this.useDebounce) {
			if (!this.updateScheduled) {
				this.updateScheduled = true;
				queueMicrotask(updateFn);
			}
		} else {
			updateFn();
		}
	}

	/**
	 * JSON 데이터를 프록시로 감싸 관리하는 함수 (개선된 버전)
	 * - 재귀적으로 중첩 객체에 대해 proxy를 생성합니다.
	 * - 새로 설정되는 객체도 자동으로 프록시 처리합니다.
	 * - 변경 시 scheduleUpdate()를 호출하여 VRAM에 반영합니다.
	 */
	private createProxy(obj: any, path: string[] = []): T {
		if (obj && typeof obj === "object") {
			const self = this;
			return new Proxy(obj, {
				get(target, prop, receiver) {
					if (prop === PROXY_FLAG) return true;
					const value = Reflect.get(target, prop, receiver);
					if (
						value &&
						typeof value === "object" &&
						!value[PROXY_FLAG]
					) {
						const proxiedValue = self.createProxy(
							value,
							path.concat(String(prop))
						);
						Reflect.set(target, prop, proxiedValue, receiver);
						return proxiedValue;
					}
					return value;
				},
				set(target, prop, newValue, receiver) {
					if (
						newValue &&
						typeof newValue === "object" &&
						!newValue[PROXY_FLAG]
					) {
						newValue = self.createProxy(
							newValue,
							path.concat(String(prop))
						);
					}
					const result = Reflect.set(
						target,
						prop,
						newValue,
						receiver
					);
					self.scheduleUpdate();
					return result;
				},
				deleteProperty(target, prop) {
					const result = Reflect.deleteProperty(target, prop);
					self.scheduleUpdate();
					return result;
				},
			});
		}
		return obj;
	}

	/**
	 * 프록시 객체를 반환합니다.
	 * (내부 캐시가 proxy로 감싸져 있으므로, 사용자가 이를 변경하면 업데이트가 VRAM에 반영됩니다.)
	 */
	public getProxy(): T {
		return this.proxy;
	}

	/**
	 * VRAM에 저장된 최신 데이터를 읽어온 후, 내부 캐시를 'detach'합니다.
	 * 이후 proxy는 더 이상 로컬 데이터(복제본)를 보관하지 않고,
	 * 최소한의 참조 정보({ __vramRef: true, storeName, key })만 보유하게 됩니다.
	 *
	 * @returns VRAM에 있는 최신 데이터 (구조체 복사본)
	 */
	public async getAndDetach(): Promise<any> {
		if (!this.vramDB) {
			throw new Error("JsonGpuStore is not initialized.");
		}
		const data = await this.vramDB.StoreManager.get(
			this.storeName,
			this.key
		);
		// 내부 캐시를 detach하여 VRAM 참조용 최소 정보로 교체합니다.
		this.cache = {
			__vramRef: true,
			storeName: this.storeName,
			key: this.key,
		};
		this.proxy = this.createProxy(this.cache);
		return data;
	}

	/**
	 * StoreManager.delete()를 호출하여 VRAM에서 해당 레코드를 삭제합니다.
	 * 삭제 후에는 내부 캐시와 proxy를 초기화합니다.
	 */
	public async deleteRecord(): Promise<void> {
		if (!this.vramDB) {
			throw new Error("JsonGpuStore is not initialized.");
		}
		await this.vramDB.StoreManager.delete(this.storeName, this.key);
		// 내부 캐시 초기화 및 proxy 재생성 (삭제 후)
		this.cache = {};
		this.proxy = this.createProxy(this.cache);
		this.recordAdded = false;
	}
}
