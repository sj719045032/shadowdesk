import { initSDK, createInstance, SepoliaConfig, type FhevmInstance } from "@zama-fhe/relayer-sdk/web";
import { CONTRACT_ADDRESS, getWalletClientInstance } from "./contract";

export type PublicDecryptResult = {
  cleartext: bigint;
  cleartexts: `0x${string}`;
  decryptionProof: `0x${string}`;
};

let instance: FhevmInstance | null = null;

export async function getFhevmInstance(): Promise<FhevmInstance> {
  if (instance) return instance;

  await initSDK();

  instance = await createInstance({
    ...SepoliaConfig,
    network: window.ethereum || "https://ethereum-sepolia-rpc.publicnode.com",
  });

  return instance;
}

// Scale factor: 6 decimal places (matching cWETH/cUSDC encrypted precision)
export const FHE_DECIMALS = 6;
export const FHE_SCALE = 10 ** FHE_DECIMALS;

export function scaleForFHE(value: number): number {
  return Math.round(value * FHE_SCALE);
}

export function unscaleFromFHE(value: number): number {
  return value / FHE_SCALE;
}

function toHex(value: unknown): `0x${string}` {
  if (typeof value === "string" && value.startsWith("0x")) return value as `0x${string}`;
  if (value instanceof Uint8Array) {
    return ("0x" + Array.from(value).map(b => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  }
  return ("0x" + String(value)) as `0x${string}`;
}

export async function encryptInputs(
  userAddress: string,
  price: number,
  amount: number,
) {
  const fhevmInstance = await getFhevmInstance();
  const input = fhevmInstance.createEncryptedInput(
    CONTRACT_ADDRESS,
    userAddress,
  );
  input.add64(scaleForFHE(price));
  input.add64(scaleForFHE(amount));
  const encrypted = await input.encrypt();
  return {
    handles: encrypted.handles.map((h: unknown) => toHex(h)),
    inputProof: toHex(encrypted.inputProof),
  };
}

export async function encryptUint64(
  contractAddress: string,
  userAddress: string,
  value: bigint,
) {
  const fhevmInstance = await getFhevmInstance();
  const input = fhevmInstance.createEncryptedInput(contractAddress, userAddress);
  input.add64(value);
  const encrypted = await input.encrypt();
  return {
    handles: encrypted.handles.map((h: unknown) => toHex(h)),
    inputProof: toHex(encrypted.inputProof),
  };
}

export async function decryptValues(
  handles: { handle: string; contractAddress: string }[],
  userAddress: string,
): Promise<Map<string, bigint>> {
  const fhevmInstance = await getFhevmInstance();

  // Use viem walletClient for signing
  const walletClient = await getWalletClientInstance();

  const { publicKey, privateKey } = fhevmInstance.generateKeypair();

  const now = Math.floor(Date.now() / 1000);
  const contractAddresses = [...new Set(handles.map((h) => h.contractAddress))];

  const eip712 = fhevmInstance.createEIP712(
    publicKey,
    contractAddresses,
    now,
    1,
  );

  // viem signTypedData handles EIP712Domain stripping natively
  const signature = await walletClient.signTypedData({
    domain: eip712.domain as Record<string, unknown>,
    types: eip712.types as unknown as Record<string, { name: string; type: string }[]>,
    primaryType: eip712.primaryType as string,
    message: eip712.message as Record<string, unknown>,
  });

  const results = await fhevmInstance.userDecrypt(
    handles,
    privateKey,
    publicKey,
    signature,
    contractAddresses,
    userAddress,
    now,
    1,
  );

  const decrypted = new Map<string, bigint>();
  for (const [handle, result] of Object.entries(results)) {
    decrypted.set(handle, BigInt(result as number | bigint));
  }
  return decrypted;
}

export async function publicDecryptHandle(handle: `0x${string}`): Promise<PublicDecryptResult> {
  const fhevmInstance = await getFhevmInstance();
  const result = await fhevmInstance.publicDecrypt([handle], {
    timeout: 30000,
  });

  const clearValue = result.clearValues[handle];
  if (clearValue === undefined) {
    throw new Error("Public decrypt result missing clear value");
  }

  return {
    cleartext: BigInt(clearValue as number | string | bigint),
    cleartexts: result.abiEncodedClearValues,
    decryptionProof: result.decryptionProof,
  };
}

export type SettleFillDecryptResult = {
  priceMatched: boolean;
  fillAmount: bigint;
  handlesList: `0x${string}`[];
  cleartexts: `0x${string}`;
  decryptionProof: `0x${string}`;
};

export async function publicDecryptFillHandles(
  priceMatchHandle: `0x${string}`,
  effectiveFillHandle: `0x${string}`,
): Promise<SettleFillDecryptResult> {
  const fhevmInstance = await getFhevmInstance();
  const result = await fhevmInstance.publicDecrypt(
    [priceMatchHandle, effectiveFillHandle],
    { timeout: 30000 },
  );

  const priceMatchValue = result.clearValues[priceMatchHandle];
  const fillAmountValue = result.clearValues[effectiveFillHandle];
  if (priceMatchValue === undefined || fillAmountValue === undefined) {
    throw new Error("Public decrypt missing clear values for settle fill");
  }

  return {
    priceMatched: BigInt(priceMatchValue as number | string | bigint) !== 0n,
    fillAmount: BigInt(fillAmountValue as number | string | bigint),
    handlesList: [priceMatchHandle, effectiveFillHandle],
    cleartexts: result.abiEncodedClearValues,
    decryptionProof: result.decryptionProof,
  };
}

export async function decryptOrderPriceAmount(
  orderId: number,
  account: string,
): Promise<{ price: number; amount: number }> {
  const { otcRead, CONTRACT_ADDRESS } = await import("./contract");
  const [encPrice, encAmount] = await Promise.all([
    otcRead<string>("getPrice", [orderId]),
    otcRead<string>("getAmount", [orderId]),
  ]);
  const results = await decryptValues(
    [
      { handle: encPrice.toString(), contractAddress: CONTRACT_ADDRESS },
      { handle: encAmount.toString(), contractAddress: CONTRACT_ADDRESS },
    ],
    account,
  );
  const values = [...results.values()];
  return {
    price: unscaleFromFHE(Number(values[0] || 0n)),
    amount: unscaleFromFHE(Number(values[1] || 0n)),
  };
}
