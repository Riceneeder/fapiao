import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 常量定义（与Go代码保持一致）
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = 'https://chat.qwen.ai/api/v1/oauth2/device/code';
const QWEN_OAUTH_TOKEN_ENDPOINT = 'https://chat.qwen.ai/api/v1/oauth2/token';
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';
const QWEN_OAUTH_SCOPE = 'openid profile email model.completion';
const QWEN_OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

// 与 CLIProxyAPI 中 Qwen executor 保持一致的 UA 与元信息
const QWEN_USER_AGENT = 'google-api-nodejs-client/9.15.1';
const QWEN_X_GOOG_API_CLIENT = 'gl-node/22.17.0';
const QWEN_CLIENT_METADATA = 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI';

// 重试配置
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

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
      // 不重试的错误类型：认证错误、参数错误等
      if (error?.status === 401 || error?.status === 403 || error?.status === 400) {
        throw error;
      }
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
      }
    }
  }
  throw lastError || new Error('请求失败');
};

// 类型定义
interface DeviceFlow {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
  code_verifier: string;
}

interface QwenTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  resource_url?: string;
  expires_in: number;
}

interface QwenTokenData {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  resource_url?: string;
  expiry_date: string;
}

interface QwenTokenStorage {
  access_token: string;
  refresh_token?: string;
  last_refresh: string;
  resource_url?: string;
  email: string;
  type: 'qwen';
  expired: string;
}

type QwenContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: {
        url: string;
        detail?: 'auto' | 'low' | 'high';
      };
    };

type QwenMessage =
  | { role: 'system'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'user'; content: string | QwenContentPart[] };

interface QwenRequestOptions {
  model: string;
  messages: QwenMessage[];
  stream?: boolean;
  [key: string]: any;
}

// 工具函数
const generateCodeVerifier = (): string => {
  const bytes = crypto.randomBytes(32);
  return base64URLEncode(bytes);
};

const generateCodeChallenge = (verifier: string): string => {
  const sha256 = crypto.createHash('sha256');
  sha256.update(verifier);
  return base64URLEncode(sha256.digest());
};

