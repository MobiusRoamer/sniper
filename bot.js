const fs = require("fs");
const { WebSocketProvider, Wallet, Contract, formatEther, paseEther, parseEther} = require("ethers");
const ccxt = require("ccxt");
require("dotenv").config();
const blockchain = require("./blockchain.json");

const provider = new WebSocketProvider(process.env.LOCAL_RPC_URL_WS);
const wallet = Wallet.fromPhrase(process.env.MNEMONIC, provider);
const factory = new Contract(blockchain.factoryAddress, blockchain.factoryAbi, provider);
const router = new Contract(blockchain.routerAddress, blockchain.routerAbi, wallet);
const binance = new ccxt.binance({apiKey : process.env.BINANCE_API_KEY, secret: process.env.BINANCE_SECRET });

const NEW_COINS = [];
const SNIPE_LIST = [];
const TOKEN_LIST = [];
const MIN_LIQUIDITY = parseEther("0.1");
const AMOUNT_IN = parseEther("0.1");
const SLIPPAGE = 0.05;
const GAS_LIMIT = 300000;
const BINANCE_FEE = 0.001;

const getBinancePrice = async (symbol) => {
    try {
        const ticker = await binance.fetchTicker(symbol);
        return parseFloat(ticker.last);
    } catch (e) {
        console.error(`Binance API error for ${symbol}: ${e}`);
        return null;
    }
};

const getUniswapPrice = async (tokenIn, tokenOut, amountIn) => {
    try {
        const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
        return parseFloat(formatEther(amounts[1])) / parseFloat(formatEther(amountIn));
    } catch (e) {
        console.error(`Uniswap price error for ${tokenOut}: ${e}`);
        return null;
    }
};

const fetchNewBinanceListings = async () => {
    try {
        const markets = await binance.loadMarkets();
        const newSymbols = Object.keys(markets).filter(s => s.endsWith("USDT") && !NEW_COINS.find(c => c.symbol === s));
        for (const symbol of newSymbols) {
            // Fetch token address (placeholder; use Etherscan/BNBScan API or DEX)
            const tokenAddress = await getTokenAddress(symbol.split("/")[0]);
            if (tokenAddress) {
                NEW_COINS.push({ symbol, tokenAddress });
                console.log(`New Binance listing: ${symbol}, Token: ${tokenAddress}`);
            }
        }
    } catch (e) {
        console.error(`Error fetching Binance listings: ${e}`);
    }
};

const getTokenAddress = async (symbol) => {
    // Placeholder: Fetch token address from Etherscan/BNBScan or DEX
    // Example for $BDXN: "0x..." (replace with actual lookup)
    return "0x..."; // Implement API call to Etherscan/BNBScan
};

const init = () => {
    factory.on("PairCreated", (token0, token1, pairAddress) => {
        console.log(`New pair: ${pairAddress}, token0: ${token0}, token1: ${token1}`);
        if (token0 !== blockchain.WETHAddress && token1 !== blockchain.WETHAddress) return;
        const newCoin = NEW_COINS.find(c => c.tokenAddress.toLowerCase() === token0.toLowerCase() || c.tokenAddress.toLowerCase() === token1.toLowerCase());
        if (!newCoin) return;
        const t0 = token0 === blockchain.WETHAddress ? token0 : token1;
        const t1 = token1 === blockchain.WETHAddress ? token1 : token0;
        SNIPE_LIST.push({ pairAddress, tokenIn: t0, tokenOut: t1, symbol: newCoin.symbol });
        console.log(`Added ${newCoin.symbol} pair to snipe list`);
    });
};

const snipe = async () => {
    console.log("Snipe Loop");
    for (let i = 0; i < SNIPE_LIST.length; i++) {
        const snipe = SNIPE_LIST[i];
        const { pairAddress, tokenIn, tokenOut, symbol } = snipe;
        console.log(`Trying to snipe ${symbol} on ${pairAddress}`);
        const pair = new Contract(pairAddress, blockchain.pairAbi, wallet);
        const totalSupply = await pair.totalSupply();
        if (totalSupply < MIN_LIQUIDITY) {
            console.log(`Pool empty, snipe cancelled: ${pairAddress}`);
            continue;
        }
        try {
            const amounts = await router.getAmountsOut(AMOUNT_IN, [tokenIn, tokenOut]);
            const amountOutMin = amounts[1] * (1n - BigInt(Math.floor(SLIPPAGE * 100))) / 100n;
            console.log(`Buying: ${formatEther(AMOUNT_IN)} WETH for ${formatEther(amountOutMin)} ${symbol}`);
            const tx = await router.swapExactTokensForTokens(
                AMOUNT_IN,
                amountOutMin,
                [tokenIn, tokenOut],
                blockchain.recipient,
                Date.now() + 1000 * 60 * 10,
                { gasLimit: GAS_LIMIT }
            );
            const receipt = await tx.wait();
            if (receipt.status === 1) {
                console.log(`Snipe successful for ${symbol}: ${receipt.transactionHash}`);
                TOKEN_LIST.push({
                    blockNumber: receipt.blockNumber,
                    tokenIn,
                    tokenOut,
                    price: Number(formatEther(amountOutMin)) / Number(formatEther(AMOUNT_IN)),
                    symbol
                });
                SNIPE_LIST.splice(i, 1);
                i--;
            }
        } catch (e) {
            console.error(`Snipe failed for ${symbol}: ${e}`);
        }
    }
};

