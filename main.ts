import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import * as docxTemplates from 'docx-templates';
import { convertPdfsInFolder } from './pdf2img';
import { encodeImagesInFolder } from './upimg';
import { QwenCodeSDK } from './qwensdk';

interface PartyInfo {
    name: string;
    tax_id: string;
}

interface InvoiceItem {
    name: string;
    model: string;
    unit: string;
    quantity: number | null;
    unit_price: number | null;
    amount: number;
    tax_rate: string;
    tax_amount: number;
}

interface InvoiceData {
    invoice_title: string;
    invoice_number: string;
    issue_date: string;
    buyer_info: PartyInfo;
    seller_info: PartyInfo;
    items: InvoiceItem[];
    total_amount_exclusive_tax: number;
    total_tax_amount: number;
    total_amount_inclusive_tax: {
        in_words: string;
        in_figures: number;
    };
    remarks: string;
    issuer: string;
}

interface ProductLine {
    product_name: string;
    specification: string;
    unit: string;
    quantity: number | null;
    unit_price: number | null;
    amount: number;
}

interface ReportContext {
    project_name: string;
    date_in: string;
    date_out: string;
    product_list: ProductLine[];
    total_amount: number;
    total_amount_CN: string;
}

const PDF_INPUT_DIR = path.resolve('pdfs');
const IMAGE_OUTPUT_DIR = path.resolve('images');
const REPORT_OUTPUT_DIR = path.resolve('reports');
const TOKEN_STORAGE_DIR = path.resolve('.qwen');

// 获取模板文件路径 - 支持编译后的可执行文件和开发模式
const getTemplatePath = (): string => {
    // 优先使用当前目录下的模板文件（适用于开发模式）
    const localTemplate = path.resolve('template.docx');
    if (fs.existsSync(localTemplate)) {
        return localTemplate;
    }
    // 回退到可执行文件同目录（适用于发布模式）
    const exeDir = path.dirname(process.execPath);
    const exeTemplate = path.join(exeDir, 'template.docx');
    if (fs.existsSync(exeTemplate)) {
        return exeTemplate;
    }
    throw new Error('找不到模板文件 template.docx，请确保它在程序同目录下');
};

const SYSTEM_PROMPT = `You are an invoice extraction assistant. Return ONLY a valid JSON object that conforms to the schema below. Clean amounts and quantities to numbers without currency symbols. Format dates as YYYY-MM-DD. Tax rates must be percentage strings (e.g., "13%"). If a value is missing, use null or an empty string. Include every line item, including discounts as negative amounts. Ignore unrelated text such as download counts.
Schema:
{
    "invoice_title": "string",
    "invoice_number": "string",
    "issue_date": "string",
    "buyer_info": { "name": "string", "tax_id": "string" },
    "seller_info": { "name": "string", "tax_id": "string" },
    "items": [
        {
            "name": "string",
            "model": "string",
            "unit": "string",
            "quantity": "number | null",
            "unit_price": "number | null",
            "amount": "number",
            "tax_rate": "string",
            "tax_amount": "number"
        }
    ],
    "total_amount_exclusive_tax": "number",
    "total_tax_amount": "number",
    "total_amount_inclusive_tax": { "in_words": "string", "in_figures": "number" },
    "remarks": "string",
    "issuer": "string"
}`.trim();

const ensureDir = async (dir: string) => {
    await fs.promises.mkdir(dir, { recursive: true });
};

// 清理文件夹中的所有文件
const cleanDir = async (dir: string) => {
    try {
        if (fs.existsSync(dir)) {
            const files = await fs.promises.readdir(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                const stat = await fs.promises.stat(filePath);
                if (stat.isDirectory()) {
                    await fs.promises.rm(filePath, { recursive: true });
                } else {
                    await fs.promises.unlink(filePath);
                }
            }
        }
    } catch {
        // 忽略清理错误
    }
};

const stripJsonFences = (text: string): string => {
    return text
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();
};

const parseInvoiceJson = (text: string): InvoiceData => {
    const cleaned = stripJsonFences(text);
    return JSON.parse(cleaned) as InvoiceData;
};

const toCurrencyUppercase = (amount: number): string => {
    if (!Number.isFinite(amount)) return '';
    const fraction = ['角', '分'];
    const digit = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
    const unit = [['元', '万', '亿', '兆'], ['', '拾', '佰', '仟']];

    const sign = amount < 0 ? '负' : '';
    let num = Math.round(Math.abs(amount) * 100);

    if (num === 0) return '零元整';

    let s = '';
    // decimal part
    for (let i = 0; i < fraction.length; i++) {
        const m = Math.floor(num / Math.pow(10, 1 - i)) % 10;
        if (m !== 0) s += `${digit[m]}${fraction[i]}`;
    }
    s = s || '整';
    num = Math.floor(num / 100);

    let integer = '';
    for (let i = 0; i < unit[0].length && num > 0; i++) {
        let p = '';
        for (let j = 0; j < unit[1].length && num > 0; j++) {
            const d = num % 10;
            p = (d ? `${digit[d]}${unit[1][j]}` : '零') + p;
            num = Math.floor(num / 10);
        }
        p = p.replace(/(零)+/g, '零').replace(/(零)$/g, '');
        if (p) integer = `${p}${unit[0][i]}${integer}`;
    }

    return sign + integer.replace(/(零)+/g, '零').replace(/零元/g, '元') + s;
};

