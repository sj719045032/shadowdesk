import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import "./index.css";
import { config } from "./wagmi";
import App from "./App";
import CreateOrder from "./pages/CreateOrder";
import OrderBook from "./pages/OrderBook";
import MyTrades from "./pages/MyTrades";
import OrderDetail from "./pages/OrderDetail";
import Vault from "./pages/Vault";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#3b82f6",
            accentColorForeground: "white",
            borderRadius: "large",
          })}
        >
          <BrowserRouter>
            <Routes>
              <Route element={<App />}>
                <Route index element={<OrderBook />} />
                <Route path="create" element={<CreateOrder />} />
                <Route path="vault" element={<Vault />} />
                <Route path="trades" element={<MyTrades />} />
                <Route path="order/:id" element={<OrderDetail />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
