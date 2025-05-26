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
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)"
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

// --- Robust RPC Provider Creation with Retry ---
async function createProviderWithRetry(rpcUrl, options, proxy = null, maxRetries = 5, delayMs = 10000) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      let provider;
      if (proxy) {
        const agent = new HttpsProxyAgent(proxy);
        provider = new ethers.JsonRpcProvider(rpcUrl, options, {
          fetchOptions: { agent },
          headers: { 'User-Agent': randomUseragent.getRandom() },
        });
      } else {
        provider = new ethers.JsonRpcProvider(rpcUrl, options);
      }
      await provider.getNetwork(); // Triggers eth_chainId
      return provider;
    } catch (err) {
      const code = err.code || (err.error && err.error.code);
      const msg = err.message || (err.error && err.error.message) || String(err);
      if (
        (code === "UNKNOWN_ERROR" && msg.includes("Unable to complete the request")) ||
        (code === -32008)
      ) {
        attempt++;
        console.log(`[Provider] RPC failed, retrying in ${delayMs / 1000}s... (${attempt}/${maxRetries})`);
        await new Promise(res => setTimeout(res, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Failed to create provider after several attempts.');
}

const waitForReceiptWithRetry = async (provider, txHash, maxRetries = 15, delayMs = 7000) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) return receipt;
      throw new Error("Receipt is null");
    } catch (e) {
      const code = e.code || (e.error && e.error.code);
      const msg = e.message || (e.error && e.error.message) || String(e);

      if (
        (code === "UNKNOWN_ERROR" && msg.includes("Unable to complete the request")) ||
        (code === -32008) ||
        msg.includes("Receipt is null")
      ) {
        console.log(`[Waiting Confirm tx] ${txHash}, waiting ${delayMs / 1000}s... (${i + 1}/${maxRetries})`);
        await new Promise(res => setTimeout(res, delayMs));
      } else {
        console.error(`[waitForReceiptWithRetry] Unexpected error:`, e);
        throw e;
      }
    }
  }
  const errMsg = `Max retries reached for getTransactionReceipt for tx ${txHash}`;
  console.error(`[waitForReceiptWithRetry] ${errMsg}`);
  throw new Error(errMsg);
};

// --- JWT Login (always do this first!) ---
async function getJwt(wallet, proxy = null) {
  try {
    const message = "pharos";
    const signature = await wallet.signMessage(message);
    const loginUrl = `https://api.pharosnetwork.xyz/user/login?address=${wallet.address}&signature=${signature}&invite_code=rfX8jGZPEp7MiFJ1`;
    const headers = {
      "User-Agent": randomUseragent.getRandom(),
      "Referer": "https://testnet.pharosnetwork.xyz/",
    };
    const axiosConfig = {
      method: 'post',
      url: loginUrl,
      headers,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    };
    const res = await axios(axiosConfig);
    if (res.data.code === 0 && res.data.data && res.data.data.jwt)
      return res.data.data.jwt;
    else
      console.log(`Failed to fetch JWT for wallet ${wallet.address}: ${res.data.msg || 'Unknown error'}`);
    return null;
  } catch (e) {
    if (e.response && e.response.data) {
      console.log(`JWT login error for wallet ${wallet.address}:`, e.response.data);
    } else {
      console.log(`JWT login error for wallet ${wallet.address}: ${e.message}`);
    }
    return null;
  }
}

const getUserInfo = async (wallet, proxy = null, jwt, label = "[UserInfo]") => {
  try {
    const profileUrl = `https://api.pharosnetwork.xyz/user/profile?address=${wallet.address}`;
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.8",
      authorization: `Bearer ${jwt}`,
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
      method: 'get',
      url: profileUrl,
      headers,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    };

    const response = await axios(axiosConfig);
    const data = response.data;

    if (data.code !== 0 || !data.data.user_info) {
      console.log(`${label} Failed to fetch user info: ${data.msg || 'Unknown error'}`);
      return null;
    }
    const userInfo = data.data.user_info;
    return userInfo;
  } catch (error) {
    console.log(`${label} Failed to fetch user info: ${error.message}`);
    return null;
  }
};

