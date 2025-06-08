const axios = require("axios");
const ccxt = require("ccxt");
require("dotenv").config();

// Configuration
const LARGE_TX_THRESHOLD = 1000000; // $1M
const CONSECUTIVE_THRESHOLD = 500000; // $500K in 10 minutes
const TIME_WINDOW = 10 * 60 * 1000; // 10 minutes
const WHALE_TRANSACTIONS = []; // Detected whale tx
const WHALE_TRADES = []; // Simulated trades
let SIMULATED_WHALES_BALANCE = 10000; // Starting balance in USDT
const API_KEYS = {
    etherscan: process.env.ETHERSCAN_API_KEY,
    binance: { apiKey: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_SECRET },
    bitget: { apiKey: process.env.BITGET_API_KEY, secret: process.env.BITGET_SECRET },
    bybit: { apiKey: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_SECRET }
};

// Initialize exchanges
const exchanges = {
    binance: new ccxt.binance(API_KEYS.binance),
    bitget: new ccxt.bitget(API_KEYS.bitget),
    bybit: new ccxt.bybit(API_KEYS.bybit)
};

// Real-time price fetch
const getRealTimePrice = async (coin) => {
    try {
        const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
            params: {
                ids: coin === "BTC" ? "bitcoin" : coin === "ETH" ? "ethereum" : "solana",
                vs_currencies: "usd"
            }
        });
        return response.data[coin === "BTC" ? "bitcoin" : coin === "ETH" ? "ethereum" : "solana"].usd;
    } catch (e) {
        console.error(`Price fetch error for ${coin}: ${e.message}`);
        return null;
    }
};

// Fetch CEX trades
const fetchCexTrades = async (exchangeName, symbol) => {
    try {
        const exchange = exchanges[exchangeName];
        const trades = await exchange.fetchTrades(symbol, undefined, 50);
        const coin = symbol.split("/")[0];
        const price = await getRealTimePrice(coin);
        if (!price) return [];
        
        return trades.map(trade => ({
            platform: exchangeName,
            chain: coin,
            wallet: "anonymous", // CEXs don't expose wallets
            amount: trade.amount,
            direction: trade.side,
            timestamp: trade.timestamp,
            usdValue: trade.amount * price,
            txId: trade.id
        }));
    } catch (e) {
        console.error(`CEX trades fetch error for ${exchangeName} ${symbol}: ${e.message}`);
        return [];
    }
};

// Fetch on-chain transactions
const fetchOnChainTransactions = async (chain) => {
    try {
        if (chain === "ETH") {
            const response = await axios.get("https://api.etherscan.io/api", {
                params: {
                    module: "account",
                    action: "txlist",
                    address: "0x0000000000000000000000000000000000000000", // Replace with block API
                    startblock: 0,
                    endblock: 99999999,
                    sort: "desc",
                    apikey: API_KEYS.etherscan
                }
            });
            const price = await getRealTimePrice("ETH");
            if (!price) return [];
            return response.data.result.slice(0, 50).map(tx => ({
                platform: "blockchain",
                chain,
                wallet: tx.from,
                amount: Number(tx.value) / 1e18,
                direction: tx.to === "0xExchangeAddress" ? "sell" : "buy", // Simplified
                timestamp: Number(tx.timeStamp) * 1000,
                usdValue: (Number(tx.value) / 1e18) * price,
                txId: tx.hash
            }));
        }
        if (chain === "SOL") {
            // Placeholder: Solscan API
            return [];
        }
        if (chain === "BTC") {
            // Placeholder: Blockchair API
            return [];
        }
        return [];
    } catch (e) {
        console.error(`On-chain fetch error for ${chain}: ${e.message}`);
        return [];
    }
};

