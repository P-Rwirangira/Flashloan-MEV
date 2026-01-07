import { ethers } from 'ethers';

export async function aggregateTokenDeltasToUsd(
  provider: ethers.Provider,
  getTokenUsdPrice: (token: string) => Promise<number>,
  tokenDeltas: Map<string, bigint>
): Promise<number> {
  let totalUsd = 0;
  for (const [tok, amt] of tokenDeltas.entries()) {
    try {
      const tokAddr = tok as string;
      const price = await getTokenUsdPrice(tokAddr);
      const erc = new ethers.Contract(
        tokAddr,
        ['function decimals() view returns (uint8)'],
        provider
      );
      const dec = Number((await (erc as any)?.['decimals']?.()) ?? 18);
      const units = Number(amt) / Math.pow(10, dec);
      totalUsd += units * price;
    } catch {
      // ignore token on failure
    }
  }
  return totalUsd;
}

export function ethDeltaWeiToUsd(ethDeltaWei: bigint, ethUsd: number): number {
  return (Number(ethDeltaWei) / 1e18) * ethUsd;
}

export async function convertUsdToTokenUnits(
  provider: ethers.Provider,
  getTokenUsdPrice: (token: string) => Promise<number>,
  tokenAddress: string,
  totalUsd: number
): Promise<bigint> {
  try {
    const tokenOutUsd = await getTokenUsdPrice(tokenAddress);
    const ercOut = new ethers.Contract(
      tokenAddress,
      ['function decimals() view returns (uint8)'],
      provider
    );
    const decOut = Number((await (ercOut as any)?.['decimals']?.()) ?? 18);
    const units = Math.floor((totalUsd / Math.max(tokenOutUsd, 1e-9)) * Math.pow(10, decOut));
    return BigInt(units);
  } catch {
    return 0n;
  }
}
