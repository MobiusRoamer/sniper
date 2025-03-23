const { WebSocketProvider, Wallet, 
    Contract,//a uniswap v2 item that allows one to create new liquidity pools
    ContractFactory, //A js object that allows one to create new smart contracts
    parseEther
} = require("ethers");
require("dotenv").config();
const blockchain = require("./blockchain.json");

const provider = new WebSocketProvider(process.env.LOCAL_RPC_URL_HTTP); //change to JsonRPCProvider?
const wallet = Wallet.fromPhrase(process.env.MNEMONIC,provider);
const erc20Developer = new ContractFactory(
    blockchain.erc20Abi,
    blockchain.erc20Bytecode,
    wallet

);

const uniswapFactory = new Contract(
    blockchain.factoryAddress,
    blockchain.factoryAbi,
    wallet

);

const main = async () => {
    console.log("Deploying token...");
    const token = await erc20Developer.deploy("ABC Token", "ABC", parseEther("1000000000"));
    console.log("Transaction sent:", token.deploymentTransaction.hash);
    await token.waitForDeployment();
    console.log(`Test token deployed: ${token.target}`);

    const tx = uniswapFactory.createPair(blockchain.WETHAddress, token.target);
    const receipt = await tx.wait();
    console.log("Test liquidity pool deployed");
};

main();
