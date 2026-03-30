import { BrowserProvider, Contract, getAddress, parseUnits, formatUnits } from "ethers";
import ABI from "./abi.json";

export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";
export const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const CWETH_ADDRESS = import.meta.env.VITE_CWETH_ADDRESS || "";
export const CUSDC_ADDRESS = import.meta.env.VITE_CUSDC_ADDRESS || "";
export const SEPOLIA_CHAIN_ID = 11155111;

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export function getProvider() {
  if (!window.ethereum) throw new Error("MetaMask not found");
  return new BrowserProvider(window.ethereum);
}

export async function getSigner() {
  const provider = getProvider();
  return provider.getSigner();
}

export async function getContract(withSigner = false) {
  if (!CONTRACT_ADDRESS) throw new Error("Contract address not configured");
  if (withSigner) {
    const signer = await getSigner();
    return new Contract(CONTRACT_ADDRESS, ABI, signer);
  }
  const provider = getProvider();
  return new Contract(CONTRACT_ADDRESS, ABI, provider);
}

export async function getUSDC(withSigner = false) {
  if (withSigner) {
    const signer = await getSigner();
    return new Contract(USDC_ADDRESS, ERC20_ABI, signer);
  }
  const provider = getProvider();
  return new Contract(USDC_ADDRESS, ERC20_ABI, provider);
}

export async function getUSDCBalance(address: string): Promise<string> {
  const usdc = await getUSDC();
  const balance = await usdc.balanceOf(address);
  return formatUnits(balance, 6); // USDC has 6 decimals
}

export async function approveCUSDC(amount: string): Promise<void> {
  const signer = await getSigner();
  const address = await signer.getAddress();
  const cusdc = await getCUSDC();
  const needed = parseUnits(amount, 6);
  const allowance = await cusdc.allowance(address, CONTRACT_ADDRESS);
  // Skip if already authorized enough
  if (allowance >= needed) return;
  // Only approve the needed amount
  const cusdcWithSigner = await getCUSDC(true);
  const tx = await cusdcWithSigner.approve(CONTRACT_ADDRESS, needed);
  await tx.wait();
}

export async function approveCWETH(amount: string): Promise<void> {
  const signer = await getSigner();
  const address = await signer.getAddress();
  const cweth = await getCWETH();
  const needed = parseUnits(amount, 18);
  const allowance = await cweth.allowance(address, CONTRACT_ADDRESS);
  // Skip if already authorized enough
  if (allowance >= needed) return;
  // Only approve the needed amount
  const cwethWithSigner = await getCWETH(true);
  const tx = await cwethWithSigner.approve(CONTRACT_ADDRESS, needed);
  await tx.wait();
}

export async function connectWallet(): Promise<string> {
  const provider = getProvider();
  const accounts = await provider.send("eth_requestAccounts", []);
  return getAddress(accounts[0]);
}

export async function switchToSepolia() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    });
  } catch (err: unknown) {
    if ((err as { code: number }).code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0xaa36a7",
            chainName: "Sepolia",
            rpcUrls: ["https://rpc.sepolia.org"],
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          },
        ],
      });
    }
  }
}

export async function getETHBalance(address: string): Promise<string> {
  const provider = getProvider();
  const balance = await provider.getBalance(address);
  return formatUnits(balance, 18);
}

// Note: cWETH/cUSDC balances are encrypted (euint64). These return the handle.
// To see the actual balance, use decrypt in the Vault page.
// Here we return "encrypted" as a placeholder - actual decrypt happens in Vault.
export async function getCWETHBalance(_address: string): Promise<string> {
  // Encrypted balance - can't read directly. Return "encrypted" indicator.
  // Real balance visible only via Vault decrypt.
  return "🔒";
}

export async function getCUSDCBalance(_address: string): Promise<string> {
  return "🔒";
}

export type OrderData = {
  id: number;
  maker: string;
  tokenPair: string;
  isBuy: boolean;
  status: number;
  createdAt: number;
  baseDeposit: string;
  quoteDeposit: string;
  baseRemaining: string;
  quoteRemaining: string;
};

