import { initFhevm, createInstance, type FhevmInstance } from "fhevmjs";
import { CONTRACT_ADDRESS, getProvider } from "./contract";

// Sepolia fhEVM contract addresses
const ACL_ADDRESS = "0x2Fb4341027eb1d2aD8B5D9708187f8f5E423573a";
const KMS_ADDRESS = "0x9D6891A6240D6130c54ae243d8005063D05fE14b";
const GATEWAY_URL = "https://gateway.sepolia.zama.ai";

let instance: FhevmInstance | null = null;

export async function getFhevmInstance(): Promise<FhevmInstance> {
  if (instance) return instance;

  await initFhevm();

  instance = await createInstance({
    kmsContractAddress: KMS_ADDRESS,
    aclContractAddress: ACL_ADDRESS,
    network: window.ethereum,
    gatewayUrl: GATEWAY_URL,
  });

  return instance;
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
  input.add64(price);
  input.add64(amount);
  const encrypted = await input.encrypt();
  return encrypted;
}

export async function decryptValue(
  handle: bigint,
  contractAddress: string,
  userAddress: string,
): Promise<bigint> {
  const fhevmInstance = await getFhevmInstance();
  const { publicKey, privateKey } = fhevmInstance.generateKeypair();

  const provider = getProvider();
  const signer = await provider.getSigner();

  const eip712 = fhevmInstance.createEIP712(publicKey, contractAddress);
  const signature = await signer.signTypedData(
    eip712.domain,
    { Reencrypt: eip712.types.Reencrypt },
    eip712.message,
  );

  return fhevmInstance.reencrypt(
    handle,
    privateKey,
    publicKey,
    signature,
    contractAddress,
    userAddress,
  );
}