const summarizeInvoice = (invoice: InvoiceData): { product_list: ProductLine[]; total_amount: number; total_amount_CN: string } => {
    const product_list = invoice.items.map((item) => {
        const lineAmount = (item.amount ?? 0) + (item.tax_amount ?? 0);
        return {
            product_name: item.name,
            specification: item.model,
            unit: item.unit,
            quantity: item.quantity,
            unit_price: item.unit_price,
            amount: Number(lineAmount.toFixed(2))
        } satisfies ProductLine;
    });

    const total_amount = Number(
        product_list.reduce((sum, item) => sum + (Number.isFinite(item.amount) ? item.amount : 0), 0).toFixed(2)
    );
    const total_amount_CN = toCurrencyUppercase(total_amount);

    return { product_list, total_amount, total_amount_CN };
};

// 汇总多张发票的数据
const summarizeMultipleInvoices = (invoices: InvoiceData[]): { product_list: ProductLine[]; total_amount: number; total_amount_CN: string } => {
    const allProducts: ProductLine[] = [];
    
    for (const invoice of invoices) {
        const summary = summarizeInvoice(invoice);
        allProducts.push(...summary.product_list);
    }

    const total_amount = Number(
        allProducts.reduce((sum, item) => sum + (Number.isFinite(item.amount) ? item.amount : 0), 0).toFixed(2)
    );
    const total_amount_CN = toCurrencyUppercase(total_amount);

    return { product_list: allProducts, total_amount, total_amount_CN };
};

const promptProjectInfo = async (): Promise<{ project_name: string; date_in: string; date_out: string }> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, (ans) => resolve(ans.trim())));

    const project_name = await ask('请输入课题名称: ');
    const date_in = await ask('请输入入库日期(YYYY-MM-DD): ');
    const date_out = await ask('请输入出库日期(YYYY-MM-DD): ');

    rl.close();
    return { project_name, date_in, date_out };
};

const ensureAuthenticated = async (sdk: QwenCodeSDK) => {
    const token = await sdk.loadTokenFromStorage();
    if (token) {
        return;
    }

    console.log('\n⚠️  未找到已保存的令牌，需要登录 Qwen 账号');

    const flow = await sdk.initiateDeviceFlow();
    const verificationUrl = flow.verification_uri_complete || flow.verification_uri;
    
    console.log('\n🔗 正在打开浏览器进行验证...');
    console.log(`   验证链接: ${verificationUrl}`);
    
    // 自动打开浏览器
    const { exec } = await import('child_process');
    exec(`open "${verificationUrl}"`);

    process.stdout.write('• 等待授权（请在浏览器中完成验证）...');
    
    // 不限时轮询，等待用户完成验证
    await sdk.pollForToken(flow.device_code, flow.code_verifier, '', flow.interval * 1000);
    console.log(' ✓');
    
    // 验证成功后，提示用户输入邮箱/用户名用于标识
    const email = await new Promise<string>((resolve) => {
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question('\n请输入您的 Qwen 账号邮箱或用户名（用于标识）: ', (answer: string) => {
            rl.close();
            resolve(answer.trim());
        });
    });

    // 更新存储中的邮箱信息
    if (email) {
        await sdk.updateTokenEmail(email);
    }
};

const convertAndEncodeImages = async () => {
    await ensureDir(IMAGE_OUTPUT_DIR);
    
    console.log('\n📄 正在转换 PDF 文件...');
    await convertPdfsInFolder(PDF_INPUT_DIR, IMAGE_OUTPUT_DIR);

    console.log('\n🔒 正在编码图片为 base64...');
    const encodeResult = await encodeImagesInFolder(IMAGE_OUTPUT_DIR);
    
    // 返回文件名和 base64 Data URL 的对应关系
    const encodedImages = encodeResult.success
        .filter(item => item.dataUrl)
        .map(item => ({
            file: path.basename(item.file),
            dataUrl: item.dataUrl!
        }));
    
    const failedEncodes = encodeResult.failed;

    if (encodedImages.length === 0) {
        throw new Error('没有图片编码成功');
    }

    console.log(`   ✓ 编码成功: ${encodedImages.length} 张`);
    if (failedEncodes.length > 0) {
        console.log(`   ✗ 编码失败: ${failedEncodes.length} 张`);
    }

    return { encodedImages, failedEncodes };
};

