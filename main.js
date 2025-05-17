const { ethers } = require('ethers');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const randomUseragent = require('random-useragent');
const axios = require('axios');

// --- CONFIG ---
const networkConfig = {
  name: 'Pharos Testnet',
  chainId: 688688,
  rpcUrl: 'https://testnet.dplabs-internal.com',
  currencySymbol: 'PHRS',
};
const ROUTER_ADDRESS = "0xf8a1d4ff0f9b9af7ce58e1fc1833688f3bfd6115";
const PHRS_ADDRESS = "0x76aaaDA469D23216bE5f7C596fA25F282Ff9b364";
const STABLE_COINS = [
  "0xad902cf99c2de2f1ba5ec4d642fd7e49cae9ee37", // USDC
  "0xed59de2d7ad9c043442e381231ee3646fc3c2939" // USDT
];
const TOKEN_SYMBOLS = {
  "0xad902cf99c2de2f1ba5ec4d642fd7e49cae9ee37": "USDC",
  "0xed59de2d7ad9c043442e381231ee3646fc3c2939": "USDT"
};
const routerAbi = [
  "function multicall(bytes[] data) payable",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function refundETH() payable"
];
const erc20Abi = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// --- WALLET LOADING ---
function loadWalletsFromFile(filename = 'wallet.txt') {
  try {
    return fs.readFileSync(filename, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && line.startsWith('0x'));
  } catch (error) {
    console.log('No wallet.txt found or failed to load.');
    return [];
  }
}

// --- PROXY & PROVIDER ---
const loadProxies = () => {
  try {
    const proxies = fs.readFileSync('proxies.txt', 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line);
    return proxies;
  } catch (error) {
    console.log('No proxies.txt found or failed to load, switching to direct mode');
    return [];
  }
};

const getRandomProxy = (proxies) => {
  return proxies[Math.floor(Math.random() * proxies.length)];
};

const setupProvider = (proxy = null) => {
  if (proxy) {
    const agent = new HttpsProxyAgent(proxy);
    return new ethers.JsonRpcProvider(networkConfig.rpcUrl, {
      chainId: networkConfig.chainId,
      name: networkConfig.name,
    }, {
      fetchOptions: { agent },
      headers: { 'User-Agent': randomUseragent.getRandom() },
    });
  } else {
    return new ethers.JsonRpcProvider(networkConfig.rpcUrl, {
      chainId: networkConfig.chainId,
      name: networkConfig.name,
    });
  }
};

// --- ERC20 APPROVAL (no logs) ---
async function ensureApproval(wallet, tokenAddress, spender, requiredAmount) {
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  const allowance = await token.allowance(wallet.address, spender);
  if (BigInt(allowance) < BigInt(requiredAmount)) {
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait();
  }
}

// --- ADD LP (ONE LP PER CALL) ---
async function addLp(wallet, token1, symbol) {
  const router = new ethers.Contract(ROUTER_ADDRESS, routerAbi, wallet);

  // --- LP PARAMETERS (adjust as needed) ---
  const fee = 500;
  const amount0Desired = "100000000000";
  const amount1Desired = "8779257879444";
  const amount0Min = "0";
  const amount1Min = "0";
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const value = ethers.parseUnits("0.0000001", 18);
  const baseTickLower = 51530;
  const baseTickUpper = 51550;
  const tickLower = baseTickLower;
  const tickUpper = baseTickUpper;

  await ensureApproval(wallet, PHRS_ADDRESS, ROUTER_ADDRESS, amount0Desired);
  await ensureApproval(wallet, token1, ROUTER_ADDRESS, amount1Desired);

  const mintParams = {
    token0: PHRS_ADDRESS,
    token1: token1,
    fee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min,
    amount1Min,
    recipient: wallet.address,
    deadline
  };
  const mintData = router.interface.encodeFunctionData("mint", [mintParams]);
  const refundData = router.interface.encodeFunctionData("refundETH", []);
  const multicallData = [mintData, refundData];

  try {
    const tx = await router.multicall(multicallData, {
      value: value,
      gasLimit: 500_000,
    });
    await tx.wait();
    return tx.hash;
  } catch (e) {
    return null;
  }
}