const verifyTask = async (wallet, proxy, jwt, txHash) => {
  let attempts = 0;
  let maxAttempts = 10;
  let delayMs = 10000;
  while (attempts < maxAttempts) {
    try {
      console.log(`[VerifyTask] Verifying task ID 103 for transaction: ${txHash}`);
      const verifyUrl = `https://api.pharosnetwork.xyz/task/verify?address=${wallet.address}&task_id=103&tx_hash=${txHash}`;
      const headers = {
        accept: "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.8",
        authorization: `Bearer ${jwt}`,
        priority: "u=1, i",
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
        url: verifyUrl,
        headers,
        httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
      };

      const response = await axios(axiosConfig);
      const data = response.data;
      if (data.code === 0 && data.data.verified) {
        console.log(`[VERIFY] TX ${txHash} verified successfully.`);
        return true;
      } else {
        console.log(`[VERIFY] TX ${txHash} verification failed: ${data.msg || 'Unknown error'}`);
        if (data.code !== 1) return false;
      }
    } catch (error) {
      console.log(`[VERIFY] TX ${txHash} verification error: ${error.message}`);
    }
    attempts++;
    if (attempts < maxAttempts) {
      console.log(`[VERIFY] Retrying verifyTask for TX ${txHash} in ${delayMs/1000}s... (${attempts}/${maxAttempts})`);
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
  console.log(`[VERIFY] TX ${txHash} verification ultimately failed after ${maxAttempts} attempts.`);
  return false;
};

async function ensureApproval(wallet, tokenAddress, spender, requiredAmount) {
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  const allowance = await token.allowance(wallet.address, spender);
  if (BigInt(allowance) < BigInt(requiredAmount)) {
    const nonce = await wallet.provider.getTransactionCount(wallet.address, "pending");
    const tx = await token.approve(spender, ethers.MaxUint256, { nonce });
    await waitForReceiptWithRetry(wallet.provider, tx.hash);
  }
}

async function addLp(wallet, token1, symbol, provider, walletIdx, totalWallets, lpIdx, totalLp) {
  const router = new ethers.Contract(ROUTER_ADDRESS, routerAbi, wallet);
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
    const nonce = await provider.getTransactionCount(wallet.address, 'pending');
    const tx = await router.multicall(multicallData, {
      value: value,
      gasLimit: 500_000,
      nonce
    });
    let receipt = null;
    try {
      receipt = await waitForReceiptWithRetry(provider, tx.hash);
      console.log(`[${walletIdx + 1}/${totalWallets}] [${lpIdx + 1}/${totalLp}] Add LP ${symbol} hash ${tx.hash}`);
    } catch (e) {
      console.error(`[${walletIdx + 1}/${totalWallets}] [${lpIdx + 1}/${totalLp}] Add LP ${symbol} error: Receipt is null for hash ${tx.hash}`);
    }
    return receipt || { hash: tx.hash };
  } catch (e) {
    console.error(`[${walletIdx + 1}/${totalWallets}] [${lpIdx + 1}/${totalLp}] Add LP ${symbol} error: ${e.message}`);
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

    const nonce = await provider.getTransactionCount(wallet.address, "pending");

    const tx = {
      to: contract.target,
      data: multicallData,
      value: amountWei,
      gasPrice: feeData.gasPrice,
      nonce,
      chainId: 688688
    };
    tx.gasLimit = (await provider.estimateGas(tx)) * 12n / 10n;

    const sentTx = await wallet.sendTransaction(tx);
    let receipt = null;
    try {
      receipt = await waitForReceiptWithRetry(provider, sentTx.hash);
      console.log(`[${walletIdx + 1}/${totalWallets}] [${swapIdx + 1}/${totalSwap}] Swap ${amount} PHRS → ${symbolOut} Completed: ${sentTx.hash}`);
    } catch (e) {
      console.error(`[${walletIdx + 1}/${totalWallets}] [${swapIdx + 1}/${totalSwap}] Swap error: Receipt is null for hash ${sentTx.hash}`);
    }
    return receipt || { hash: sentTx.hash };
  } catch (err) {
    console.error(`[${walletIdx + 1}/${totalWallets}] [${swapIdx + 1}/${totalSwap}] Swap error: ${err.message}`);
    return null;
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
      return null;
    }

    const nonce = await provider.getTransactionCount(wallet.address, "pending");
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: required,
      gasLimit: 21000,
      gasPrice: 0,
      nonce
    });

    let receipt = null;
    try {
      receipt = await waitForReceiptWithRetry(provider, tx.hash);
      const space = index === 1 ? ' ' : '';
      console.log(`[${walletIdx + 1}/${totalWallets}] [${index + 1}/${totalTransfer}${space}]Transfer completed: ${tx.hash}`);
    } catch (e) {
      console.error(`[${walletIdx + 1}/${totalWallets}] [${index + 1}/${totalTransfer}] Transfer error: Receipt is null for hash ${tx.hash}`);
    }
    return receipt || { hash: tx.hash };
  } catch (error) {
    console.error(`[${walletIdx + 1}/${totalWallets}] [${index + 1}/${totalTransfer}] Transfer error: ${error.message}`);
    return null;
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
      return null;
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
      return jwt;
    } else {
      console.log(`Check-in failed, possibly already checked in: [${walletIdx + 1}/${totalWallets}]${checkInData.msg || 'Unknown error'}`);
      return jwt;
    }
  } catch (error) {
    console.log(`Check-in failed for [${walletIdx + 1}/${totalWallets}]${wallet.address}: ${error.message}`);
    return null;
  }
};

