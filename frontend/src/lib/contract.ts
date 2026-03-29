import { BrowserProvider, Contract } from "ethers";
import ABI from "./abi.json";

// Will be set after deployment to Sepolia
export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";

export const SEPOLIA_CHAIN_ID = 11155111;

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

export async function connectWallet(): Promise<string> {
  const provider = getProvider();
  const accounts = await provider.send("eth_requestAccounts", []);
  return accounts[0];
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

export type OrderData = {
  id: number;
  maker: string;
  taker: string;
  tokenPair: string;
  isBuy: boolean;
  status: number; // 0=Open, 1=Filled, 2=Cancelled
  createdAt: number;
};

export async function fetchAllOrders(): Promise<OrderData[]> {
  const contract = await getContract();
  const count = await contract.orderCount();
  const orders: OrderData[] = [];
  for (let i = 0; i < Number(count); i++) {
    const o = await contract.getOrder(i);
    orders.push({
      id: i,
      maker: o.maker,
      taker: o.taker,
      tokenPair: o.tokenPair,
      isBuy: o.isBuy,
      status: Number(o.status),
      createdAt: Number(o.createdAt),
    });
  }
  return orders;
}
