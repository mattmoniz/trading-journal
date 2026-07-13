export const formatNumber = (num, decimals = 2) => {
  const number = parseFloat(num || 0);
  return number.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

export const fmtP = (n, d = 0) =>
  n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const fmtEtTime = (etMin) => {
  if (etMin == null) return null;
  const h24 = Math.floor(etMin / 60), m = etMin % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm} ET`;
};
