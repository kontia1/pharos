import readline from 'readline';
import { randomBytes } from 'crypto';
import fs from 'fs';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('How many private keys do you want to generate? ', (answer) => {
  const count = parseInt(answer);

  if (isNaN(count) || count <= 0) {
    console.log('Please enter a valid number.');
    rl.close();
    return;
  }

  const keys = [];

  for (let i = 0; i < count; i++) {
    const privateKey = '0x' + randomBytes(32).toString('hex');
    keys.push(privateKey);
    console.log(`Private Key ${i + 1}:`, privateKey);
  }

  try {
    fs.appendFileSync('wallet.txt', keys.join('\n') + '\n');
    console.log(`✅ Appended ${count} private keys to wallet.txt`);
  } catch (err) {
    console.error('❌ Error writing to file:', err);
  }

  rl.close();
});
