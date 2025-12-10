// 递归转换一个文件夹中的所有 PDF 文件为图片
// 使用在线 API: https://easyyun.github.io/docs/api/pdf_to_image.html
import fs from 'fs';
import path from 'path';

const PDF_TO_IMAGE_API = 'https://pdf-api.pdfai.cn/v1/pdf/pdf_to_image';
const APP_KEY = 'app_key_test'; // 免费测试 key
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

interface PdfToImageResponse {
  code: number;
  code_msg: string;
  data?: {
    file_url: string[];
  };
}

// 通用重试工具函数
const withRetry = async <T>(
  fn: () => Promise<T>,
  retries: number = MAX_RETRIES,
  delay: number = RETRY_DELAY_MS,
  context: string = ''
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
  throw lastError || new Error(`${context} 失败`);
};

// 上传 PDF 文件到临时托管服务，获取公网 URL
// 使用 tmpfile.link - 基于 Cloudflare Workers 的临时文件分享服务
const uploadPdfToTempHost = async (pdfPath: string): Promise<string> => {
  return withRetry(async () => {
    const buffer = await fs.promises.readFile(pdfPath);
    const blob = new Blob([buffer], { type: 'application/pdf' });
    const formData = new FormData();
    formData.append('file', blob, path.basename(pdfPath));

    const response = await fetch('https://tmpfile.link/api/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to upload PDF: ${response.status} - ${text}`);
    }

    const json = await response.json() as { 
      fileName: string; 
      downloadLink: string;
      downloadLinkEncoded: string;
      size: number;
      type: string;
    };
    
    if (!json.downloadLink && !json.downloadLinkEncoded) {
      throw new Error(`Upload failed: ${JSON.stringify(json)}`);
    }

    // 优先使用编码后的链接，避免文件名有特殊字符导致问题
    return json.downloadLinkEncoded || json.downloadLink;
  }, MAX_RETRIES, RETRY_DELAY_MS, 'PDF上传');
};

// 调用 PDF 转图片 API
const callPdfToImageApi = async (pdfUrl: string): Promise<string[]> => {
  return withRetry(async () => {
    const response = await fetch(PDF_TO_IMAGE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        app_key: APP_KEY,
        input: pdfUrl,
        page: '1-N', // 转换所有页面
        quality: 'high',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed: ${response.status} - ${text}`);
    }

    const json = await response.json() as PdfToImageResponse;
    
    if (json.code !== 200 || !json.data?.file_url) {
      throw new Error(`API error: ${json.code_msg || 'Unknown error'} (code: ${json.code})`);
    }

    return json.data.file_url;
  }, MAX_RETRIES, RETRY_DELAY_MS, 'PDF转图片API');
};

// 下载图片到本地
const downloadImage = async (imageUrl: string, outputPath: string): Promise<void> => {
  return withRetry(async () => {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    await fs.promises.writeFile(outputPath, Buffer.from(buffer));
  }, MAX_RETRIES, RETRY_DELAY_MS, '图片下载');
};

// 转换单个 PDF 文件为图片
const convertPdfToImages = async (pdfPath: string, outputDir: string): Promise<void> => {
  const baseName = path.basename(pdfPath, '.pdf');
  const fileName = path.basename(pdfPath);
  
  try {
    process.stdout.write(`• 处理 ${fileName}...`);
    const pdfUrl = await uploadPdfToTempHost(pdfPath);
    
    const imageUrls = await callPdfToImageApi(pdfUrl);
    
    // 下载所有图片
    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i];
      const ext = path.extname(imageUrl) || '.png';
      const outputPath = path.join(outputDir, `${baseName}-${i + 1}${ext}`);
      
      await downloadImage(imageUrl, outputPath);
    }
    
    console.log(` ✓ ${imageUrls.length}张图片`);
  } catch (error: any) {
    console.log(` ✗ 失败: ${error.message}`);
    throw error;
  }
};

const processDirectory = async (dirPath: string, outputDir: string) => {
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      const newOutputDir = path.join(outputDir, file);
      fs.mkdirSync(newOutputDir, { recursive: true });
      await processDirectory(fullPath, newOutputDir);
    } else if (path.extname(file).toLowerCase() === '.pdf') {
      await convertPdfToImages(fullPath, outputDir);
    }
  }
};

export const convertPdfsInFolder = async (inputFolder: string, outputFolder: string) => {
  fs.mkdirSync(outputFolder, { recursive: true });
  await processDirectory(inputFolder, outputFolder);
};

