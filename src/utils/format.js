export const formatNumber = (num, decimals = 2) => {
  const number = parseFloat(num || 0);
  return number.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};
