import fs from 'fs';
import path from 'path';

// MIME 类型映射
const MIME_TYPE_MAP: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp',
	'.tiff': 'image/tiff',
	'.gif': 'image/gif'
};

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.gif']);

export interface EncodeResult {
	file: string;
	dataUrl?: string;
	error?: string;
}

// 将图片文件编码为 base64 Data URL
export const encodeImageToBase64 = async (filePath: string): Promise<string> => {
	const buffer = await fs.promises.readFile(filePath);
	const base64 = buffer.toString('base64');
	const ext = path.extname(filePath).toLowerCase();
	const mimeType = MIME_TYPE_MAP[ext] || 'image/jpeg';
	return `data:${mimeType};base64,${base64}`;
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

export interface BatchEncodeResult {
	success: EncodeResult[];
	failed: EncodeResult[];
}

// 将文件夹中的所有图片编码为 base64 Data URL
export const encodeImagesInFolder = async (folderPath: string, concurrency: number = 5): Promise<BatchEncodeResult> => {
	const files = await collectImageFiles(folderPath);

	const outcomes = await runWithConcurrency(files, concurrency, async (file) => {
		try {
			const dataUrl = await encodeImageToBase64(file);
			return { file, dataUrl } satisfies EncodeResult;
		} catch (error: any) {
			return { file, error: error?.message || String(error) } satisfies EncodeResult;
		}
	});

	const success: EncodeResult[] = [];
	const failed: EncodeResult[] = [];

	for (const outcome of outcomes) {
		if (outcome.dataUrl) {
			success.push(outcome);
		} else {
			failed.push(outcome);
		}
	}

	return { success, failed };
};