const base64URLEncode = (str: Buffer): string => {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

const parseExpiry = (expiryDate: string): Date => {
  return new Date(expiryDate);
};

const isTokenExpired = (token: QwenTokenData): boolean => {
  return new Date() >= parseExpiry(token.expiry_date);
};

// 主SDK类
export class QwenCodeSDK {
  private tokenStoragePath: string;
  private currentToken?: QwenTokenData;
  private currentEmail?: string; // 当前用户的邮箱/用户名
  private readonly requestTimeoutMs = 120000; // 2分钟超时，适应图片识别等耗时操作

  constructor(
    private config?: {
      proxy?: string;
      tokenStorageDir?: string;
    }
  ) {
    // Bun 的 fetch 会读取 HTTP(S)_PROXY 环境变量，这里直接写入便于兼容原代理配置。
    if (config?.proxy) {
      process.env.HTTP_PROXY = config.proxy;
      process.env.HTTPS_PROXY = config.proxy;
    }

    // 配置令牌存储路径
    this.tokenStoragePath = config?.tokenStorageDir 
      ? path.join(config.tokenStorageDir, 'qwen-token.json')
      : path.join(os.homedir(), '.qwen', 'qwen-token.json');
  }

  // 初始化设备授权流程
  async initiateDeviceFlow(): Promise<DeviceFlow> {
    return withRetry(async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const params = new URLSearchParams();
      params.append('client_id', QWEN_OAUTH_CLIENT_ID);
      params.append('scope', QWEN_OAUTH_SCOPE);
      params.append('code_challenge', codeChallenge);
      params.append('code_challenge_method', 'S256');

      const deviceFlow = await this.postForm<DeviceFlow>(
        QWEN_OAUTH_DEVICE_CODE_ENDPOINT,
        params
      );
      if (!deviceFlow.user_code || !deviceFlow.device_code || !deviceFlow.verification_uri_complete) {
        throw new Error(`设备授权返回缺少字段`);
      }
      deviceFlow.code_verifier = codeVerifier;
      return deviceFlow;
    });
  }

  // 轮询令牌（不限时，直到用户完成验证）
  // email: 用户的 Qwen 账号邮箱或用户名，用于标识令牌归属（可选，验证成功后设置）
  async pollForToken(deviceCode: string, codeVerifier: string, email: string = '', interval: number = 5000): Promise<QwenTokenData> {
    // 无限轮询直到用户完成授权
    while (true) {
      try {
        const params = new URLSearchParams();
        params.append('grant_type', QWEN_OAUTH_GRANT_TYPE);
        params.append('client_id', QWEN_OAUTH_CLIENT_ID);
        params.append('device_code', deviceCode);
        params.append('code_verifier', codeVerifier);

        const response = await this.postForm<QwenTokenResponse>(
          QWEN_OAUTH_TOKEN_ENDPOINT,
          params
        );

        const tokenData: QwenTokenData = {
          access_token: response.access_token,
          refresh_token: response.refresh_token,
          token_type: response.token_type,
          resource_url: response.resource_url,
          expiry_date: new Date(Date.now() + response.expires_in * 1000).toISOString()
        };

        this.currentToken = tokenData;
        this.currentEmail = email.trim();
        await this.saveTokenToStorage(tokenData, this.currentEmail);
        return tokenData;
      } catch (error: any) {
        const status = error.status;
        const errorData = error.data;

        if (status === 400 && !errorData && error.message?.includes('user_code')) {
          throw new Error(`令牌获取失败，接口返回: ${error.message}`);
        }

        if (status === 400 && errorData?.error === 'authorization_pending') {
          // 等待用户授权，继续轮询
          await new Promise(resolve => setTimeout(resolve, interval));
          continue;
        } else if (status === 400 && errorData?.error === 'slow_down') {
          // 减缓轮询速度
          interval = Math.floor(interval * 1.5);
          await new Promise(resolve => setTimeout(resolve, interval));
          continue;
        } else {
          throw new Error(`令牌获取失败: ${this.extractError(error)}`);
        }
      }
    }
  }

  // 刷新令牌
  async refreshToken(refreshToken: string): Promise<QwenTokenData> {
    return withRetry(async () => {
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', refreshToken);
      params.append('client_id', QWEN_OAUTH_CLIENT_ID);

      const response = await this.postForm<QwenTokenResponse>(
        QWEN_OAUTH_TOKEN_ENDPOINT,
        params
      );

      const tokenData: QwenTokenData = {
        access_token: response.access_token,
        refresh_token: response.refresh_token || refreshToken,
        token_type: response.token_type,
        resource_url: response.resource_url,
        expiry_date: new Date(Date.now() + response.expires_in * 1000).toISOString()
      };

      this.currentToken = tokenData;
      const email = this.currentEmail || 'unknown';
      await this.saveTokenToStorage(tokenData, email);
      return tokenData;
    });
  }

  // 发送请求到Qwen Code模型
  async sendRequest(options: QwenRequestOptions): Promise<any> {
    if (!this.currentToken) {
      await this.loadTokenFromStorage();
      if (!this.currentToken) {
        throw new Error('未找到有效的令牌，请先进行认证');
      }
    }

    if (isTokenExpired(this.currentToken) && this.currentToken.refresh_token) {
      await this.refreshToken(this.currentToken.refresh_token);
    }

    return withRetry(async () => {
      const baseUrl = this.buildBaseUrl(this.currentToken?.resource_url);
      const apiUrl = `${baseUrl}/chat/completions`;

      const response = await this.fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: this.buildQwenHeaders(!!options.stream),
        body: JSON.stringify(options)
      });

      if (options.stream) {
        if (!response.ok) {
          throw new Error(await this.readErrorResponse(response));
        }
        return response.body;
      }

      if (!response.ok) {
        throw new Error(await this.readErrorResponse(response));
      }

      return await response.json();
    });
  }

  // 保存令牌到本地存储
  async saveTokenToStorage(token: QwenTokenData, email: string): Promise<void> {
    const storageData: QwenTokenStorage = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      last_refresh: new Date().toISOString(),
      resource_url: token.resource_url,
      email: email,
      type: 'qwen',
      expired: token.expiry_date
    };

    // 创建存储目录
    await fs.promises.mkdir(path.dirname(this.tokenStoragePath), { recursive: true });
    // 写入令牌文件
    await fs.promises.writeFile(
      this.tokenStoragePath,
      JSON.stringify(storageData, null, 2)
    );
  }

  // 更新已保存令牌的邮箱/用户名标识
  async updateTokenEmail(email: string): Promise<void> {
    if (!this.currentToken) {
      return;
    }
    this.currentEmail = email;
    await this.saveTokenToStorage(this.currentToken, email);
  }

  // 从本地存储加载令牌
  async loadTokenFromStorage(): Promise<QwenTokenData | null> {
    try {
      if (fs.existsSync(this.tokenStoragePath)) {
        const data = await fs.promises.readFile(this.tokenStoragePath, 'utf8');
        const storageData: QwenTokenStorage = JSON.parse(data);
        
        this.currentToken = {
          access_token: storageData.access_token,
          refresh_token: storageData.refresh_token,
          token_type: 'Bearer',
          resource_url: storageData.resource_url,
          expiry_date: storageData.expired
        };

        // 加载存储的 email
        this.currentEmail = storageData.email;

        return this.currentToken;
      }
    } catch (error) {
      console.warn('加载令牌失败:', error);
    }
    return null;
  }

  // 辅助函数：提取错误信息
  private extractError(error: any): string {
    if (error?.message) return error.message;
    return String(error);
  }

  private buildBaseUrl(resource?: string): string {
    if (resource && resource.trim().length > 0) {
      // CLIProxyAPI 将 resource_url 存储为 host，补全为 https://{host}/v1
      return `https://${resource.replace(/\/$/, '')}/v1`;
    }
    return 'https://portal.qwen.ai/v1';
  }

  private buildQwenHeaders(stream: boolean): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.currentToken?.access_token ?? ''}`,
      'User-Agent': QWEN_USER_AGENT,
      'X-Goog-Api-Client': QWEN_X_GOOG_API_CLIENT,
      'Client-Metadata': QWEN_CLIENT_METADATA,
      'Accept': stream ? 'text/event-stream' : 'application/json'
    };
  }

  // 使用 fetch 发送 x-www-form-urlencoded 请求
  private async postForm<T>(url: string, params: URLSearchParams): Promise<T> {
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: params.toString()
    });

    if (!response.ok) {
      throw await this.buildHttpError(response);
    }

    return await response.json() as T;
  }

  // 通用 fetch with timeout
  private async fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async buildHttpError(response: Response): Promise<Error & { status?: number; data?: any }> {
    const message = await this.readErrorResponse(response);
    const err = new Error(message) as Error & { status?: number; data?: any };
    err.status = response.status;
    try {
      err.data = await response.clone().json();
    } catch {
      err.data = undefined;
    }
    return err;
  }

  private async readErrorResponse(response: Response): Promise<string> {
    try {
      const data = await response.clone().json();
      return `${response.status} ${response.statusText}: ${JSON.stringify(data)}`;
    } catch {
      const text = await response.text();
      return `${response.status} ${response.statusText}: ${text}`;
    }
  }
}