const countdown = async () => {
  const totalSeconds = 6 * 60 * 60; // 24 hours
  console.log('Starting 6-hour countdown...');
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
  const TOTAL_TRANSFER = 5;
  const TOTAL_SWAP = 5;
  const TOTAL_LP = 5;

  while (true) {
    for (let walletIdx = 0; walletIdx < privateKeys.length; walletIdx++) {
      const privateKey = privateKeys[walletIdx];
      const proxy = proxies.length ? getRandomProxy(proxies) : null;

      // --- Robust Provider Creation ---
      let provider;
      while (true) {
        try {
          provider = await createProviderWithRetry(
            networkConfig.rpcUrl,
            {
              chainId: networkConfig.chainId,
              name: networkConfig.name,
            },
            proxy
          );
          break;
        } catch (err) {
          const code = err.code || (err.error && err.error.code);
          const msg = err.message || (err.error && err.error.message) || String(err);
          if (
            (code === "UNKNOWN_ERROR" && msg.includes("Unable to complete the request")) ||
            (code === -32008)
          ) {
            console.log("[Main] RPC unavailable, will retry provider in 60 seconds...");
            await new Promise(res => setTimeout(res, 60000));
            continue;
          }
          // Unknown, fatal error
          throw err;
        }
      }

      const wallet = new ethers.Wallet(privateKey, provider);

      console.log(`Using wallet: [${walletIdx + 1}/${totalWallets}]${wallet.address}`);

      // 1. Always login to get JWT first
      let jwt = await getJwt(wallet, proxy);
      if (!jwt) {
        console.log(`[${walletIdx + 1}/${totalWallets}] Failed to get JWT, skipping...`);
        continue;
      }

      // 2. Get user info with that JWT (before actions)
      const userInfoBefore = await getUserInfo(wallet, proxy, jwt);
      const beforeTaskPoints = userInfoBefore ? parseInt(userInfoBefore.TaskPoints) : 0;
      const beforeTotalPoints = userInfoBefore ? parseInt(userInfoBefore.TotalPoints) : 0;
      if (userInfoBefore) {
        console.log(`[UserInfo] User ID: ${userInfoBefore.ID} - Task Points: ${userInfoBefore.TaskPoints} - Total Points: ${userInfoBefore.TotalPoints}`);
      }

      // 3. Optionally: daily check-in (can skip if needed)
      await performCheckIn(wallet, proxy, walletIdx, totalWallets);

      // 4. Faucet (optional)
      await claimFaucet(wallet, proxy, walletIdx, totalWallets);

      // 5. Transfers (MANDATORY verifyTask)
      for (let i = 0; i < TOTAL_TRANSFER; i++) {
        const receipt = await transferPHRS(wallet, provider, i, TOTAL_TRANSFER, walletIdx, totalWallets);
        let hash = receipt && receipt.hash ? receipt.hash : null;
        if (!hash) {
          console.error(`[VERIFY] Transfer: No transaction hash, but will attempt to verify with null hash.`);
        }
        await verifyTask(wallet, proxy, jwt, hash || "0x");
        await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));
      }

      // 6. SWAPs (MANDATORY verifyTask)
      for (let i = 0; i < TOTAL_SWAP; i++) {
        const symbolOut = Math.random() < 0.5 ? "USDC" : "USDT";
        const amount = (Math.random() * 0.00005 + 0.00001).toFixed(6);
        const receipt = await performSwap(privateKey, wallet.address, provider, i, symbolOut, amount, TOTAL_SWAP, walletIdx, totalWallets);
        let hash = receipt && receipt.hash ? receipt.hash : null;
        if (!hash) {
          console.error(`[VERIFY] Swap: No transaction hash, but will attempt to verify with null hash.`);
        }
        await verifyTask(wallet, proxy, jwt, hash || "0x");
        await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));
      }

      // 7. LP ADDs (MANDATORY verifyTask)
      for (let i = 0; i < TOTAL_LP; i++) {
        const token1 = STABLE_COINS[Math.floor(Math.random() * STABLE_COINS.length)];
        const symbol = TOKEN_SYMBOLS[token1] || "UNKNOWN";
        const receipt = await addLp(wallet, token1, symbol, provider, walletIdx, totalWallets, i, TOTAL_LP);
        let hash = receipt && receipt.hash ? receipt.hash : null;
        if (!hash) {
          console.error(`[VERIFY] AddLP: No transaction hash, but will attempt to verify with null hash.`);
        }
        await verifyTask(wallet, proxy, jwt, hash || "0x");
        await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));
      }

      // --- GET USER INFO AGAIN TO CHECK POINT GAIN ---
      const userInfoAfter = await getUserInfo(wallet, proxy, jwt, "[UserInfo][After]");
      const afterTaskPoints = userInfoAfter ? parseInt(userInfoAfter.TaskPoints) : 0;
      const afterTotalPoints = userInfoAfter ? parseInt(userInfoAfter.TotalPoints) : 0;
      const taskGain = afterTaskPoints - beforeTaskPoints;
      if (userInfoAfter) {
        console.log(`[UserInfo][After] User ID: ${userInfoAfter.ID} - Task Points: ${userInfoAfter.TaskPoints} - Total Points: ${userInfoAfter.TotalPoints} [${taskGain >= 0 ? "+" : ""}${taskGain}]`);
      }
    }

    console.log('All actions completed for all wallets!');
    await countdown();
  }
};

main().catch(error => {
  console.log(`Bot failed: ${error.message}`);
});
