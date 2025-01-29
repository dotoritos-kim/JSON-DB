import { IDBOptions } from "./types/StoreMetadata";
import { VramDataBase } from "./VramDataBase";

/**
 * 주어진 값을 align의 배수로 올림한다.
 *
 * @param {number} value - 원본 값
 * @param {number} align - 맞추려는 배수
 * @returns {number} value 이상이면서 align의 배수인 최소 정수
 */
export function roundUp(value: number, align: number): number {
	return Math.ceil(value / align) * align;
}

/**
 * `jsonString`의 UTF-8 바이트 길이가 4의 배수가 되도록 공백으로 패딩한다.
 *
 * @param {string} jsonString - 원본 JSON 문자열
 * @returns {string} 4바이트 단위로 패딩된 JSON 문자열
 */
export function padJsonTo4Bytes(jsonString: string): string {
	const encoder = new TextEncoder();
	const initialBytes = encoder.encode(jsonString).length;
	const remainder = initialBytes % 4;

	if (remainder === 0) {
		return jsonString;
	}
	const needed = 4 - remainder;
	return jsonString + " ".repeat(needed);
}

/**
 * 주어진 ArrayBuffer의 길이를 4바이트 단위로 맞춰 패딩한다.
 * 이미 정렬되어 있으면 원본 버퍼를 반환하고, 아니면 0으로 채운 새 버퍼를 반환한다.
 *
 * @param {ArrayBuffer} ab - 원본 버퍼
 * @returns {ArrayBuffer} 4바이트 정렬을 맞춘 버퍼
 */
export function padTo4Bytes(ab: ArrayBuffer): ArrayBuffer {
	const remainder = ab.byteLength % 4;
	if (remainder === 0) {
		return ab;
	}
	const needed = 4 - remainder;
	const padded = new Uint8Array(ab.byteLength + needed);
	padded.set(new Uint8Array(ab), 0);
	return padded.buffer;
}

/**
 * SQL Server 스타일의 LIKE 패턴을 자바스크립트 정규식으로 변환한다.
 * - `%` → `.*`
 * - `_` → `.`
 * - 특수 정규식 문자는 이스케이프 (단, bracket 표현은 예외)
 *
 * @param {string} pattern - SQL 스타일 LIKE 패턴
 * @returns {RegExp} 해당 패턴에 해당하는 정규식
 */
export function likeToRegex(pattern: string): RegExp {
	let regexPattern = pattern
		.replace(/\\/g, "\\\\")
		.replace(/[.+^${}()|[\]\\]/g, (char) => `\\${char}`)
		.replace(/%/g, ".*")
		.replace(/_/g, ".");

	// bracket 표현 복원
	regexPattern = regexPattern.replace(/\\\[(.*?)]/g, "[$1]");

	return new RegExp(`^${regexPattern}$`, "u");
}

export function compareKeys(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

// 비활성 행을 표시하는 플래그 예시(0x1).
export const ROW_INACTIVE_FLAG = 0x1;
