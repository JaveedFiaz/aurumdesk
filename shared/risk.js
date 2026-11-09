// Position sizing: lots so that hitting the stop loses exactly the chosen risk.
// One standard gold lot is 100 oz, so a $1 move is $100 per lot.

export function positionSize({ balance, risk, entry, stop, target, contract = 100 }) {
  if (!(balance > 0 && risk > 0 && entry > 0 && stop > 0 && contract > 0) || entry === stop) return null;
  const riskCash = (balance * risk) / 100;
  const stopDist = Math.abs(entry - stop);
  const lots = Math.floor((riskCash / (stopDist * contract)) * 100) / 100;
  const out = {
    side: stop < entry ? 'Long' : 'Short',
    lots,
    riskCash: lots * stopDist * contract,
    stopDist,
  };
  if (target > 0 && (stop < entry ? target > entry : target < entry)) {
    out.reward = lots * Math.abs(target - entry) * contract;
    out.rr = Math.abs(target - entry) / stopDist;
  }
  return out;
}