async function performSwap(privateKey, address, provider, swapIdx, symbolOut, amountStr, totalSwap, walletIdx, totalWallets) {
  const wallet = new ethers.Wallet(privateKey, provider);
  try {
    const stable = symbolOut === "USDC" ? STABLE_COINS[0] : STABLE_COINS[1];
    const amount = amountStr ? amountStr : (Math.random() * 0.0008 + 0.0001).toFixed(4);
    const amountWei = ethers.parseEther(amount);

    const path = PHRS_ADDRESS.slice(2).padStart(64, '0') + stable.slice(2).padStart(64, '0');
    const amountHex = amountWei.toString(16).padStart(64, '0');
    const data = "0x04e45aaf"
      + path
      + "0000000000000000000000000000000000000000000000000000000000000bb8"
      + address.toLowerCase().slice(2).padStart(64, '0')
      + amountHex
      + "0000000000000000000000000000000000000000000000000000000000000000"
      + "0000000000000000000000000000000000000000000000000000000000000000";

    const deadline = Math.floor(Date.now() / 1000) + 600;
    const multicallAbi = [
      "function multicall(uint256 deadline, bytes[] calldata data) payable"
    ];
    const contract = new ethers.Contract(
      "0x1a4de519154ae51200b0ad7c90f7fac75547888a",
      multicallAbi,
      wallet
    );
    const multicallData = contract.interface.encodeFunctionData("multicall", [deadline, [data]]);
    const feeData = await provider.getFeeData();

    const tx = {
      to: contract.target,
      data: multicallData,
      value: amountWei,
      gasPrice: feeData.gasPrice,
      nonce: await provider.getTransactionCount(address, "pending"),
      chainId: 688688
    };
    tx.gasLimit = (await provider.estimateGas(tx)) * 12n / 10n;

    const sentTx = await wallet.sendTransaction(tx);
    const receipt = await sentTx.wait();

    // --- CUSTOM LOG STYLE ---
    console.log(`[${walletIdx + 1}/${totalWallets}] [${swapIdx + 1}/${totalSwap}] Swap ${amount} PHRS → ${symbolOut} Completed: ${receipt.hash}`);
    return receipt;
  } catch (err) {
    console.error(`[${walletIdx + 1}/${totalWallets}] [${swapIdx + 1}/${totalSwap}] Swap error: ${err.message}`);
    // Do not throw to continue on error
  }
}

const transferPHRS = async (wallet, provider, index, totalTransfer, walletIdx, totalWallets) => {
  try {
    const amount = 0.000001;
    const randomWallet = ethers.Wallet.createRandom();
    const toAddress = randomWallet.address;
    const balance = await provider.getBalance(wallet.address);
    const required = ethers.parseEther(amount.toString());

    if (balance < required) {
      return;
    }

    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: required,
      gasLimit: 21000,
      gasPrice: 0,
    });

    const receipt = await tx.wait();
    // --- LOG AS [wallet/total] [tx/total]Transfer completed: ... ---
    const space = index === 1 ? ' ' : '';
    console.log(`[${walletIdx + 1}/${totalWallets}] [${index + 1}/${totalTransfer}${space}]Transfer completed: ${receipt.hash}`);
  } catch (error) {
    console.error(`[${walletIdx + 1}/${totalWallets}] [${index + 1}/${totalTransfer}] Transfer error: ${error.message}`);
    // Do not throw to continue on error
  }
};