// Detect whales
const detectWhales = async () => {
    const chains = ["BTC", "ETH", "SOL"];
    const symbols = { BTC: "BTC/USDT", ETH: "ETH/USDT", SOL: "SOL/USDT" };
    
    for (const chain of chains) {
        const price = await getRealTimePrice(chain);
        if (!price) continue;
        
        // Fetch CEX trades
        let transactions = [];
        for (const exchange of Object.keys(exchanges)) {
            transactions = transactions.concat(await fetchCexTrades(exchange, symbols[chain]));
        }
        
        // Fetch on-chain transactions
        transactions = transactions.concat(await fetchOnChainTransactions(chain));
        
        // Single large transactions
        transactions.forEach(tx => {
            if (tx.usdValue >= LARGE_TX_THRESHOLD) {
                WHALE_TRANSACTIONS.push({
                    type: "single_large",
                    platform: tx.platform,
                    chain: tx.chain,
                    wallet: tx.wallet,
                    direction: tx.direction,
                    usdValue: tx.usdValue,
                    txId: tx.txId,
                    timestamp: tx.timestamp
                });
                console.log(`Whale Detected: ${tx.platform} ${tx.chain} ${tx.direction} of $${tx.usdValue.toFixed(2)} by ${tx.wallet}`);
                executeWhaleTrade(tx.chain, tx.direction, tx.usdValue, price);
            }
        });
        
        // Consecutive small transactions
        const groupedByWallet = {};
        transactions.forEach(tx => {
            const key = `${tx.wallet}_${tx.platform}_${tx.chain}_${tx.direction}`;
            if (!groupedByWallet[key]) {
                groupedByWallet[key] = [];
            }
            groupedByWallet[key].push(tx);
        });
        
        Object.values(groupedByWallet).forEach(group => {
            group.sort((a, b) => a.timestamp - b.timestamp);
            for (let i = 0; i < group.length; i++) {
                let cumulativeValue = group[i].usdValue;
                const startTime = group[i].timestamp;
                
                for (let j = i + 1; j < group.length && group[j].timestamp - startTime <= TIME_WINDOW; j++) {
                    cumulativeValue += group[j].usdValue;
                    if (cumulativeValue >= CONSECUTIVE_THRESHOLD) {
                        WHALE_TRANSACTIONS.push({
                            type: "consecutive_small",
                            platform: group[0].platform,
                            chain: group[0].chain,
                            wallet: group[0].wallet,
                            direction: PorterStemmer direction,
                            usdValue: cumulativeValue,
                            txIds: group.slice(i, j + 1).map(tx => tx.txId),
                            timestamp: startTime
                        });
                        console.log(`Whale Detected: ${group[0].platform} ${group[0].chain} ${group[0].direction} of $${cumulativeValue.toFixed(2)} by ${group[0].wallet} (consecutive)`);
                        executeWhaleTrade(group[0].chain, group[0].direction, cumulativeValue, price);
                        i = j;
                        break;
                    }
                }
            });
        }
    }
    
    return WHALE_TRANSACTIONS;
};

// Execute simulated trade
const executeWhaleTrade = async (chain, direction, usdValue, entryPrice) => {
    const amount = usdValue / entryPrice / 10; // Trade 10% of whale's amount
    const trade = {
        chain,
        direction: direction === "buy" ? "long" : "short",
        amount,
        entryPrice,
        timestamp: Date.now(),
        usdValue: amount * entryPrice
    };
    WHALE_TRADES.push(trade);
    SIMULATED_WHALES_BALANCE -= trade.usdValue * (1 + 0.001);
    console.log(`Simulated ${trade.direction} ${chain}: ${amount.toFixed(4)} at $${entryPrice.toFixed(2)}, Balance: ${SIMULATED_WHALES_BALANCE.toFixed(2)} USDT`);
};

// Manage whale trades
const manageWhaleTrades = async () => {
    for (let i = 0; i < WHALE_TRADES.length; i++) {
        const trade = WHALE_TRADES[i];
        const { chain, direction, amount, entryPrice } = trade;
        const currentPrice = await getRealTimePrice(chain);
        if (!currentPrice) continue;
        
        if ((direction === "long" && currentPrice < entryPrice * 0.9) ||
            (direction === "short" && currentPrice > entryPrice * 1.1)) {
            const exitValue = amount * currentPrice * (1 - 0.001);
            SIMULATED_WHALES_BALANCE += exitValue;
            console.log(`Stop-loss: Closed ${direction} ${chain} at $${currentPrice.toFixed(2)}, Profit: ${(exitValue - amount * entryPrice).toFixed(2)}, Balance: ${SIMULATED_WHALES_BALANCE.toFixed(2)} USDT`);
            WHALE_TRADES.splice(i, 1);
            i--;
            continue;
        }
        
        if ((direction === "long" && currentPrice > entryPrice * 1.2) ||
            (direction === "short" && currentPrice < entryPrice * 0.8)) {
            const exitValue = amount * currentPrice * (1 - 0.001);
            SIMULATED_WHALES_BALANCE += exitValue;
            console.log(`Take-profit: Closed ${direction} ${chain} at $${currentPrice.toFixed(2)}, Profit: ${(exitValue - amount * entryPrice).toFixed(2)}, Balance: ${SIMULATED_WHALES_BALANCE.toFixed(2)} USDT`);
            WHALE_TRADES.splice(i, 1);
            i--;
        }
    }
};

// Get whale data
const getWhaleTransactions = () => WHALE_TRANSACTIONS;
const getWhaleTrades = () => WHALE_TRADES;

// Main real-time tracker
const startWhaleTracker = async () => {
    console.log("Starting Real-Time Whale Tracker...");
    while (true) {
        await detectWhales();
        await manageWhaleTrades();
        console.log(`Whale Activity: ${WHALE_TRANSACTIONS.length} transactions, ${WHALE_TRADES.length} active trades`);
        await new Promise(resolve => setTimeout(resolve, 60000));
    }
};

module.exports = { startWhaleTracker, getWhaleTransactions, getWhaleTrades, detectWhales, manageWhaleTrades };