export async function fetchAllOrders(): Promise<OrderData[]> {
  const contract = await getContract();
  const count = await contract.orderCount();
  const orders: OrderData[] = [];
  for (let i = 0; i < Number(count); i++) {
    const o = await contract.getOrder(i);
    orders.push({
      id: i,
      maker: o.maker ?? o[0],
      tokenPair: o.tokenPair ?? o[1],
      isBuy: o.isBuy ?? o[2],
      status: Number(o.status ?? o[3]),
      createdAt: Number(o.createdAt ?? o[4]),
      baseDeposit: formatUnits(o.baseDeposit ?? o[5] ?? 0n, 18),
      quoteDeposit: formatUnits(o.quoteDeposit ?? o[6] ?? 0n, 6),
      baseRemaining: formatUnits(o.baseRemaining ?? o[7] ?? 0n, 18),
      quoteRemaining: formatUnits(o.quoteRemaining ?? o[8] ?? 0n, 6),
    });
  }
  return orders;
}

export type FillData = {
  orderId: number;
  ethTransferred: string;
  tokenTransferred: string;
  filledAt: number;
};

export async function fetchMyFillIds(): Promise<number[]> {
  const contract = await getContract(true); // needs signer for msg.sender
  const ids: bigint[] = await contract.getMyFills();
  return ids.map((id) => Number(id));
}

export async function fetchFillDetail(fillId: number): Promise<FillData> {
  const contract = await getContract();
  const f = await contract.getFill(fillId);
  return {
    orderId: Number(f.orderId ?? f[0]),
    filledAt: Number(f.filledAt ?? f[1]),
    ethTransferred: formatUnits(f.ethTransferred ?? f[2] ?? 0n, 18),
    tokenTransferred: formatUnits(f.tokenTransferred ?? f[3] ?? 0n, 6),
  };
}

export async function fetchOrderFillIds(orderId: number): Promise<number[]> {
  const contract = await getContract();
  const ids: bigint[] = await contract.getOrderFills(orderId);
  return ids.map((id) => Number(id));
}

// Minimal ABI for confidential tokens (ERC-7984)
const CONFIDENTIAL_TOKEN_ABI = [
  "function wrap() payable",
  "function wrap(uint256 amount) external",
  "function unwrap(uint256 amount) external",
  "function balanceOf(address) view returns (bytes32)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
];

export async function getCWETH(withSigner = false) {
  if (!CWETH_ADDRESS) throw new Error("cWETH contract address not configured");
  if (withSigner) {
    const signer = await getSigner();
    return new Contract(CWETH_ADDRESS, CONFIDENTIAL_TOKEN_ABI, signer);
  }
  const provider = getProvider();
  return new Contract(CWETH_ADDRESS, CONFIDENTIAL_TOKEN_ABI, provider);
}

export async function getCUSDC(withSigner = false) {
  if (!CUSDC_ADDRESS) throw new Error("cUSDC contract address not configured");
  if (withSigner) {
    const signer = await getSigner();
    return new Contract(CUSDC_ADDRESS, CONFIDENTIAL_TOKEN_ABI, signer);
  }
  const provider = getProvider();
  return new Contract(CUSDC_ADDRESS, CONFIDENTIAL_TOKEN_ABI, provider);
}

export async function getPendingFillCount(): Promise<number> {
  const contract = await getContract();
  return Number(await contract.pendingFillCount());
}

export async function requestAccess(orderId: number): Promise<void> {
  const contract = await getContract(true);
  const tx = await contract.requestAccess(orderId);
  await tx.wait();
}

export async function getAccessRequests(orderId: number): Promise<string[]> {
  try {
    const contract = await getContract();
    return await contract.getAccessRequests(orderId);
  } catch {
    return [];
  }
}

export async function getGrantedAddresses(orderId: number): Promise<string[]> {
  try {
    const contract = await getContract();
    return await contract.getGrantedAddresses(orderId);
  } catch {
    return [];
  }
}

export { parseUnits, formatUnits };