const claimFaucet = async (wallet, proxy = null, walletIdx = 0, totalWallets = 1) => {
  try {
    console.log(`Checking faucet eligibility for wallet: [${walletIdx + 1}/${totalWallets}]${wallet.address}`);
    const message = "pharos";
    const signature = await wallet.signMessage(message);
    const loginUrl = `https://api.pharosnetwork.xyz/user/login?address=${wallet.address}&signature=${signature}&invite_code=rfX8jGZPEp7MiFJ1`;
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.8",
      authorization: "Bearer null",
      "sec-ch-ua": '"Chromium";v="136", "Brave";v="136", "Not.A/Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "sec-gpc": "1",
      Referer: "https://testnet.pharosnetwork.xyz/",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "User-Agent": randomUseragent.getRandom(),
    };
    const axiosConfig = {
      method: 'post',
      url: loginUrl,
      headers,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    };
    const loginResponse = await axios(axiosConfig);
    const loginData = loginResponse.data;
    if (loginData.code !== 0 || !loginData.data.jwt) {
      console.log(`Login failed for faucet: [${walletIdx + 1}/${totalWallets}]${loginData.msg || 'Unknown error'}`);
      return false;
    }
    const jwt = loginData.data.jwt;
    const statusUrl = `https://api.pharosnetwork.xyz/faucet/status?address=${wallet.address}`;
    const statusHeaders = {
      ...headers,
      authorization: `Bearer ${jwt}`,
    };
    const statusResponse = await axios({
      method: 'get',
      url: statusUrl,
      headers: statusHeaders,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    });
    const statusData = statusResponse.data;
    if (statusData.code !== 0 || !statusData.data) {
      console.log(`Faucet status check failed: [${walletIdx + 1}/${totalWallets}]${statusData.msg || 'Unknown error'}`);
      return false;
    }
    if (!statusData.data.is_able_to_faucet) {
      const nextAvailable = new Date(statusData.data.avaliable_timestamp * 1000).toLocaleString('en-US', { timeZone: 'Asia/Makassar' });
      console.log(`Faucet not available until: [${walletIdx + 1}/${totalWallets}]${nextAvailable}`);
      return false;
    }
    const claimUrl = `https://api.pharosnetwork.xyz/faucet/daily?address=${wallet.address}`;
    const claimResponse = await axios({
      method: 'post',
      url: claimUrl,
      headers: statusHeaders,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    });
    const claimData = claimResponse.data;
    if (claimData.code === 0) {
      console.log(`Faucet claimed successfully for [${walletIdx + 1}/${totalWallets}]${wallet.address}`);
      return true;
    } else {
      console.log(`Faucet claim failed: [${walletIdx + 1}/${totalWallets}]${claimData.msg || 'Unknown error'}`);
      return false;
    }
  } catch (error) {
    console.log(`Faucet claim failed for [${walletIdx + 1}/${totalWallets}]${wallet.address}: ${error.message}`);
    return false;
  }
};

const performCheckIn = async (wallet, proxy = null, walletIdx = 0, totalWallets = 1) => {
  try {
    console.log(`Performing daily check-in for wallet: [${walletIdx + 1}/${totalWallets}]${wallet.address}`);
    const message = "pharos";
    const signature = await wallet.signMessage(message);
    const loginUrl = `https://api.pharosnetwork.xyz/user/login?address=${wallet.address}&signature=${signature}&invite_code=rfX8jGZPEp7MiFJ1`;
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.8",
      authorization: "Bearer null",
      "sec-ch-ua": '"Chromium";v="136", "Brave";v="136", "Not.A/Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "sec-gpc": "1",
      Referer: "https://testnet.pharosnetwork.xyz/",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "User-Agent": randomUseragent.getRandom(),
    };
    const axiosConfig = {
      method: 'post',
      url: loginUrl,
      headers,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    };
    const loginResponse = await axios(axiosConfig);
    const loginData = loginResponse.data;
    if (loginData.code !== 0 || !loginData.data.jwt) {
      console.log(`Login failed: [${walletIdx + 1}/${totalWallets}]${loginData.msg || 'Unknown error'}`);
      return false;
    }
    const jwt = loginData.data.jwt;
    const checkInUrl = `https://api.pharosnetwork.xyz/sign/in?address=${wallet.address}`;
    const checkInHeaders = {
      ...headers,
      authorization: `Bearer ${jwt}`,
    };
    const checkInResponse = await axios({
      method: 'post',
      url: checkInUrl,
      headers: checkInHeaders,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    });
    const checkInData = checkInResponse.data;
    if (checkInData.code === 0) {
      console.log(`Check-in successful for [${walletIdx + 1}/${totalWallets}]${wallet.address}`);
      return true;
    } else {
      console.log(`Check-in failed, possibly already checked in: [${walletIdx + 1}/${totalWallets}]${checkInData.msg || 'Unknown error'}`);
      return false;
    }
  } catch (error) {
    console.log(`Check-in failed for [${walletIdx + 1}/${totalWallets}]${wallet.address}: ${error.message}`);
    return false;
  }
};

