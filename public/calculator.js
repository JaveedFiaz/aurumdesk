// Position sizing: lots so that hitting the stop loses exactly the chosen risk.
// One standard gold lot is 100 oz, so a $1 move is $100 per lot.

export function positionSize({ balance, risk, entry, stop, target, contract }) {
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

export function initCalculator(form, outEl, { getPrice, onPlan }) {
  const num = (n) => parseFloat(form.elements[n].value);
  const money = (v) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  function update() {
    const r = positionSize({
      balance: num('balance'),
      risk: num('risk'),
      entry: num('entry'),
      stop: num('stop'),
      target: num('target'),
      contract: num('contract'),
    });
    if (!r) {
      outEl.innerHTML = '<dt>Enter entry and stop</dt><dd></dd>';
      onPlan(null);
      return;
    }
    outEl.innerHTML = `
      <dt>Direction</dt><dd class="${r.side === 'Long' ? 'bull' : 'bear'}">${r.side}</dd>
      <dt>Lot size</dt><dd>${r.lots.toFixed(2)}</dd>
      <dt>Risk</dt><dd>${money(r.riskCash)}</dd>
      <dt>Stop distance</dt><dd>${r.stopDist.toFixed(2)}</dd>
      ${r.rr != null ? `<dt>Reward</dt><dd>${money(r.reward)}</dd><dt>R:R</dt><dd>1 : ${r.rr.toFixed(2)}</dd>` : ''}
      ${r.lots === 0 ? '<dt class="bear">Risk too small for 0.01 lot</dt><dd></dd>' : ''}`;
    onPlan({ entry: num('entry'), stop: num('stop'), target: r.rr != null ? num('target') : null });
  }

  form.addEventListener('input', update);
  form.querySelector('#usePrice').addEventListener('click', () => {
    const p = getPrice();
    if (p) form.elements.entry.value = p.toFixed(2);
    update();
  });
  update();
  return update;
}
