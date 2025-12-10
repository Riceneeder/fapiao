import fs from 'fs';
import path from 'path';

// 使用 tmpfile.link API
const API_ENDPOINT = 'https://tmpfile.link/api/upload';
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.gif']);
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

export type OutputFormat = 'auto' | 'jpeg' | 'png' | 'webp' | 'gif' | 'webp_animated';

export interface UploadOptions {
	outputFormat?: OutputFormat;
	password?: string;
	cdnDomain?: string;
	concurrency?: number;
}

export interface UploadApiResponse {
	success: boolean;
	url?: string;
	message?: string;
	data?: {
		filename: string;
		original_size: number;
		compressed_size: number;
		compression_ratio: number;
	};
}

export interface UploadResult {
	file: string;
	url?: string;
	message?: string;
	error?: string;
}

// 通用重试工具函数
const withRetry = async <T>(
	fn: () => Promise<T>,
	retries: number = MAX_RETRIES,
	delay: number = RETRY_DELAY_MS
): Promise<T> => {
	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			return await fn();
		} catch (error: any) {
			lastError = error;
			if (attempt < retries) {
				await new Promise(resolve => setTimeout(resolve, delay * attempt));
			}
		}
	}
	throw lastError || new Error('请求失败');
};

// Upload a single image file and return its CDN URL.
export const uploadImage = async (filePath: string, options: UploadOptions = {}): Promise<UploadApiResponse> => {
	return withRetry(async () => {
		const buffer = await fs.promises.readFile(filePath);
		const blob = new Blob([buffer]);
		const formData = new FormData();

		formData.append('file', blob, path.basename(filePath));

		const response = await fetch(API_ENDPOINT, {
			method: 'POST',
			body: formData
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Upload failed: ${response.status} - ${text}`);
		}

		const json = await response.json() as { 
			fileName: string; 
			downloadLink: string;
			downloadLinkEncoded: string;
			size: number;
			type: string;
		};

		if (!json.downloadLink && !json.downloadLinkEncoded) {
			throw new Error(`Upload failed: no download link returned`);
		}

		return {
			success: true,
			url: json.downloadLinkEncoded || json.downloadLink,
			message: 'Upload successful',
			data: {
				filename: json.fileName,
				original_size: json.size,
				compressed_size: json.size,
				compression_ratio: 1
			}
		};
	});
};

// Recursively find image files within a directory.
const collectImageFiles = async (root: string): Promise<string[]> => {
	const entries = await fs.promises.readdir(root, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...await collectImageFiles(fullPath));
		} else if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
			files.push(fullPath);
		}
	}

	return files;
};

// Simple concurrency pool executor.
const runWithConcurrency = async <T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> => {
	const results: R[] = [];
	let idx = 0;

	const workers = Array.from({ length: Math.max(1, limit) }, async () => {
		while (idx < items.length) {
			const current = idx++;
			results[current] = await worker(items[current]);
		}
	});

	await Promise.all(workers);
	return results;
};

export interface BatchUploadResult {
	success: UploadResult[];
	failed: UploadResult[];
}

// Upload all images within a folder (recursively) and return their URLs grouped by success/failure.
export const uploadImagesInFolder = async (folderPath: string, options: UploadOptions = {}): Promise<BatchUploadResult> => {
	const files = await collectImageFiles(folderPath);
	const concurrency = options.concurrency ?? 3;

	const outcomes = await runWithConcurrency(files, concurrency, async (file) => {
		try {
			const res = await uploadImage(file, options);
			return { file, url: res.url, message: res.message } satisfies UploadResult;
		} catch (error: any) {
			return { file, error: error?.message || String(error) } satisfies UploadResult;
		}
	});

	const success: UploadResult[] = [];
	const failed: UploadResult[] = [];

	for (const outcome of outcomes) {
		if (outcome.url) {
			success.push(outcome);
		} else {
			failed.push(outcome);
		}
	}

	return { success, failed };
};