const managePosition = async () => {
    for (let i = 0; i < TOKEN_LIST.length; i++) {
        const token = TOKEN_LIST[i];
        const { tokenOut, price: entryPrice, symbol } = token;
        const dexPrice = await getUniswapPrice(tokenOut, blockchain.WETHAddress, parseEther("1"));
        if (!dexPrice) continue;
        const binancePrice = await getBinancePrice(symbol);
        if (!binancePrice) continue;
        // Stop-loss: Sell if price drops 20% below entry
        if (dexPrice < entryPrice * 0.8) {
            await sellToken(tokenOut, AMOUNT_IN, blockchain.WETHAddress, symbol);
            TOKEN_LIST.splice(i, 1);
            i--;
            continue;
        }
        // Take-profit: Sell if price rises 50% above entry
        if (dexPrice > entryPrice * 1.5) {
            await sellToken(tokenOut, AMOUNT_IN, blockchain.WETHAddress, symbol);
            TOKEN_LIST.splice(i, 1);
            i--;
            continue;
        }
        // CEX-DEX Arbitrage: Buy on DEX, sell on Binance
        if (binancePrice > dexPrice * (1 + SLIPPAGE + BINANCE_FEE)) {
            await sellToken(tokenOut, AMOUNT_IN, blockchain.WETHAddress, symbol);
            console.log(`Arbitrage: Buy DEX at ${dexPrice}, Sell Binance at ${binancePrice} for ${symbol}`);
            try {
                await binance.createMarketSellOrder(symbol, Number(formatEther(AMOUNT_IN)));
                console.log(`Sold ${symbol} on Binance`);
            } catch (e) {
                console.error(`Binance sell failed for ${symbol}: ${e}`);
            }
            TOKEN_LIST.splice(i, 1);
            i--;
        }
        // CEX-DEX Arbitrage: Buy on Binance, sell on DEX
        if (dexPrice > binancePrice * (1 + SLIPPAGE + BINANCE_FEE)) {
            console.log(`Arbitrage: Buy Binance at ${binancePrice}, Sell DEX at ${dexPrice} for ${symbol}`);
            try {
                await binance.createMarketBuyOrder(symbol, Number(formatEther(AMOUNT_IN)));
                await sellToken(tokenOut, AMOUNT_IN, blockchain.WETHAddress, symbol);
                console.log(`Bought ${symbol} on Binance, sold on DEX`);
            } catch (e) {
                console.error(`Binance buy/DEX sell failed for ${symbol}: ${e}`);
            }
        }
    }
};

const sellToken = async (tokenIn, amountIn, tokenOut, symbol) => {
    try {
        const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
        const amountOutMin = amounts[1] * (1n - BigInt(Math.floor(SLIPPAGE * 100))) / 100n;
        const tx = await router.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            [tokenIn, tokenOut],
            blockchain.recipient,
            Date.now() + 1000 * 60 * 10,
            { gasLimit: GAS_LIMIT }
        );
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            console.log(`Sell successful for ${symbol}: ${receipt.transactionHash}`);
        }
    } catch (e) {
        console.error(`Sell failed for ${symbol}: ${e}`);
    }
};

const timeout = ms => {
    return new Promise(resolve => setTimeout(resolve, ms)); //gets total supply of the liquiidty provider token, one supplies a token into the pool and get a pool token
};

const main = async () => {
    console.log(`Trading bot starting...`);
    init();
    while(true){
        console.log(`Heartbeat`);
        await fetchNewBinanceListings();
        await snipe()
        await managePosition(); //if we buy and sell ourselves we dont need the managePosition
        await timeout(3000);
    }
};

main().catch(console.error); 