// --- SHUFFLE HELPER ---
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// --- COUNTDOWN ---
const countdown = async () => {
  const totalSeconds = 24 * 60 * 60; // 24 hours
  console.log('Starting 24-hour countdown...');

  for (let seconds = totalSeconds; seconds >= 0; seconds--) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    process.stdout.write(`\rTime remaining: ${hours}h ${minutes}m ${secs}s `);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  process.stdout.write('\rCountdown complete! Restarting process...\n');
};

// --- MAIN LOOP ---
const main = async () => {
  const proxies = loadProxies();
  const privateKeys = loadWalletsFromFile('wallet.txt');
  const totalWallets = privateKeys.length;
  if (!totalWallets) {
    console.log('No private keys found in wallet.txt');
    return;
  }

  // Set your desired numbers for each action
  const TOTAL_TRANSFER = 30;
  const TOTAL_SWAP = 30;
  const TOTAL_LP = 30;

  while (true) {
    for (let walletIdx = 0; walletIdx < privateKeys.length; walletIdx++) {
      const privateKey = privateKeys[walletIdx];
      const proxy = proxies.length ? getRandomProxy(proxies) : null;
      const provider = setupProvider(proxy);
      const wallet = new ethers.Wallet(privateKey, provider);

      console.log(`Using wallet: [${walletIdx + 1}/${totalWallets}]${wallet.address}`);
      await claimFaucet(wallet, proxy, walletIdx, totalWallets);
      await performCheckIn(wallet, proxy, walletIdx, totalWallets);

      // Define action functions
      const transferAction = async () => {
        for (let i = 0; i < TOTAL_TRANSFER; i++) {
          await transferPHRS(wallet, provider, i, TOTAL_TRANSFER, walletIdx, totalWallets);
          // Delay: random between 2 and 5 seconds
          await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));
        }
      };

      const swapAction = async () => {
        for (let i = 0; i < TOTAL_SWAP; i++) {
          const symbolOut = Math.random() < 0.5 ? "USDC" : "USDT";
          const amount = (Math.random() * 0.0008 + 0.0001).toFixed(4);
          await performSwap(privateKey, wallet.address, provider, i, symbolOut, amount, TOTAL_SWAP, walletIdx, totalWallets);
          // Delay: random between 2 and 5 seconds
          await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));
        }
      };

      const addLpAction = async () => {
        for (let i = 0; i < TOTAL_LP; i++) {
          try {
            const token1 = STABLE_COINS[Math.floor(Math.random() * STABLE_COINS.length)];
            const symbol = TOKEN_SYMBOLS[token1] || "UNKNOWN";
            const hash = await addLp(wallet, token1, symbol);
            if (hash) {
              console.log(`[${walletIdx + 1}/${totalWallets}] [${i + 1}/${TOTAL_LP}] Add LP ${symbol} hash ${hash}`);
            } else {
              console.log(`[${walletIdx + 1}/${totalWallets}] [${i + 1}/${TOTAL_LP}] Add LP ${symbol} failed`);
            }
          } catch (err) {
            console.error(`[${walletIdx + 1}/${totalWallets}] [${i + 1}/${TOTAL_LP}] Add LP error: ${err.message}`);
          }
          // Delay: random between 2 and 5 seconds
          await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));
        }
      };

      // Put actions in an array and shuffle
      const actions = [transferAction, swapAction, addLpAction];
      shuffle(actions);

      // Run actions in random order
      for (const action of actions) {
        await action();
      }
    }

    console.log('All actions completed for all wallets!');
    await countdown();
  }
};

main().catch(error => {
  console.log(`Bot failed: ${error.message}`);
  process.exit(1);
});