// 识别单张发票图片
const extractSingleInvoice = async (sdk: QwenCodeSDK, dataUrl: string): Promise<InvoiceData> => {
    const userContent = [
        {
            type: 'image_url' as const,
            image_url: { url: dataUrl, detail: 'high' as const }
        },
        { type: 'text' as const, text: '请提取发票信息并返回 JSON。' }
    ];

    const response = await sdk.sendRequest({
        model: 'vision-model',
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent }
        ],
        stream: false
    });

    const content = response?.choices?.[0]?.message?.content;
    let textContent = '';

    if (Array.isArray(content)) {
        textContent = content
            .map((part: any) => (part.type === 'text' ? part.text : ''))
            .join('')
            .trim();
    } else if (typeof content === 'string') {
        textContent = content.trim();
    }

    if (!textContent) {
        throw new Error('Model returned empty content.');
    }

    return parseInvoiceJson(textContent);
};

// 按 PDF 文件分组图片，然后逐个识别
const extractAllInvoices = async (
    sdk: QwenCodeSDK, 
    encodedImages: { file: string; dataUrl: string }[]
): Promise<InvoiceData[]> => {
    // 按 PDF 文件名分组图片（同一个 PDF 可能有多页）
    const pdfGroups = new Map<string, string[]>();
    
    for (const img of encodedImages) {
        // 文件名格式: pdfname-1.png, pdfname-2.png
        const match = img.file.match(/^(.+)-\d+\.[^.]+$/);
        const pdfName = match ? match[1] : img.file;
        
        if (!pdfGroups.has(pdfName)) {
            pdfGroups.set(pdfName, []);
        }
        pdfGroups.get(pdfName)!.push(img.dataUrl);
    }

    const invoices: InvoiceData[] = [];
    const pdfNames = Array.from(pdfGroups.keys());
    
    for (let i = 0; i < pdfNames.length; i++) {
        const pdfName = pdfNames[i];
        const dataUrls = pdfGroups.get(pdfName)!;
        
        process.stdout.write(`• 识别发票 ${i + 1}/${pdfNames.length}: ${pdfName}...`);
        
        try {
            // 如果同一个 PDF 有多页，只用第一页（通常发票只有一页）
            const invoice = await extractSingleInvoice(sdk, dataUrls[0]);
            invoices.push(invoice);
            console.log(` ✓ ${invoice.items.length} 项商品`);
        } catch (error: any) {
            console.log(` ✗ ${error.message}`);
        }
    }

    return invoices;
};

const generateDocxReport = async (data: ReportContext, outputPath: string) => {
    // 从文件系统读取模板
    const templatePath = getTemplatePath();
    const template = await fs.promises.readFile(templatePath);
    
    // docx-templates 语法说明：
    // 变量插入: {{ variable }} -> 使用 cmdDelimiter: ['{{', '}}']
    // 循环命令: {%tr FOR product IN product_list%} ... {%tr END-FOR product%}
    // 
    // 注意：模板文件需要使用正确的 docx-templates 语法：
    // - FOR/END-FOR 必须大写
    // - 循环变量在使用时需要加 $ 前缀，如 $product.name
    
    // 兼容 Bun 编译后的导入方式
    const mod = docxTemplates as any;
    const createReport = typeof mod.createReport === 'function' 
        ? mod.createReport 
        : (typeof mod.default === 'function' ? mod.default : mod.default?.createReport);
    
    if (typeof createReport !== 'function') {
        throw new Error('无法加载 docx-templates 模块');
    }
    
    const report = await createReport({ 
        template, 
        data,
        cmdDelimiter: ['{{', '}}'],  // 变量和命令都使用 {{ }}
        fixSmartQuotes: true,
    });
    await fs.promises.writeFile(outputPath, report as Buffer);
};

const main = async () => {
    const sdk = new QwenCodeSDK({ tokenStorageDir: TOKEN_STORAGE_DIR });

    try {
        console.log('\n📋 发票-->出入库工具');
        console.log('='.repeat(40));

        await ensureDir(TOKEN_STORAGE_DIR);
        await ensureDir(REPORT_OUTPUT_DIR);
        await ensureAuthenticated(sdk);

        const { encodedImages } = await convertAndEncodeImages();

        console.log('\n🤖 正在识别发票信息...');
        const invoices = await extractAllInvoices(sdk, encodedImages);
        
        if (invoices.length === 0) {
            throw new Error('没有成功识别任何发票');
        }
        
        console.log(`\n   ✓ 共识别 ${invoices.length} 张发票`);

        console.log('\n📝 请输入报告信息:');
        const projectInfo = await promptProjectInfo();
        
        // 汇总所有发票数据
        const summary = summarizeMultipleInvoices(invoices);
        const reportData: ReportContext = { ...projectInfo, ...summary };
        
        console.log(`\n   汇总: ${summary.product_list.length} 项商品, 总金额: ￥${summary.total_amount}`);

        const reportPath = path.join(REPORT_OUTPUT_DIR, `invoice-${Date.now()}.docx`);
        await generateDocxReport(reportData, reportPath);

        console.log(`\n✅ 报告已生成: ${reportPath}`);
    } catch (error: any) {
        console.error(`\n❌ 处理失败: ${error.message || error}`);
        process.exitCode = 1;
    } finally {
        // 清理图片文件夹
        await cleanDir(IMAGE_OUTPUT_DIR);
    }
};

void main();