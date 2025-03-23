
const fs = require("fs");
const { WebSocketProvider} = require("ethers");
const { Contract } = require('ethers');
require("dotenv").config();
const blockchain = require("./blockchain.json");
const { text } = require("stream/consumers");

const provider = new WebSocketProvider(process.env.LOCAL_RPC_URL_WS);
const wallet = Wallet.fromPhrase(process.env.MNEMONIC,provider);
const factory = new Contract(
    blockchain.factoryAddress,
    blockchain.factoryAbi,
    provider
);

//define router
const router = new Contract(
    blockchain.routerAddress,
    blockchain.routerAbi,
    wallet
);

const SNIPE_LIST_FILE="snipeList.csv";
const TOKEN_LIST_FILE = "tokenList.csv";

const init = () => {
    //setup an event listener / monitor for the new liquidity pool, basically from uniswap whatever is "emitted" we can listen
    factory.on("PairCreated", (token0, token1, pairAddress)=>{
        console.log(`
            New pair detected 
            =================
            pairAddress: ${pairAddress}
            token0:${token0}
            token1:${token1}
            `);
            if (token0 !==blockchain.WETHAddress && token1 !== blockchain.WETHAddress) return;
                const t0 = token0 === blockchain.WETHAddress ? token0 : token1;
                const t1 = token1 === blockchain.WETHAddress ? token1 : token0; 
            fs.appendFileSync(SNIPE_LIST_FILE, `${pairAddress}, ${t0},${t1}\n`);
    });
}

const snipe = async() =>{
    console.log(`Snipe Loop`);
    let snipeList = fs.readFileSync(SNIPE_LIST_FILE);
    snipeList = snipeList.toString().split("\n").filter(snipe=> snipe!=="");
    if (snipeList.length ===0) return;
    for(const snipe of snipeList){
        const [pairAddress, WETHAddress, tokenAddress] = snipe.split(",");
        console.log(`Trying to snipe ${tokenAddress} on ${pairAddress}`);

        const pair = new Contract(pairAddress.blockchain.pairAbi, wallet);
    

    const totalSupply = await pair.totalSupply();
    if(totalSupply === 0n) {
        console.log(`Pool is empty, snipe cancelled`);
        continue;
    }

    // if there is liquidity we snipe
    const tokenIn = WETHAddress;
    const tokenOut = tokenAddress;

    //buy [0.1] ETH of new token (can change the amount)
    const amountIn = parseEther("0.1");
    //Router is an interface of uniswap
    const amounts = await router.getAmountOut(amountIn, [tokenIn, tokenOut]);
    //define a price tolerance
    const amountOutMin = amounts[1] - amount[1] * 5n / 100n; //can adjust the percentages
    console.log(`
        Buying new token 
        ================
        tokenIn: ${amountIn, toString()} ${tokenIn} (WETH)
        tokenOut: ${amountOutMin.toString()} ${tokenOut}
        `);
    router.swapExactTokensForTokens(
        amountIn, amountOutMin, [tokenIn, tokenOut], blockchain.recipient, 
        Date.now() + 1000 * 60 * 10 //Timestamps in milliseconds, here we mean plus ten minutes
    );
    const receipt = await tx.wait();
    console.log(`Transaction receipt: ${receipt}`);

    //To get the token price
    // const balanceWethBefore //weth = new Contract()...
    //const balanceWethAfter
    //const balanceTokenAfter
    //const price = balanceTokenAfter / (balanceWethBefore-balanceWethAfter) //execution price might be different ffrom submission time price

    if (receipt.status ==="1") {
        //1. add the token to list of token purcahsed
        fs.appendFileSync(TOKEN_LIST_FILE, `${receipt.blockNumber}, ${WETHAddress}, ${tokenAddress}, ${amountOutMin / amountIn}\n`);
        //2. remove the token from the snipeList
        
    }
    
}
};

const managePosition = async () =>{
    //1. stop loss
    //2. take profit
}


const timeout = ms => {
    return new Promise(resolve => setTimeout(resolve, ms)); //gets total supply of the liquiidty provider token, one supplies a token into the pool and get a pool token
};

const main = async () => {
    console.log(`Trading bot starting...`);
    init();
    while(true){
        console.log(`Heartbeat`);
        await snipe()
        await managePosition(); //if we buy and sell ourselves we dont need the managePosition
        await timeout(3000);
    }
};

main(); 