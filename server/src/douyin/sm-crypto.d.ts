/**
 * sm-crypto 类型声明
 * sm-crypto 是一个 CommonJS 库，没有内置 TypeScript 类型定义
 * 在 ESM 中需使用默认导入: import smCrypto from "sm-crypto"
 */
declare module "sm-crypto" {
  /**
   * SM3 密码杂凑算法
   * @param input 输入字符串或字节数组
   * @returns 十六进制格式的哈希字符串
   */
  export function sm3(input: string | Uint8Array | number[]): string;

  /**
   * SM2 椭圆曲线公钥密码算法
   */
  export const sm2: {
    doEncrypt: (msg: string, publicKey: string, cipherMode?: number) => string;
    doDecrypt: (encryptData: string, privateKey: string, cipherMode?: number) => string;
    doSignature: (msg: string, privateKey: string, options?: object) => string;
    doVerifySignature: (msg: string, signHex: string, publicKey: string, options?: object) => boolean;
    getPoint: () => { k: string; publicKey: string };
    generateKeyPairHex: () => { privateKey: string; publicKey: string };
  };

  /**
   * SM4 分组密码算法
   */
  export const sm4: {
    encrypt: (inArray: number[] | string, key: string | number[], options?: object) => string | number[];
    decrypt: (inArray: number[] | string, key: string | number[], options?: object) => string | number[];
  };

  const _default: {
    sm3: typeof sm3;
    sm2: typeof sm2;
    sm4: typeof sm4;
  };
  export default _default;
}
